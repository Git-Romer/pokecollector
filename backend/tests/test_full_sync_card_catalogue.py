import datetime
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from services.sync_service import _sets_for_card_catalogue_sync, _sync_set_card_catalogue

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class FullSyncCardCatalogueTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

    def tearDown(self):
        self.db.close()

    def _add_complete_set(self, set_id: str, *, updated_at: datetime.datetime | None = None):
        self.db.add_all([
            Set(
                id=f"{set_id}_en",
                tcg_set_id=set_id,
                name=set_id,
                total=1,
                lang="en",
                updated_at=updated_at or datetime.datetime(2026, 1, 1),
            ),
            Card(
                id=f"{set_id}-1_en",
                tcg_card_id=f"{set_id}-1",
                name="Old name",
                set_id=set_id,
                number="1",
                lang="en",
                images_small=None,
                images_large=None,
                custom_image_url="https://example.test/custom.webp",
                is_custom=False,
            ),
        ])
        self.db.commit()
        return self.db.query(Set).filter(Set.id == f"{set_id}_en").one()

    def test_complete_set_refreshes_from_cached_card_list(self):
        set_obj = self._add_complete_set("base1")
        cache = {
            ("base1", "en"): [
                {
                    "id": "base1-1",
                    "localId": "1",
                    "name": "Alakazam",
                    "image": "https://assets.example/base1/1",
                    "set": {"id": "base1"},
                }
            ]
        }

        with patch("services.sync_service.pokemon_api.get_set_cards") as get_set_cards:
            result = _sync_set_card_catalogue(
                self.db,
                [set_obj],
                card_list_cache=cache,
                complete_set_refresh_limit=1,
            )

        get_set_cards.assert_not_called()
        card = self.db.query(Card).filter(Card.id == "base1-1_en").one()
        self.assertEqual(result["complete_sets_refreshed"], 1)
        self.assertEqual(card.name, "Alakazam")
        self.assertEqual(card.images_small, "https://assets.example/base1/1/low.webp")
        self.assertEqual(card.images_large, "https://assets.example/base1/1/high.webp")
        self.assertIsNone(card.custom_image_url)

    def test_complete_set_refresh_limit_defers_remaining_complete_sets(self):
        oldest_timestamp = datetime.datetime(2026, 1, 1)
        newest_timestamp = datetime.datetime(2026, 1, 2)
        self._add_complete_set("base1", updated_at=oldest_timestamp)
        self._add_complete_set("base2", updated_at=newest_timestamp)
        cache = {
            ("base1", "en"): [
                {"id": "base1-1", "localId": "1", "name": "Alakazam", "set": {"id": "base1"}}
            ],
            ("base2", "en"): [
                {"id": "base2-1", "localId": "1", "name": "Pikachu", "set": {"id": "base2"}}
            ],
        }

        sets_to_sync = _sets_for_card_catalogue_sync(self.db)
        self.assertEqual([set_obj.id for set_obj in sets_to_sync], ["base1_en", "base2_en"])

        result = _sync_set_card_catalogue(
            self.db,
            sets_to_sync,
            card_list_cache=cache,
            complete_set_refresh_limit=1,
        )

        first_card = self.db.query(Card).filter(Card.id == "base1-1_en").one()
        second_card = self.db.query(Card).filter(Card.id == "base2-1_en").one()
        first_set = self.db.query(Set).filter(Set.id == "base1_en").one()
        second_set = self.db.query(Set).filter(Set.id == "base2_en").one()
        self.assertEqual(result["complete_sets_refreshed"], 1)
        self.assertEqual(result["complete_sets_skipped"], 1)
        self.assertEqual(first_card.name, "Alakazam")
        self.assertEqual(second_card.name, "Old name")
        self.assertGreater(first_set.updated_at, newest_timestamp)
        self.assertEqual(second_set.updated_at, newest_timestamp)


if __name__ == "__main__":
    unittest.main()
