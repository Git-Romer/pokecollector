import unittest
import datetime

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.auth import get_current_user
    from api.collection import router as collection_router
    from database import Base, get_db, harden_collection_variant_constraints
    from models import (
        Card,
        CollectionItem,
        PrintingDetailTag,
        ProductCard,
        ProductLedgerEntry,
        ProductPurchase,
        Set,
        Trade,
        TradeItem,
        User,
    )
    from services.printing_details import (
        normalize_printing_detail_name,
        normalize_printing_details,
        parse_printing_details_csv,
        printing_detail_normalized_key,
    )
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


class PrintingDetailNormalizationTests(unittest.TestCase):
    def test_equivalent_spelling_has_one_stable_key(self):
        keys = {
            normalize_printing_detail_name(value)
            for value in ("Poké Ball", "POKE-BALL", "Poke_Ball", "  Poke   Ball  ")
        }
        self.assertEqual(keys, {"poke ball"})

    def test_duplicate_details_are_collapsed_and_order_is_preserved(self):
        self.assertEqual(
            normalize_printing_details(["Cosmos Holo", "cosmos-holo", "Play! Pokémon"]),
            [("Cosmos Holo", "cosmos holo"), ("Play! Pokémon", "play pokemon")],
        )

    def test_punctuation_only_detail_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "letter or number"):
            normalize_printing_detail_name("---___!!!")

    def test_csv_separator_is_reserved_and_tag_limit_is_enforced(self):
        with self.assertRaisesRegex(ValueError, "cannot contain"):
            normalize_printing_detail_name("Cosmos|Holo")
        with self.assertRaisesRegex(ValueError, "at most 10"):
            normalize_printing_details([f"Tag {index}" for index in range(11)])
        self.assertEqual(
            parse_printing_details_csv("Cosmos Holo|Play! Pokémon"),
            ["Cosmos Holo", "Play! Pokémon"],
        )

    def test_unicode_normalization_uses_a_fixed_size_database_key(self):
        normalized = normalize_printing_detail_name("ﷺ" * 80)
        self.assertGreater(len(normalized), 255)
        self.assertEqual(len(printing_detail_normalized_key(normalized)), 64)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "SQLAlchemy is not installed")
