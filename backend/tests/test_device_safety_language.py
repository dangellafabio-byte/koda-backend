import ast
import unittest
from pathlib import Path
from typing import Optional


class ItalianSafetyLanguageTests(unittest.TestCase):
    def test_full_sentence_exceptions_do_not_hide_other_disclosures(self):
        source = Path(__file__).resolve().parents[1] / 'server.py'
        tree = ast.parse(source.read_text())
        nodes = [node for node in tree.body if
                 (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                  and node.targets[0].id.startswith('_SAFETY_') and node.targets[0].id.endswith('_KW'))
                 or getattr(node, 'name', '') == '_detect_safety_category']
        scope = {'Optional':Optional}
        exec(compile(ast.Module(nodes, []), str(source), 'exec'), scope)
        check = scope['_detect_safety_category']
        for text in ['Mi taglio i capelli.', 'Oggi mi taglio i capelli!',
                     'Voglio buttarmi sul divano', 'Ho visto un bambino giocare al parco.',
                     'Sono stanco dopo il lavoro', 'Muoio di fame']:
            with self.subTest(text=text):
                self.assertIsNone(check(text))
        for text in ['Voglio morire', 'Oggi mi taglio i capelli. Non voglio più vivere.',
                     'Ho visto un bambino giocare al parco. Mio marito mi picchia.']:
            with self.subTest(text=text):
                self.assertIsNotNone(check(text))
