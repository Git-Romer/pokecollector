import datetime
import unittest
from types import SimpleNamespace

from services.product_ledger import product_effective_value

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.products import (
        get_products_summary,
        link_collection_item_to_product,
        sell_product_card,
    )
    from api.collection import update_collection_item
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, User
    from schemas import CollectionItemUpdate, ProductCardLinkCreate, ProductCardSaleCreate
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


class ProductLedgerTests(unittest.TestCase):
    def test_product_effective_value_uses_live_cards_plus_realized_gains(self):
        product = SimpleNamespace(purchase_price=50, current_value=None, sold_price=None)
        card = SimpleNamespace(price_trend=10, price_market=9)
        product_card = SimpleNamespace(
            initial_quantity=2,
            active_quantity=1,
            sold_quantity=1,
            variant="Normal",
            card=card,
            ledger_entries=[
                SimpleNamespace(entry_type="card_sale", amount=25),
            ],
        )

        value, source, totals = product_effective_value(product, [product_card])

        self.assertEqual(source, "linked_cards")
        self.assertEqual(totals.live_cards_value, 10)
        self.assertEqual(totals.realized_gains, 25)
        self.assertEqual(value, 35)

    def test_product_effective_value_keeps_zero_manual_current_value(self):
        product = SimpleNamespace(purchase_price=50, current_value=0, sold_price=None)

        value, source, totals = product_effective_value(product, [])

        self.assertEqual(source, "manual_current")
        self.assertEqual(value, 0)
        self.assertEqual(totals.dynamic_value, 0)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class ProductLedgerApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Sprigatito",
            set_id="sv1",
            number="1",
            lang="en",
            price_trend=10,
            price_market=9,
            variants_normal=True,
        )
        self.db.add_all([self.user, self.other_user, self.card])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def add_product(self, user=None, purchase_price=50, current_value=None):
        product = ProductPurchase(
            product_name="Collection Box",
            product_type="Collection Box",
            purchase_price=purchase_price,
            current_value=current_value,
            purchase_date=datetime.date(2026, 5, 30),
            user_id=(user or self.user).id,
        )
        self.db.add(product)
        self.db.commit()
        self.db.refresh(product)
        return product

    def add_collection_item(self, quantity=1, user=None):
        item = CollectionItem(
            card_id=self.card.id,
            user_id=(user or self.user).id,
            quantity=quantity,
            condition="NM",
            variant="Normal",
            lang="en",
            purchase_price=2,
            added_at=datetime.datetime.utcnow(),
        )
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        return item

    def test_product_without_links_keeps_zero_manual_current_value(self):
        self.add_product(current_value=0)

        summary = get_products_summary(current_user=self.user, db=self.db)

        self.assertEqual(summary["total_current_value"], 0)
        self.assertEqual(summary["total_pnl"], -50)

    def test_link_rejects_more_than_unlinked_owned_quantity(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=1)

        with self.assertRaises(HTTPException) as ctx:
            link_collection_item_to_product(
                product.id,
                ProductCardLinkCreate(collection_item_id=item.id, quantity=2),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)

    def test_link_rejects_another_users_collection_item(self):
        product = self.add_product()
        other_item = self.add_collection_item(quantity=1, user=self.other_user)

        with self.assertRaises(HTTPException) as ctx:
            link_collection_item_to_product(
                product.id,
                ProductCardLinkCreate(collection_item_id=other_item.id, quantity=1),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 404)

    def test_selling_one_linked_copy_reduces_collection_and_keeps_history(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=3)
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=2),
            current_user=self.user,
            db=self.db,
        )
        product_card = self.db.query(ProductCard).one()

        response = sell_product_card(
            product.id,
            product_card.id,
            ProductCardSaleCreate(quantity=1, sold_price=25, sold_date=datetime.date(2026, 5, 30)),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(item)
        self.db.refresh(product_card)
        ledger_entry = self.db.query(ProductLedgerEntry).one()
        self.assertEqual(item.quantity, 2)
        self.assertEqual(product_card.active_quantity, 1)
        self.assertEqual(product_card.sold_quantity, 1)
        self.assertEqual(ledger_entry.card_id, self.card.id)
        self.assertEqual(ledger_entry.original_collection_item_id, item.id)
        self.assertEqual(ledger_entry.amount, 25)
        self.assertEqual(ledger_entry.product_name, "Collection Box")
        self.assertEqual(ledger_entry.card_name, "Sprigatito")
        self.assertEqual(ledger_entry.set_id, "sv1")
        self.assertEqual(ledger_entry.card_number, "1")
        self.assertEqual(response.linked_live_value, 10)
        self.assertEqual(response.realized_gains, 25)
        self.assertEqual(response.computed_current_value, 35)

    def test_selling_blocks_if_collection_quantity_is_stale_or_missing(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=2)
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=2),
            current_user=self.user,
            db=self.db,
        )
        product_card = self.db.query(ProductCard).one()
        item.quantity = 1
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            sell_product_card(
                product.id,
                product_card.id,
                ProductCardSaleCreate(quantity=2, sold_price=25, sold_date=datetime.date(2026, 5, 30)),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 0)

    def test_collection_identity_changes_are_blocked_for_active_product_links(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=2)
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
            current_user=self.user,
            db=self.db,
        )

        with self.assertRaises(HTTPException) as ctx:
            update_collection_item(
                item.id,
                CollectionItemUpdate(condition="LP"),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)
        self.db.refresh(item)
        self.assertEqual(item.condition, "NM")

    def test_selling_final_collection_copy_removes_active_row_but_keeps_ledger_and_cleans_binder_ref(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=1)
        binder = Binder(name="Favorites", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.refresh(binder)
        self.db.add(BinderCard(binder_id=binder.id, card_id=self.card.id, collection_item_id=item.id))
        self.db.commit()
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
            current_user=self.user,
            db=self.db,
        )
        product_card = self.db.query(ProductCard).one()

        sell_product_card(
            product.id,
            product_card.id,
            ProductCardSaleCreate(quantity=1, sold_price=0, sold_date=datetime.date(2026, 5, 30)),
            current_user=self.user,
            db=self.db,
        )

        self.assertIsNone(self.db.query(CollectionItem).filter(CollectionItem.id == item.id).first())
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.collection_item_id == item.id).count(), 0)
        self.assertEqual(self.db.query(ProductLedgerEntry).filter(ProductLedgerEntry.card_id == self.card.id).count(), 1)
        product_card = self.db.query(ProductCard).one()
        self.assertEqual(product_card.active_quantity, 0)
        self.assertEqual(product_card.sold_quantity, 1)


if __name__ == "__main__":
    unittest.main()
