import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import CollectionItem
    from services.sync_service import (
        _metadata_enrichment_limit,
        _price_sync_limit,
    )

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class SyncLimitTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

    def tearDown(self):
        self.db.close()

    def _set_collection_quantity(self, quantity: int):
        self.db.query(CollectionItem).delete()
        self.db.add(CollectionItem(card_id="base1-1_en", quantity=quantity))
        self.db.commit()

    def test_price_sync_limit_has_larger_floor_for_mid_sized_collections(self):
        self._set_collection_quantity(850)

        self.assertEqual(_price_sync_limit(self.db), 1000)

    def test_price_sync_limit_scales_above_old_two_thousand_cap(self):
        self._set_collection_quantity(5000)

        self.assertEqual(_price_sync_limit(self.db), 3750)

    def test_price_sync_limit_caps_at_five_thousand(self):
        self._set_collection_quantity(10000)

        self.assertEqual(_price_sync_limit(self.db), 5000)

    def test_metadata_enrichment_keeps_separate_two_thousand_cap(self):
        self._set_collection_quantity(10000)

        self.assertEqual(_metadata_enrichment_limit(self.db), 2000)


if __name__ == "__main__":
    unittest.main()
