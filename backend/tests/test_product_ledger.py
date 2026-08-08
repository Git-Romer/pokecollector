import datetime
import unittest
from types import SimpleNamespace

from services.product_ledger import product_effective_value

try:
    from fastapi import HTTPException
    from pydantic import ValidationError
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.products import (
        bulk_update_product_lifecycle,
        create_product,
        create_product_batch,
        get_products_summary,
        link_collection_item_to_product,
        link_collection_items_to_product,
        sell_product_card,
        update_product,
    )
    from api.cards import delete_custom_card
    from api.collection import get_collection, update_collection_item
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, User
    from schemas import (
        CollectionItemUpdate,
        ProductCardLinkCreate,
        ProductCardBulkLinkCreate,
        ProductCardSaleCreate,
        ProductLifecycleBulkUpdate,
        ProductPurchaseBatchCreate,
        ProductPurchaseCreate,
        ProductPurchaseUpdate,
    )
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
                SimpleNamespace(entry_type="trade_out", amount=15),
            ],
        )

        value, source, totals = product_effective_value(product, [product_card])

        self.assertEqual(source, "linked_cards")
        self.assertEqual(totals.live_cards_value, 10)
        self.assertEqual(totals.realized_gains, 40)
        self.assertEqual(value, 50)

    def test_product_effective_value_keeps_zero_manual_current_value(self):
        product = SimpleNamespace(purchase_price=50, current_value=0, sold_price=None)

        value, source, totals = product_effective_value(product, [])

        self.assertEqual(source, "manual_current")
        self.assertEqual(value, 0)
        self.assertEqual(totals.dynamic_value, 0)

    def test_product_effective_value_uses_purchase_cost_when_current_value_is_missing(self):
        product = SimpleNamespace(purchase_price=25, current_value=None, sold_price=None)

        value, source, totals = product_effective_value(product, [])

        self.assertEqual(source, "purchase_cost_fallback")
        self.assertEqual(value, 25)
        self.assertEqual(totals.dynamic_value, 0)

    def test_opened_unlinked_product_has_no_separate_asset_value(self):
        product = SimpleNamespace(
            purchase_price=50,
            current_value=80,
            sold_price=None,
            sold_date=None,
            lifecycle_status="opened",
        )

        value, source, _totals = product_effective_value(product, [])

        self.assertEqual(source, "opened_unlinked")
        self.assertEqual(value, 0)

    def test_review_product_is_excluded_until_classified(self):
        product = SimpleNamespace(
            purchase_price=50,
            current_value=80,
            sold_price=None,
            sold_date=None,
            lifecycle_status="review",
        )

        value, source, _totals = product_effective_value(product, [])

        self.assertEqual(source, "needs_review")
        self.assertEqual(value, 0)

    def test_date_only_legacy_sale_requires_review_instead_of_becoming_zero_value_sale(self):
        product = SimpleNamespace(
            purchase_price=50,
            current_value=80,
            sold_price=None,
            sold_date=datetime.date(2026, 6, 1),
            lifecycle_status="sold",
        )

        value, source, _totals = product_effective_value(product, [])

        self.assertEqual(source, "needs_review")
        self.assertEqual(value, 0)


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

    def add_collection_item(self, quantity=1, user=None, card=None):
        card = card or self.card
        item = CollectionItem(
            card_id=card.id,
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

    def test_bulk_classification_updates_only_owned_legacy_products(self):
        first = self.add_product()
        second = self.add_product()
        first.lifecycle_status = "review"
        second.lifecycle_status = "review"
        self.db.commit()

        response = bulk_update_product_lifecycle(
            ProductLifecycleBulkUpdate(
                product_ids=[first.id, second.id],
                lifecycle_status="opened",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(first)
        self.db.refresh(second)
        self.assertEqual(response["updated"], 2)
        self.assertEqual(first.lifecycle_status, "opened")
        self.assertEqual(second.lifecycle_status, "opened")

    def test_bulk_classification_rejects_foreign_product_without_partial_update(self):
        own = self.add_product()
        foreign = self.add_product(user=self.other_user)
        own.lifecycle_status = "review"
        foreign.lifecycle_status = "review"
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            bulk_update_product_lifecycle(
                ProductLifecycleBulkUpdate(
                    product_ids=[own.id, foreign.id],
                    lifecycle_status="sealed",
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 404)
        self.db.refresh(own)
        self.assertEqual(own.lifecycle_status, "review")

    def test_bulk_classification_rejects_stale_status_without_partial_update(self):
        pending = self.add_product()
        already_classified = self.add_product()
        pending.lifecycle_status = "review"
        already_classified.lifecycle_status = "opened"
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            bulk_update_product_lifecycle(
                ProductLifecycleBulkUpdate(
                    product_ids=[pending.id, already_classified.id],
                    lifecycle_status="sealed",
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)
        self.db.refresh(pending)
        self.assertEqual(pending.lifecycle_status, "review")

    def test_bulk_classification_rejects_incomplete_date_only_sale(self):
        product = self.add_product()
        product.lifecycle_status = "review"
        product.sold_date = datetime.date(2026, 6, 1)
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            bulk_update_product_lifecycle(
                ProductLifecycleBulkUpdate(
                    product_ids=[product.id],
                    lifecycle_status="opened",
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 422)
        self.db.rollback()
        self.db.refresh(product)
        self.assertEqual(product.lifecycle_status, "review")

    def test_sealed_product_update_with_sale_becomes_sold(self):
        product = self.add_product()

        response = update_product(
            product.id,
            ProductPurchaseUpdate(
                sold_price=80,
                sold_date=datetime.date(2026, 6, 1),
                lifecycle_status="sealed",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(product)
        self.assertEqual(product.lifecycle_status, "sold")
        self.assertEqual(response.lifecycle_status, "sold")
        self.assertEqual(response.computed_current_value, 80)

    def test_opened_unlinked_product_cannot_be_sold_as_sealed(self):
        product = self.add_product()
        product.lifecycle_status = "opened"
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            update_product(
                product.id,
                ProductPurchaseUpdate(
                    sold_price=80,
                    sold_date=datetime.date(2026, 6, 1),
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)

    def test_linked_product_cannot_receive_whole_product_sale_fields(self):
        product = self.add_product()
        item = self.add_collection_item()
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
            current_user=self.user,
            db=self.db,
        )

        with self.assertRaises(HTTPException) as ctx:
            update_product(
                product.id,
                ProductPurchaseUpdate(sold_price=80, sold_date=datetime.date(2026, 6, 1)),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)

    def test_create_rejects_opened_product_with_whole_product_sale(self):
        with self.assertRaises(HTTPException) as ctx:
            create_product(
                ProductPurchaseCreate(
                    product_name="Opened Box",
                    product_type="Booster Box",
                    purchase_price=50,
                    sold_price=80,
                    purchase_date=datetime.date(2026, 5, 30),
                    sold_date=datetime.date(2026, 6, 1),
                    lifecycle_status="opened",
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)

    def test_batch_create_makes_independent_products_with_shared_batch(self):
        responses = create_product_batch(
            ProductPurchaseBatchCreate(
                product_name="Booster Pack",
                product_type="Booster Pack",
                purchase_price=4.5,
                current_value=5,
                purchase_date=datetime.date(2026, 8, 8),
                lifecycle_status="sealed",
                quantity=3,
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(len(responses), 3)
        self.assertEqual(len({response.id for response in responses}), 3)
        self.assertEqual(len({response.batch_id for response in responses}), 1)
        self.assertIsNotNone(responses[0].batch_id)
        self.assertTrue(all(response.purchase_price == 4.5 for response in responses))

        first = self.db.get(ProductPurchase, responses[0].id)
        first.lifecycle_status = "opened"
        self.db.commit()
        siblings = self.db.query(ProductPurchase).filter(
            ProductPurchase.batch_id == responses[0].batch_id,
        ).order_by(ProductPurchase.id).all()
        self.assertEqual([product.lifecycle_status for product in siblings], ["opened", "sealed", "sealed"])

    def test_single_batch_create_does_not_create_a_group(self):
        responses = create_product_batch(
            ProductPurchaseBatchCreate(
                product_name="Single Tin",
                product_type="Tin",
                purchase_price=20,
                purchase_date=datetime.date(2026, 8, 8),
                quantity=1,
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(len(responses), 1)
        self.assertIsNone(responses[0].batch_id)

    def test_batch_quantity_accepts_boundaries_and_rejects_invalid_values(self):
        base = {
            "product_name": "Booster Pack",
            "product_type": "Booster Pack",
            "purchase_price": 4.5,
            "purchase_date": datetime.date(2026, 8, 8),
        }

        self.assertEqual(ProductPurchaseBatchCreate(**base, quantity=1).quantity, 1)
        self.assertEqual(ProductPurchaseBatchCreate(**base, quantity=200).quantity, 200)
        for invalid_quantity in (0, 201, 2.5):
            with self.subTest(quantity=invalid_quantity), self.assertRaises(ValidationError):
                ProductPurchaseBatchCreate(**base, quantity=invalid_quantity)

    def test_editing_batch_identity_detaches_only_that_product(self):
        responses = create_product_batch(
            ProductPurchaseBatchCreate(
                product_name="Booster Pack",
                product_type="Booster Pack",
                purchase_price=4.5,
                purchase_date=datetime.date(2026, 8, 8),
                quantity=3,
            ),
            current_user=self.user,
            db=self.db,
        )

        updated = update_product(
            responses[0].id,
            ProductPurchaseUpdate(product_name="Opened Booster Pack"),
            current_user=self.user,
            db=self.db,
        )
        siblings = self.db.query(ProductPurchase).filter(
            ProductPurchase.id.in_([response.id for response in responses[1:]]),
        ).all()

        self.assertIsNone(updated.batch_id)
        self.assertEqual({product.batch_id for product in siblings}, {responses[1].batch_id})

    def test_create_rejects_sale_date_without_sale_price(self):
        with self.assertRaises(HTTPException) as ctx:
            create_product(
                ProductPurchaseCreate(
                    product_name="Incomplete Sale",
                    product_type="Booster Box",
                    purchase_price=50,
                    purchase_date=datetime.date(2026, 5, 30),
                    sold_date=datetime.date(2026, 6, 1),
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 422)

    def test_zero_sale_price_is_a_valid_explicit_sale(self):
        response = create_product(
            ProductPurchaseCreate(
                product_name="Disposed Product",
                product_type="Booster Box",
                purchase_price=50,
                purchase_date=datetime.date(2026, 5, 30),
                sold_price=0,
                sold_date=datetime.date(2026, 6, 1),
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(response.lifecycle_status, "sold")
        self.assertEqual(response.computed_current_value, 0)

    def test_update_rejects_clearing_sale_price_while_sale_date_remains(self):
        product = self.add_product()
        product.lifecycle_status = "sold"
        product.sold_price = 80
        product.sold_date = datetime.date(2026, 6, 1)
        self.db.commit()

        with self.assertRaises(HTTPException) as ctx:
            update_product(
                product.id,
                ProductPurchaseUpdate(sold_price=None),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 422)
        self.db.rollback()
        self.db.refresh(product)
        self.assertEqual(product.sold_price, 80)
        self.assertEqual(product.lifecycle_status, "sold")

    def test_update_can_clear_sale_and_reclassify_in_the_same_request(self):
        product = self.add_product()
        product.lifecycle_status = "sold"
        product.sold_price = 80
        product.sold_date = datetime.date(2026, 6, 1)
        self.db.commit()

        response = update_product(
            product.id,
            ProductPurchaseUpdate(
                sold_price=None,
                sold_date=None,
                lifecycle_status="opened",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(product)
        self.assertIsNone(product.sold_price)
        self.assertIsNone(product.sold_date)
        self.assertEqual(product.lifecycle_status, "opened")
        self.assertEqual(response.lifecycle_status, "opened")

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

    def test_bulk_link_adds_multiple_collection_rows_and_opens_product(self):
        product = self.add_product()
        first_item = self.add_collection_item(quantity=2)
        second_item = self.add_collection_item(quantity=1)

        response = link_collection_items_to_product(
            product.id,
            ProductCardBulkLinkCreate(items=[
                ProductCardLinkCreate(collection_item_id=first_item.id, quantity=2),
                ProductCardLinkCreate(collection_item_id=second_item.id, quantity=1),
            ]),
            current_user=self.user,
            db=self.db,
        )

        rows = self.db.query(ProductCard).order_by(ProductCard.collection_item_id).all()
        self.assertEqual([(row.collection_item_id, row.active_quantity) for row in rows], [
            (first_item.id, 2),
            (second_item.id, 1),
        ])
        self.assertEqual(response.lifecycle_status, "opened")
        self.assertEqual(response.active_linked_cards_count, 3)

    def test_bulk_link_validation_is_atomic(self):
        product = self.add_product()
        original_status = product.lifecycle_status
        valid_item = self.add_collection_item(quantity=1)
        insufficient_item = self.add_collection_item(quantity=1)

        with self.assertRaises(HTTPException) as ctx:
            link_collection_items_to_product(
                product.id,
                ProductCardBulkLinkCreate(items=[
                    ProductCardLinkCreate(collection_item_id=valid_item.id, quantity=1),
                    ProductCardLinkCreate(collection_item_id=insufficient_item.id, quantity=2),
                ]),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)
        self.db.rollback()
        self.assertEqual(self.db.query(ProductCard).count(), 0)
        self.db.refresh(product)
        self.assertEqual(product.lifecycle_status, original_status)

    def test_bulk_link_rejects_duplicate_collection_rows(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=2)

        with self.assertRaises(HTTPException) as ctx:
            link_collection_items_to_product(
                product.id,
                ProductCardBulkLinkCreate(items=[
                    ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
                    ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
                ]),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 422)
        self.db.rollback()
        self.assertEqual(self.db.query(ProductCard).count(), 0)

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

    def test_collection_response_includes_active_product_source(self):
        product = self.add_product()
        item = self.add_collection_item(quantity=3)
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=2),
            current_user=self.user,
            db=self.db,
        )

        collection = get_collection(current_user=self.user, db=self.db)

        self.assertEqual(len(collection), 1)
        self.assertEqual(len(collection[0].product_sources), 1)
        source = collection[0].product_sources[0]
        self.assertEqual(source["product_id"], product.id)
        self.assertEqual(source["product_name"], "Collection Box")
        self.assertEqual(source["product_type"], "Collection Box")
        self.assertEqual(source["active_quantity"], 2)

    def test_collection_response_hides_missing_inactive_and_other_user_sources(self):
        item = self.add_collection_item(quantity=3)
        self.assertEqual(get_collection(current_user=self.user, db=self.db)[0].product_sources, [])

        product = self.add_product()
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
            current_user=self.user,
            db=self.db,
        )
        own_link = self.db.query(ProductCard).filter(ProductCard.user_id == self.user.id).one()
        own_link.active_quantity = 0

        other_product = self.add_product(user=self.other_user)
        self.db.add(ProductCard(
            product_id=other_product.id,
            user_id=self.other_user.id,
            card_id=item.card_id,
            collection_item_id=item.id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            condition=item.condition,
            variant=item.variant,
            lang=item.lang,
            purchase_price=item.purchase_price,
        ))
        self.db.commit()

        collection = get_collection(current_user=self.user, db=self.db)

        self.assertEqual(collection[0].product_sources, [])

    def test_selling_an_allocated_final_copy_is_blocked_without_mutation(self):
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

        with self.assertRaises(HTTPException) as context:
            sell_product_card(
                product.id,
                product_card.id,
                ProductCardSaleCreate(quantity=1, sold_price=0, sold_date=datetime.date(2026, 5, 30)),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIsNotNone(self.db.query(CollectionItem).filter(CollectionItem.id == item.id).first())
        self.assertEqual(self.db.query(BinderCard).filter(BinderCard.collection_item_id == item.id).count(), 1)
        self.assertEqual(self.db.query(ProductLedgerEntry).filter(ProductLedgerEntry.card_id == self.card.id).count(), 0)
        product_card = self.db.query(ProductCard).one()
        self.assertEqual(product_card.active_quantity, 1)
        self.assertEqual(product_card.sold_quantity, 0)

    def test_deleting_custom_card_is_blocked_for_active_product_link(self):
        custom_card = Card(
            id="custom-sm-promo",
            tcg_card_id="custom-sm-promo",
            name="Signed Promo",
            set_id="custom",
            number="42",
            lang="en",
            is_custom=True,
            price_trend=20,
            price_market=20,
            variants_normal=True,
        )
        self.db.add(custom_card)
        self.db.commit()
        product = self.add_product()
        item = self.add_collection_item(quantity=1, card=custom_card)
        link_collection_item_to_product(
            product.id,
            ProductCardLinkCreate(collection_item_id=item.id, quantity=1),
            current_user=self.user,
            db=self.db,
        )

        with self.assertRaises(HTTPException) as ctx:
            delete_custom_card(custom_card.id, current_user=self.user, db=self.db)

        product_card = self.db.query(ProductCard).one()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(product_card.card_id, custom_card.id)
        self.assertEqual(product_card.active_quantity, 1)
        self.assertIsNotNone(self.db.query(Card).filter(Card.id == custom_card.id).first())


if __name__ == "__main__":
    unittest.main()
