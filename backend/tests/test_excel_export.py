import unittest
from io import BytesIO
from types import SimpleNamespace

from openpyxl import load_workbook

from api.export import build_collection_workbook


class ExcelExportTests(unittest.TestCase):
    def test_workbook_contains_required_collection_sheets(self):
        card = SimpleNamespace(
            id="sv1-1_en", name="Test Card", number="1", rarity="Rare",
            set_ref=SimpleNamespace(name="Test Set"),
        )
        item = SimpleNamespace(
            card=card, quantity=1, condition="NM", variant="Normal", lang="en",
            purchase_price=4.49, acquisition_source="pulled", storage_type="Penny Sleeve",
            storage_detail="Binder 1", grader=None, grade=None, certification_number=None,
            notes="First pull", added_at=None,
        )
        product = SimpleNamespace(
            product_name="Elite Trainer Box", product_type="Elite Trainer Box", purchase_price=0,
            purchase_date=None, storage_type="Sealed", storage_detail="Shelf A", notes=None,
        )

        workbook = load_workbook(BytesIO(build_collection_workbook([item], [product])))

        self.assertEqual(workbook.sheetnames, ["Cards", "Sealed Product", "Acquisition & Storage"])
        self.assertEqual(workbook["Cards"]["A1"].value, "Card ID")
        self.assertEqual(workbook["Sealed Product"]["A2"].value, "Elite Trainer Box")

