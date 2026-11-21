import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import Card, CollectionCardPhoto, CollectionItem, Setting, User
from services.analytics import aggregate_species_duplicates
from services.pokedex import species_directory


class SpeciesDuplicatesTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="brock", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Setting(key="tcgdex_digital_sets_enabled", value="true"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _card(self, card_id, name, dex_ids, *, price_market=None, price_trend=None, **kwargs):
        card = Card(
            id=card_id, tcg_card_id=card_id.rsplit("_", 1)[0], name=name,
            lang="en", is_custom=False, dex_ids=dex_ids,
            price_market=price_market, price_trend=price_trend,
            **kwargs,
        )
        self.db.add(card)
        return card

    def _item(self, card, quantity, variant="Normal"):
        item = CollectionItem(
            card_id=card.id, user_id=self.user.id, quantity=quantity,
            lang="en", variant=variant,
        )
        self.db.add(item)
        return item

    def _species(self, result, dex_id):
        return next(row for row in result["species"] if row["dex_id"] == dex_id)

    def test_two_printings_of_one_species_are_grouped(self):
        first = self._card("base-25_en", "Pikachu", [25], price_market=2.0)
        second = self._card("sv01-44_en", "Pikachu", [25], price_market=5.0)
        self._item(first, 1)
        self._item(second, 2)
        self.db.commit()

        result = aggregate_species_duplicates(self.db, self.user.id)

        self.assertEqual(len(result["species"]), 1)
        species = self._species(result, 25)
        self.assertEqual(species["printing_count"], 2)
        self.assertEqual(species["copies"], 3)
        self.assertEqual(species["total_value"], 12.0)
        self.assertEqual({row["card_id"] for row in species["printings"]}, {first.id, second.id})
        self.assertEqual(result["summary"]["species_with_duplicates"], 1)
        self.assertEqual(result["summary"]["copies"], 3)
        self.assertEqual(result["summary"]["total_value"], 12.0)

    def test_several_rows_of_the_same_card_are_one_printing(self):
        card = self._card("base-25_en", "Pikachu", [25], price_market=3.0)
        self._item(card, 1)
        self._item(card, 2, variant="Reverse Holo")
        self.db.commit()

        result = aggregate_species_duplicates(self.db, self.user.id)

        self.assertEqual(result["species"], [])
        self.assertEqual(result["summary"], {
            "species_with_duplicates": 0, "printings": 0, "copies": 0, "total_value": 0.0,
        })

    def test_card_with_several_dex_ids_counts_under_each_species(self):
        first = self._card("multi-1_en", "Friends", [25, 133], price_market=1.0)
        second = self._card("multi-2_en", "Friends in Sinnoh", [25, 133], price_market=2.0)
        self._item(first, 1)
        self._item(second, 1)
        self.db.commit()

        result = aggregate_species_duplicates(self.db, self.user.id)

        self.assertEqual({row["dex_id"] for row in result["species"]}, {25, 133})
        for dex_id in (25, 133):
            self.assertEqual(self._species(result, dex_id)["printing_count"], 2)
        # Both printings are distinct cards, even though they credit two species.
        self.assertEqual(result["summary"]["printings"], 2)
        self.assertEqual(result["summary"]["copies"], 2)

    def test_trainer_card_without_dex_ids_is_excluded(self):
        trainer = self._card("base-100_en", "Professor Oak", None, supertype="Trainer", price_market=9.0)
        self._item(trainer, 4)
        self._card("base-25_en", "Pikachu", [25], price_market=2.0)
        self._card("sv01-44_en", "Pikachu", [25], price_market=3.0)
        self.db.commit()
        for card_id in ("base-25_en", "sv01-44_en"):
            self._item(self.db.get(Card, card_id), 1)
        self.db.commit()

        result = aggregate_species_duplicates(self.db, self.user.id)

        self.assertEqual([row["dex_id"] for row in result["species"]], [25])
        self.assertEqual(result["summary"]["copies"], 2)

    def test_species_directory_covers_the_national_dex(self):
        directory = species_directory()

        self.assertEqual(len(directory), 1025)
        pikachu = next(row for row in directory if row["dex_id"] == 25)
        self.assertEqual(pikachu, {
            "dex_id": 25, "name_en": "Pikachu", "name_de": "Pikachu",
            "slug": "pikachu", "generation": 1, "region": "Kanto",
            "types": ["electric"],
        })

    def test_printing_values_use_the_selected_price_field_and_round_money(self):
        first = self._card("base-25_en", "Pikachu", [25], price_market=1.2345)
        second = self._card("sv01-44_en", "Pikachu", [25], price_market=4.0)
        self._item(first, 3)
        self._item(second, 2, variant="Reverse Holo")
        self.db.add(CollectionCardPhoto(user_id=self.user.id, card_id=first.id, data=b"jpeg"))
        self.db.commit()

        result = aggregate_species_duplicates(self.db, self.user.id, price_field="price_market")

        species = self._species(result, 25)
        # 1.2345 * 3 = 3.7035, rounded once for display.
        first_row = next(row for row in species["printings"] if row["card_id"] == first.id)
        self.assertEqual(first_row["total_value"], 3.7)
        self.assertEqual(first_row["price"], 1.23)
        self.assertTrue(first_row["has_scan_photo"])
        second_row = next(row for row in species["printings"] if row["card_id"] == second.id)
        self.assertFalse(second_row["has_scan_photo"])
        self.assertEqual(species["copies"], 5)
        self.assertEqual(species["total_value"], 11.7)
        # Printings sort by value, so the more valuable one leads.
        self.assertEqual(species["printings"][0]["card_id"], second.id)

        trend = aggregate_species_duplicates(self.db, self.user.id, price_field="price_trend")
        trend_species = self._species(trend, 25)
        # Neither card has a price_trend, so effective_market_price falls back to market.
        self.assertEqual(trend_species["total_value"], 11.7)


if __name__ == "__main__":
    unittest.main()
