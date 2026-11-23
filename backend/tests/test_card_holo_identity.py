import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest

from schemas import CardBase


class CardHoloIdentityTests(unittest.TestCase):
    def test_collection_card_preserves_exact_printing_language(self):
        for language in ('en', 'de'):
            card = SimpleNamespace(id=f'swsh9-132_{language}', name='Test card',
                                   tcg_card_id='swsh9-132', lang=language)
            payload = CardBase.model_validate(card).model_dump()
            self.assertEqual(payload.get('lang'), language)
            self.assertEqual(payload['tcg_card_id'], 'swsh9-132')

    def test_detail_serialization_preserves_identity_used_by_browser_verification(self):
        # Exercise the actual serializer without importing API/database startup.
        source = Path(__file__).resolve().parents[1] / 'api/cards.py'
        function = next(node for node in ast.parse(source.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == '_card_to_dict')
        namespace: dict[str, Any] = {'Card': object}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        values: dict[str, Any] = {name: None for name in CardBase.model_fields}
        values.update(id='swsh9-132_de', name='Test card', tcg_card_id='swsh9-132',
                      lang='de', is_custom=False, is_digital=False)
        result = CardBase.model_validate(namespace['_card_to_dict'](SimpleNamespace(**values))).model_dump()
        self.assertEqual(result['tcg_card_id'], 'swsh9-132')
        self.assertEqual(result.get('lang'), 'de')

    def test_missing_language_is_not_assumed_english(self):
        payload = CardBase.model_validate({'id': 'unidentified', 'name': 'Test card'}).model_dump()
        self.assertIsNone(payload.get('lang'))


if __name__ == '__main__':
    unittest.main()