class CollectionVariantHardeningTests(unittest.TestCase):
    @staticmethod
    def _legacy_sqlite_engine():
        legacy_engine = create_engine("sqlite:///:memory:")
        with legacy_engine.begin() as conn:
            for table_name in (
                "collection",
                "product_cards",
                "product_ledger_entries",
                "trade_items",
            ):
                conn.execute(text(
                    f"CREATE TABLE {table_name} (id INTEGER PRIMARY KEY, variant VARCHAR)"
                ))
        return legacy_engine

    def test_existing_sqlite_database_rejects_ambiguous_variants(self):
        legacy_engine = self._legacy_sqlite_engine()
        with legacy_engine.begin() as conn:
            conn.execute(text("INSERT INTO collection (variant) VALUES ('Alt Art')"))

        with self.assertRaisesRegex(RuntimeError, "collection#1='Alt Art'"):
            harden_collection_variant_constraints(legacy_engine)
        legacy_engine.dispose()

    def test_existing_sqlite_database_gets_strict_write_guards(self):
        legacy_engine = self._legacy_sqlite_engine()
        harden_collection_variant_constraints(legacy_engine)

        with self.assertRaises(IntegrityError):
            with legacy_engine.begin() as conn:
                conn.execute(text("INSERT INTO collection (variant) VALUES (NULL)"))
        with self.assertRaises(IntegrityError):
            with legacy_engine.begin() as conn:
                conn.execute(text("INSERT INTO trade_items (variant) VALUES ('Cosmos Holo')"))
        with legacy_engine.begin() as conn:
            conn.execute(text("INSERT INTO collection (variant) VALUES ('Holo')"))
            conn.execute(text("INSERT INTO trade_items (variant) VALUES (NULL)"))
        legacy_engine.dispose()


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed")
class PrintingDetailTagApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.owner = User(username="tag-owner", hashed_password="x")
        self.other = User(username="tag-other", hashed_password="x")
        self.db.add_all([self.owner, self.other])
        self.db.flush()
        self.db.add(Set(id="sv1_en", tcg_set_id="sv1", name="Set", lang="en"))
        self.db.add(Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Card", set_id="sv1_en", number="1", lang="en"))
        self.db.commit()
        self.current_user = self.owner

        app = FastAPI()
        app.include_router(collection_router, prefix="/api/collection")
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def _add(self, details, variant="Holo"):
        return self.client.post("/api/collection/", json={
            "card_id": "sv1-1_en",
            "quantity": 1,
            "condition": "NM",
            "variant": variant,
            "printing_details": details,
            "lang": "en",
        })

    def test_tags_are_reused_and_are_part_of_exact_collection_identity(self):
        first = self._add(["Poké Ball", "Cosmos Holo"])
        self.assertEqual(first.status_code, 200, first.text)
        second = self._add(["cosmos holo", "Poke-Ball"])
        self.assertEqual(second.status_code, 200, second.text)

        rows = self.db.query(CollectionItem).filter(CollectionItem.user_id == self.owner.id).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].quantity, 2)
        self.assertEqual(self.db.query(PrintingDetailTag).filter(PrintingDetailTag.user_id == self.owner.id).count(), 2)

        third = self._add(["Master Ball"])
        self.assertEqual(third.status_code, 200, third.text)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.user_id == self.owner.id).count(), 2)

    def test_tags_are_user_scoped(self):
        self.assertEqual(self._add(["Cosmos Holo"]).status_code, 200)
        self.current_user = self.other
        self.assertEqual(self._add(["Cosmos Holo"]).status_code, 200)
        tags = self.db.query(PrintingDetailTag).filter(PrintingDetailTag.normalized_name == "cosmos holo").all()
        self.assertEqual({tag.user_id for tag in tags}, {self.owner.id, self.other.id})

    def test_rename_updates_every_use_and_delete_requires_confirmation(self):
        self.assertEqual(self._add(["Cosmos Holo"]).status_code, 200)
        tag = self.db.query(PrintingDetailTag).filter_by(user_id=self.owner.id).one()
        collection_item = self.db.query(CollectionItem).filter_by(user_id=self.owner.id).one()
        product = ProductPurchase(
            product_name="Test Box",
            user_id=self.owner.id,
            product_type="Booster Box",
            purchase_price=100,
            purchase_date=datetime.date(2026, 1, 1),
        )
        trade = Trade(
            user_id=self.owner.id,
            trade_date=datetime.date(2026, 1, 2),
        )
        self.db.add_all([product, trade])
        self.db.flush()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.owner.id,
            card_id=collection_item.card_id,
            collection_item_id=collection_item.id,
            variant="Holo",
        )
        trade_item = TradeItem(
            trade_id=trade.id,
            user_id=self.owner.id,
            direction="outgoing",
            card_id=collection_item.card_id,
            quantity=1,
            variant="Holo",
        )
        product_card.printing_detail_tags = [tag]
        trade_item.printing_detail_tags = [tag]
        self.db.add_all([product_card, trade_item])
        self.db.flush()
        ledger_entry = ProductLedgerEntry(
            product_card_id=product_card.id,
            product_id=product.id,
            user_id=self.owner.id,
            entry_type="trade_out",
            card_id=collection_item.card_id,
            trade_item_id=trade_item.id,
            quantity=1,
            amount=10,
            event_date=datetime.date(2026, 1, 2),
            variant="Holo",
        )
        ledger_entry.printing_detail_tags = [tag]
        self.db.add(ledger_entry)
        self.db.commit()

        renamed = self.client.put(
            f"/api/collection/printing-detail-tags/{tag.id}",
            json={"name": "Galaxy Holo"},
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["name"], "Galaxy Holo")
        self.assertEqual(renamed.json()["usage_count"], 4)
        self.assertEqual(
            self.client.get("/api/collection/").json()[0]["printing_details"][0]["name"],
            "Galaxy Holo",
        )
        self.assertEqual(product_card.printing_details, ["Galaxy Holo"])
        self.assertEqual(ledger_entry.printing_details, ["Galaxy Holo"])
        self.assertEqual(trade_item.printing_details, ["Galaxy Holo"])

        blocked = self.client.delete(f"/api/collection/printing-detail-tags/{tag.id}")
        self.assertEqual(blocked.status_code, 409)
        deleted = self.client.delete(
            f"/api/collection/printing-detail-tags/{tag.id}",
            params={"confirm": True},
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["detached_from"], 4)
        self.assertEqual(self.client.get("/api/collection/").json()[0]["printing_details"], [])
        self.db.expire_all()
        self.assertEqual(self.db.get(ProductCard, product_card.id).printing_details, [])
        self.assertEqual(self.db.get(ProductLedgerEntry, ledger_entry.id).printing_details, [])
        self.assertEqual(self.db.get(TradeItem, trade_item.id).printing_details, [])

    def test_only_canonical_variants_are_accepted_by_api_and_database(self):
        rejected = self._add(["Cosmos Holo"], variant="Poké Ball Holo")
        self.assertEqual(rejected.status_code, 422)

        self.db.add(CollectionItem(
            card_id="sv1-1_en",
            user_id=self.owner.id,
            quantity=1,
            condition="NM",
            variant="Poké Ball Holo",
            lang="en",
        ))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()

        self.assertEqual(self._add([]).status_code, 200)
        item = self.db.query(CollectionItem).filter(CollectionItem.user_id == self.owner.id).one()
        null_update = self.client.put(f"/api/collection/{item.id}", json={"variant": None})
        self.assertEqual(null_update.status_code, 422)

    def test_forbidden_separator_is_reported_as_validation_error(self):
        response = self._add(["Cosmos|Holo"])
        self.assertEqual(response.status_code, 422)
        self.assertIn("cannot contain", response.json()["detail"])

    def test_punctuation_only_tag_is_reported_as_validation_error(self):
        response = self.client.post(
            "/api/collection/printing-detail-tags",
            json={"name": "---___!!!"},
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("letter or number", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
