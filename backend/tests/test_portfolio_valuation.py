import datetime
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.analytics import _take_portfolio_snapshot
from api.dashboard import get_dashboard
from database import Base
from models import (
    Card,
    CollectionItem,
    PortfolioSnapshot,
    ProductCard,
    ProductLedgerEntry,
    ProductPurchase,
    User,
)
from services.portfolio_valuation import (
    PORTFOLIO_CALCULATION_VERSION,
    calculate_portfolio_valuation,
    portfolio_snapshot_payload,
)
from services.sync_service import take_portfolio_snapshot


class PortfolioValuationTests(unittest.TestCase):
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
            variants_normal=True,
        )
        self.db.add_all([self.user, self.other_user, self.card])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def add_item(self, *, quantity=1, purchase_price=3, user=None):
        item = CollectionItem(
            card_id=self.card.id,
            user_id=(user or self.user).id,
            quantity=quantity,
            condition="NM",
            variant="Normal",
            lang="en",
            purchase_price=purchase_price,
        )
        self.db.add(item)
        self.db.commit()
        self.db.refresh(item)
        item.card = self.card
        return item

    def add_product(
        self,
        *,
        purchase_price=50,
        current_value=None,
        sold_price=None,
        lifecycle_status="sealed",
        user=None,
    ):
        product = ProductPurchase(
            product_name="Elite Trainer Box",
            product_type="Elite Trainer Box",
            purchase_price=purchase_price,
            current_value=current_value,
            sold_price=sold_price,
            purchase_date=datetime.date(2026, 8, 8),
            sold_date=datetime.date(2026, 8, 8) if sold_price is not None else None,
            lifecycle_status="sold" if sold_price is not None else lifecycle_status,
            user_id=(user or self.user).id,
        )
        self.db.add(product)
        self.db.commit()
        self.db.refresh(product)
        return product

    def valuation(self, items=None):
        return calculate_portfolio_valuation(
            self.db,
            self.user.id,
            "price_trend",
            collection_items=[] if items is None else items,
        )

    def test_active_sealed_product_adds_current_value_and_cost_once(self):
        self.add_product(purchase_price=2292, current_value=2430)

        result = self.valuation()

        self.assertEqual(result.card_value, 0)
        self.assertEqual(result.product_value, 2430)
        self.assertEqual(result.total_value, 2430)
        self.assertEqual(result.active_cost_basis, 2292)
        self.assertEqual(result.unrealized_pnl, 138)
        self.assertEqual(result.realized_pnl, 0)
        self.assertEqual(result.total_pnl, 138)
        self.assertEqual(result.product_value_fallback_count, 0)

    def test_missing_product_value_uses_purchase_cost_as_neutral_fallback(self):
        self.add_product(purchase_price=75, current_value=None)

        result = self.valuation()

        self.assertEqual(result.product_value, 75)
        self.assertEqual(result.active_cost_basis, 75)
        self.assertEqual(result.total_pnl, 0)
        self.assertEqual(result.product_value_fallback_count, 1)

    def test_explicit_zero_product_value_is_not_treated_as_missing(self):
        self.add_product(purchase_price=50, current_value=0)

        result = self.valuation()

        self.assertEqual(result.product_value, 0)
        self.assertEqual(result.active_cost_basis, 50)
        self.assertEqual(result.unrealized_pnl, -50)
        self.assertEqual(result.total_pnl, -50)
        self.assertEqual(result.product_value_fallback_count, 0)

    def test_unlinked_opened_product_does_not_duplicate_collection_value(self):
        item = self.add_item(quantity=30, purchase_price=0)
        self.add_product(purchase_price=500, current_value=500, lifecycle_status="opened")

        result = self.valuation([item])

        self.assertEqual(result.card_value, 300)
        self.assertEqual(result.product_value, 0)
        self.assertEqual(result.total_value, 300)
        self.assertEqual(result.product_cost_basis, 500)
        self.assertEqual(result.active_cost_basis, 500)
        self.assertEqual(result.total_pnl, -200)
        self.assertEqual(result.product_value_fallback_count, 0)
        self.assertEqual(result.products_needing_review_count, 0)

    def test_ambiguous_legacy_product_is_excluded_until_reviewed(self):
        self.add_product(purchase_price=500, current_value=650, lifecycle_status="review")

        result = self.valuation()

        self.assertEqual(result.product_value, 0)
        self.assertEqual(result.active_cost_basis, 500)
        self.assertEqual(result.total_pnl, -500)
        self.assertEqual(result.product_value_fallback_count, 0)
        self.assertEqual(result.products_needing_review_count, 1)

    def test_standalone_cards_and_sealed_product_reconcile_together(self):
        item = self.add_item(quantity=2, purchase_price=3)
        self.add_product(purchase_price=50, current_value=70)

        result = self.valuation([item])

        self.assertEqual(result.card_value, 20)
        self.assertEqual(result.product_value, 70)
        self.assertEqual(result.total_value, 90)
        self.assertEqual(result.card_cost_basis, 6)
        self.assertEqual(result.product_cost_basis, 50)
        self.assertEqual(result.active_cost_basis, 56)
        self.assertEqual(result.total_pnl, 34)

    def test_sold_product_is_not_an_active_asset_but_keeps_realized_result(self):
        self.add_product(purchase_price=50, current_value=90, sold_price=80)

        result = self.valuation()

        self.assertEqual(result.total_value, 0)
        self.assertEqual(result.active_cost_basis, 0)
        self.assertEqual(result.performance_cost_basis, 50)
        self.assertEqual(result.realized_value, 80)
        self.assertEqual(result.unrealized_pnl, 0)
        self.assertEqual(result.realized_pnl, 30)
        self.assertEqual(result.total_pnl, 30)
        self.assertEqual(result.products_realized_pnl, 30)

    def test_zero_value_writeoff_keeps_the_realized_loss(self):
        self.add_product(purchase_price=50, sold_price=0)

        result = self.valuation()

        self.assertEqual(result.total_value, 0)
        self.assertEqual(result.realized_value, 0)
        self.assertEqual(result.realized_pnl, -50)
        self.assertEqual(result.total_pnl, -50)

    def test_opened_product_cards_are_not_counted_twice(self):
        item = self.add_item(quantity=1, purchase_price=5)
        product = self.add_product(purchase_price=20, current_value=100)
        link = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=self.card.id,
            collection_item_id=item.id,
            initial_quantity=2,
            active_quantity=1,
            sold_quantity=1,
            variant="Normal",
            condition="NM",
            lang="en",
            purchase_price=5,
        )
        self.db.add(link)
        self.db.commit()
        self.db.refresh(link)
        self.db.add(ProductLedgerEntry(
            product_card_id=link.id,
            product_id=product.id,
            user_id=self.user.id,
            entry_type="card_sale",
            card_id=self.card.id,
            quantity=1,
            amount=15,
            event_date=datetime.date(2026, 8, 8),
        ))
        self.db.commit()

        result = self.valuation([item])

        self.assertEqual(result.card_value, 10)
        self.assertEqual(result.product_value, 0)
        self.assertEqual(result.total_value, 10)
        self.assertEqual(result.card_cost_basis, 0)
        self.assertEqual(result.product_cost_basis, 20)
        self.assertEqual(result.realized_value, 15)
        self.assertEqual(result.unrealized_pnl, -10)
        self.assertEqual(result.realized_pnl, 15)
        self.assertEqual(result.total_pnl, 5)
        self.assertEqual(result.products_realized_pnl, 15)

    def test_fully_realized_opened_product_transfers_its_cost_to_realized_pnl(self):
        product = self.add_product(purchase_price=20, current_value=100)
        link = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=self.card.id,
            collection_item_id=None,
            initial_quantity=1,
            active_quantity=0,
            sold_quantity=1,
            variant="Normal",
            condition="NM",
            lang="en",
            purchase_price=5,
        )
        self.db.add(link)
        self.db.commit()
        self.db.refresh(link)
        self.db.add(ProductLedgerEntry(
            product_card_id=link.id,
            product_id=product.id,
            user_id=self.user.id,
            entry_type="card_sale",
            card_id=self.card.id,
            quantity=1,
            amount=15,
            event_date=datetime.date(2026, 8, 8),
        ))
        self.db.commit()

        result = self.valuation()

        self.assertEqual(result.total_value, 0)
        self.assertEqual(result.active_cost_basis, 0)
        self.assertEqual(result.unrealized_pnl, 0)
        self.assertEqual(result.realized_pnl, -5)
        self.assertEqual(result.total_pnl, -5)
        self.assertEqual(result.products_realized_pnl, -5)

    def test_mixed_sold_products_use_one_reconciled_realized_pnl(self):
        self.add_product(purchase_price=50, sold_price=80)
        opened = self.add_product(purchase_price=20, current_value=100)
        link = ProductCard(
            product_id=opened.id,
            user_id=self.user.id,
            card_id=self.card.id,
            collection_item_id=None,
            initial_quantity=1,
            active_quantity=0,
            sold_quantity=1,
            variant="Normal",
            condition="NM",
            lang="en",
            purchase_price=5,
        )
        self.db.add(link)
        self.db.commit()
        self.db.refresh(link)
        self.db.add(ProductLedgerEntry(
            product_card_id=link.id,
            product_id=opened.id,
            user_id=self.user.id,
            entry_type="card_sale",
            card_id=self.card.id,
            quantity=1,
            amount=15,
            event_date=datetime.date(2026, 8, 8),
        ))
        self.db.commit()

        result = self.valuation()

        self.assertEqual(result.realized_value, 95)
        self.assertEqual(result.performance_cost_basis, 70)
        self.assertEqual(result.realized_pnl, 25)
        self.assertEqual(result.total_pnl, 25)
        self.assertEqual(result.products_realized_pnl, 25)

    def test_only_product_linked_quantity_is_removed_from_card_cost_basis(self):
        item = self.add_item(quantity=2, purchase_price=3)
        product = self.add_product(purchase_price=5)
        self.db.add(ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=self.card.id,
            collection_item_id=item.id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            variant="Normal",
            condition="NM",
            lang="en",
            purchase_price=3,
        ))
        self.db.commit()

        result = self.valuation([item])

        self.assertEqual(result.card_value, 20)
        self.assertEqual(result.card_cost_basis, 3)
        self.assertEqual(result.product_cost_basis, 5)
        self.assertEqual(result.active_cost_basis, 8)
        self.assertEqual(result.total_pnl, 12)

    def test_other_users_products_are_excluded(self):
        self.add_product(purchase_price=100, current_value=500, user=self.other_user)

        result = self.valuation()

        self.assertEqual(result.total_value, 0)
        self.assertEqual(result.active_cost_basis, 0)

    def test_snapshot_payload_marks_old_rows_as_legacy(self):
        snapshot = PortfolioSnapshot(
            date=datetime.datetime(2026, 8, 7, 12, 0),
            user_id=self.user.id,
            total_value=40,
            total_cost=50,
            total_cards=4,
            calculation_version=1,
        )

        payload = portfolio_snapshot_payload(snapshot)

        self.assertTrue(payload["legacy"])
        self.assertEqual(payload["pnl"], -10)
        self.assertIsNone(payload["products_value"])

    def test_snapshot_payload_uses_stored_current_calculation(self):
        snapshot = PortfolioSnapshot(
            date=datetime.datetime(2026, 8, 8, 12, 0),
            user_id=self.user.id,
            total_value=100,
            total_cost=70,
            total_cards=4,
            calculation_version=PORTFOLIO_CALCULATION_VERSION,
            cards_value=40,
            products_value=60,
            cards_cost=20,
            products_cost=50,
            performance_cost_basis=90,
            realized_value=25,
            unrealized_pnl=30,
            realized_pnl=5,
            total_pnl=35,
            product_value_fallback_count=1,
        )

        payload = portfolio_snapshot_payload(snapshot)

        self.assertFalse(payload["legacy"])
        self.assertEqual(payload["pnl"], 35)
        self.assertEqual(payload["products_value"], 60)
        self.assertEqual(payload["performance_cost_basis"], 90)
        self.assertEqual(payload["unrealized_pnl"], 30)
        self.assertEqual(payload["realized_pnl"], 5)

    def test_dashboard_and_both_snapshot_paths_share_the_same_valuation(self):
        self.add_product(purchase_price=50, current_value=70)

        dashboard = get_dashboard(
            db=self.db,
            price_field="price_trend",
            current_user=self.user,
        )
        _take_portfolio_snapshot(self.db, self.user.id, "price_trend")
        take_portfolio_snapshot(self.db, self.user.id)
        snapshots = self.db.query(PortfolioSnapshot).order_by(PortfolioSnapshot.id.asc()).all()

        self.assertEqual(len(snapshots), 2)
        for snapshot in snapshots:
            self.assertEqual(snapshot.calculation_version, PORTFOLIO_CALCULATION_VERSION)
            self.assertEqual(snapshot.total_value, dashboard["total_value"])
            self.assertEqual(snapshot.total_cost, dashboard["total_cost"])
            self.assertEqual(snapshot.total_pnl, dashboard["pnl"])
            self.assertEqual(snapshot.products_value, dashboard["product_value"])
            self.assertEqual(snapshot.products_cost, dashboard["products_cost"])


if __name__ == "__main__":
    unittest.main()
