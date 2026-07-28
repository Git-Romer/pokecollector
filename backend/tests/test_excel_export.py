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
            id=7, record_uid="card-record-7", inventory_kind="owned", status="owned",
            card=card, quantity=1, condition="NM", variant="Normal", lang="en",
            purchase_price=4.49, acquisition_source="pulled", storage_type="Penny Sleeve",
            storage_detail="Binder 1", grader=None, grade=None, certification_number=None,
            protection_type="penny_sleeve",
            storage_location=SimpleNamespace(record_uid="location-1", name="Binder 1"),
            notes="First pull", added_at=None, updated_at=None,
        )
        product = SimpleNamespace(
            id=3, record_uid="product-record-3", quantity=1, sealed_condition="factory_sealed",
            status="active", removal_reason=None,
            product_name="Elite Trainer Box", product_type="Elite Trainer Box",
            acquisition_source="purchased", purchase_price=0,
            purchase_date=None, storage_type="Sealed", storage_detail="Shelf A",
            storage_location=SimpleNamespace(record_uid="location-2", name="Shelf A"),
            notes=None, updated_at=None,
        )
        locations = [
            SimpleNamespace(
                record_uid="location-1",
                name="Binder 1",
                description="Main binder",
                is_default=False,
                is_active=True,
                created_at=None,
                updated_at=None,
            ),
            SimpleNamespace(
                record_uid="location-2",
                name="Shelf A",
                description="Sealed shelf",
                is_default=False,
                is_active=True,
                created_at=None,
                updated_at=None,
            ),
        ]

        workbook = load_workbook(BytesIO(build_collection_workbook([item], [product], locations)))

        self.assertEqual(
            workbook.sheetnames,
            ["Owned Cards", "Bulk", "Sealed Products", "Storage Locations", "Import Errors"],
        )
        self.assertEqual(workbook["Owned Cards"]["A1"].value, "Record UID")
        self.assertEqual(workbook["Owned Cards"]["A2"].value, "card-record-7")
        self.assertEqual(workbook["Sealed Products"]["A2"].value, "product-record-3")
        self.assertEqual(workbook["Storage Locations"]["A2"].value, "location-1")
        self.assertEqual(workbook["Import Errors"]["A1"].value, "Sheet")
