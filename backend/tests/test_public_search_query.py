import ast
import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import AsyncMock

from fastapi import HTTPException

from local_memory_privacy import is_private_turn, private_turn
from public_search_query import has_explicit_search_intent, is_public_search_query, public_search_query


class PublicSearchTests(unittest.IsolatedAsyncioTestCase):
    def test_only_fixed_vocabulary_is_forwarded(self):
        accepted = {
            "Cerca online meteo a Milano?": "meteo oggi a Milano",
            "Piove?": "meteo oggi in Italia",
            "Notizie in Italia": "notizie di oggi in Italia",
            "Cercami il mio indirizzo": None,
            "Meteo a Milano, abito in via Roma 37": None,
            "notizie di oggi sul mio amico": None,
            "Meteo a un paese fuori elenco": None,
            "Che ne pensi dell'ultima cosa che ti ho detto?": None,
        }
        for raw, expected in accepted.items():
            self.assertEqual(public_search_query(raw), expected, raw)
            if expected:
                self.assertTrue(is_public_search_query(expected))
        self.assertEqual(public_search_query("Meteo?", authorized_city="roma"), "meteo oggi a Roma")
        self.assertEqual(public_search_query("Meteo?", authorized_city="Roma, via Roma 37"), "meteo oggi in Italia")
        self.assertFalse(is_public_search_query("Meteo a Roma?"))

    def setUp(self):
        tree = ast.parse((Path(__file__).parents[1] / "server.py").read_text())
        names = {"api_search", "_conversation_web_context", "_tavily_search_brief"}
        functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
        for fn in functions:
            fn.decorator_list = []
        self.client = AsyncMock()
        self.client.search.return_value = {"answer": "risposta sintetica", "results": []}
        self.settings = SimpleNamespace(web_search_enabled=True, geolocation_enabled=True)
        self.scope = dict(
            globals(), SearchRequest=object, _tavily_client=self.client,
            get_or_create_profile=AsyncMock(return_value=SimpleNamespace(settings=self.settings)),
            _tavily_cache_get=lambda _: None, _tavily_cache_set=lambda *_: None,
            logger=SimpleNamespace(info=lambda *a: None, warning=lambda *a: None),
        )
        exec(compile(ast.Module(body=functions, type_ignores=[]), "server.py", "exec"), self.scope)

    async def test_conversation_and_sink_keep_dialogue_separate(self):
        web_context = self.scope["_conversation_web_context"]
        self.assertEqual(await web_context("Ho litigato, è stata l'ultima goccia.", self.settings), (None, ""))
        brief, notice = await web_context("Meteo a Milano, abito in via Roma 37", self.settings)
        self.assertIsNone(brief)
        self.assertIn("Non è stata eseguita", notice)
        self.assertIsNone(await self.scope["_tavily_search_brief"]("raw private content"))
        with private_turn():
            self.assertEqual(await web_context("Meteo?", self.settings, location_city="Milano"), (None, ""))
        self.settings.web_search_enabled = False
        await web_context("Meteo?", self.settings, location_city="Milano")
        self.client.search.assert_not_awaited()

        self.settings.web_search_enabled = True
        brief, _ = await web_context("Meteo?", self.settings, location_city="Milano")
        self.assertIn("risposta sintetica", brief)
        self.assertEqual(self.client.search.await_args.kwargs["query"], "meteo oggi a Milano")
        self.settings.geolocation_enabled = False
        await web_context("Meteo?", self.settings, location_city="Milano")
        self.assertEqual(self.client.search.await_args.kwargs["query"], "meteo oggi in Italia")

    async def test_explicit_endpoint_rejects_raw_text(self):
        api = self.scope["api_search"]
        with self.assertRaises(HTTPException) as error:
            await api(SimpleNamespace(query="cerca mio@example.com", max_results=4))
        self.assertEqual(error.exception.status_code, 422)
        self.client.search.assert_not_awaited()
        result = await api(SimpleNamespace(query="Prezzo del Bitcoin?", max_results=4))
        self.assertEqual(result["query"], "quotazione Bitcoin oggi")
        self.assertEqual(self.client.search.await_args.kwargs["query"], result["query"])
