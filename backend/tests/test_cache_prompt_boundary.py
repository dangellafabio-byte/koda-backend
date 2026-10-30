"""Offline regression: changing turn context must not change cached instructions."""
import ast
from datetime import datetime, timezone
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import List, Optional
import unittest


class TestCacheBoundary(unittest.TestCase):
    def setUp(self):
        tree = ast.parse((Path(__file__).parents[1] / 'server.py').read_text())
        names = {'_build_fast_system_prompt', '_build_cacheable_messages',
                 '_build_relational_rules_block'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.env = dict(Profile=object, TimelineEntry=object, List=List, Optional=Optional,
                        datetime=datetime, timezone=timezone, _ITALY_TZ=None,
                        _infer_user_gender=lambda p: 'm',
                        _format_memories_for_prompt=lambda m: '|'.join(m),
                        _build_temporal_context=lambda recent: '|'.join(recent),
                        TRIAL_CLOSING_PROMPT_BLOCK='TRIAL_CLOSING_TEST',
                        _CACHE_CONTEXT_BOUNDARY='\n<<<OLLENYA_DYNAMIC_CONTEXT>>>\n',
                        logger=logging.getLogger(__name__))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server_functions', 'exec'), self.env)

    def messages(self, memory, recent, trial='active', extra=''):
        profile = SimpleNamespace(language='it', ai_name='Ollenya', ai_gender='f',
                                  name='Fabio', home_city='Pavia', memory_summary=memory,
                                  core_traits='traits:' + memory)
        text = self.env['_build_fast_system_prompt'](
            profile, recent, memories=['semantic:' + memory], trial_state=trial)
        return self.env['_build_cacheable_messages'](text + extra, 'question:' + memory, 'session')

    def test_memory_recent_trial_and_runtime_context_are_outside_cache(self):
        a = self.messages('MEMORY_ONE', ['RECENT_ONE'])
        b = self.messages('MEMORY_TWO', ['RECENT_TWO'], 'closing',
                          '\nKEY_FACT_TWO\nSTT_TWO\nGPS_TWO\nSAFETY_TWO\nWEB_TWO')
        self.assertEqual(a[0]['content'][0], b[0]['content'][0])
        variable = b[0]['content'][1]
        self.assertNotIn('cache_control', variable)
        for value in ['MEMORY_TWO', 'RECENT_TWO', 'semantic:MEMORY_TWO',
                      'TRIAL_CLOSING_TEST', 'KEY_FACT_TWO', 'STT_TWO', 'GPS_TWO',
                      'SAFETY_TWO', 'WEB_TWO']:
            self.assertIn(value, variable['text'])
            self.assertNotIn(value, b[0]['content'][0]['text'])
        self.assertEqual(b[1]['content'], 'question:MEMORY_TWO')

    def test_clock_change_leaves_cached_block_identical(self):
        class Clock:
            value = datetime(2026, 10, 29, 12, 1, tzinfo=timezone.utc)
            @classmethod
            def now(cls, tz):
                return cls.value
        self.env['datetime'] = Clock
        a = self.messages('same', [])
        Clock.value = datetime(2026, 10, 29, 12, 2, tzinfo=timezone.utc)
        b = self.messages('same', [])
        self.assertEqual(a[0]['content'][0], b[0]['content'][0])
        self.assertNotEqual(a[0]['content'][1], b[0]['content'][1])

    def test_unknown_layout_preserves_text_without_guessing_cache(self):
        msgs = self.env['_build_cacheable_messages']('unknown layout', 'question', 'sid')
        self.assertEqual(msgs, [{'role': 'system', 'content': 'unknown layout'},
                                {'role': 'user', 'content': 'question'}])


if __name__ == '__main__':
    unittest.main()
