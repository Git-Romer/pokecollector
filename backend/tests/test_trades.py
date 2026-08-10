import datetime
import os
import queue
import threading
import unittest
import uuid
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine, event, text
    from sqlalchemy.orm import sessionmaker

    import api.trades as trades_api
    from api.cards import delete_custom_card
    from api.analytics import get_trades_summary
    from api.products import unlink_product_card
    from api.trades import create_trade, get_trades, update_trade, value_trade
    from database import Base
    from models import Binder, BinderCard, Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, Trade, TradeItem, User
    from schemas import (
        TradeCreate,
        TradeIncomingItemCreate,
        TradeIncomingItemUpdate,
        TradeOutgoingItemCreate,
        TradeOutgoingItemUpdate,
        TradeUpdate,
        TradeValuationItem,
        TradeValuationRequest,
    )
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class TradeApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.outgoing_card = Card(
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
        self.incoming_card = Card(
            id="sv1-2_en",
            tcg_card_id="sv1-2",
            name="Floragato",
            set_id="sv1",
            number="2",
            lang="en",
            price_trend=14,
            price_market=13,
            variants_normal=True,
        )
        self.custom_card = Card(
            id="custom-trade-1",
            name="Signed Pikachu",
            set_id="custom",
            number="1",
            lang="en",
            is_custom=True,
        )
        self.db.add_all([self.user, self.other_user, self.outgoing_card, self.incoming_card, self.custom_card])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)
        self.custom_card.custom_owner_id = self.user.id
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_collection_item(self, quantity=2, user=None):
        item = CollectionItem(
            card_id=self.outgoing_card.id,
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

    def test_create_trade_moves_outgoing_and_incoming_cards_with_snapshots(self):
        outgoing = self.add_collection_item(quantity=2)

        response = create_trade(
            TradeCreate(
                partner_name="Brock",
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1)],
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=self.incoming_card.id,
                        quantity=2,
                        condition="LP",
                        variant="Normal",
                        lang="en",
                        value_per_card=12,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(outgoing)
        incoming_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        trade = self.db.query(Trade).one()
        trade_items = self.db.query(TradeItem).order_by(TradeItem.direction.asc()).all()

        self.assertEqual(outgoing.quantity, 1)
        self.assertEqual(incoming_item.quantity, 2)
        self.assertEqual(trade.outgoing_value, 10)
        self.assertEqual(trade.incoming_value, 24)
        self.assertEqual(trade.value_delta, 14)
        self.assertEqual(response.partner_name, "Brock")
        self.assertEqual(len(trade_items), 2)
        self.assertEqual({item.direction for item in trade_items}, {"outgoing", "incoming"})
        self.assertEqual({item.snapshot_version for item in trade_items}, {1})
        outgoing_snapshot = next(item for item in trade_items if item.direction == "outgoing")
        self.assertEqual(outgoing_snapshot.purchase_price, 2)
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 0)

    def test_trade_cannot_reduce_owned_quantity_below_binder_allocation(self):
        outgoing = self.add_collection_item(quantity=2)
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.add(BinderCard(
            binder_id=binder.id,
            card_id=outgoing.card_id,
            collection_item_id=outgoing.id,
            required_quantity=2,
        ))
        self.db.commit()

        with self.assertRaises(HTTPException) as context:
            create_trade(
                TradeCreate(
                    trade_date=datetime.date(2026, 7, 15),
                    outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1)],
                ),
                current_user=self.user,
                db=self.db,
                price_field="price_trend",
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.id == outgoing.id).one().quantity, 2)
        self.assertEqual(self.db.query(Trade).count(), 0)

    def test_create_trade_can_add_manual_incoming_card(self):
        response = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=self.custom_card.id,
                        quantity=1,
                        condition="NM",
                        variant="Holo",
                        lang="en",
                        value_per_card=25,
                        purchase_price=25,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.custom_card.id).one()
        self.assertEqual(item.quantity, 1)
        self.assertEqual(item.variant, "Holo")
        self.assertEqual(item.purchase_price, 25)
        self.assertEqual(response.incoming_value, 25)

    def test_trade_valuation_does_not_reveal_foreign_private_manual_card(self):
        private_card = Card(
            id="custom-private-value",
            name="Private priced card",
            is_custom=True,
            custom_owner_id=self.other_user.id,
            price_trend=999,
            lang="en",
        )
        self.db.add(private_card)
        self.db.commit()

        with self.assertRaises(HTTPException) as context:
            value_trade(
                TradeValuationRequest(
                    incoming=[TradeValuationItem(card_id=private_card.id, quantity=1)]
                ),
                current_user=self.user,
                db=self.db,
                price_field="price_trend",
            )

        self.assertEqual(context.exception.status_code, 404)
        self.assertEqual(context.exception.detail, "Card not found")

    def test_create_trade_can_include_cash_on_both_sides(self):
        outgoing = self.add_collection_item(quantity=1)

        response = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing_cash=5,
                incoming_cash=7,
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1, value_per_card=10)],
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=self.incoming_card.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                        value_per_card=14,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        cash_items = self.db.query(TradeItem).filter(TradeItem.card_id.is_(None)).order_by(TradeItem.direction).all()
        self.assertEqual(response.outgoing_value, 15)
        self.assertEqual(response.incoming_value, 21)
        self.assertEqual(response.value_delta, 6)
        self.assertEqual(len(cash_items), 2)
        self.assertEqual([item.value_total for item in cash_items], [7, 5])
        self.assertEqual([item.set_id for item in cash_items], ["cash", "cash"])

    def test_trades_summary_counts_cards_cash_and_product_locks(self):
        outgoing = self.add_collection_item(quantity=1)
        product = ProductPurchase(
            product_name="Booster Bundle",
            product_type="Bundle",
            purchase_price=20,
            purchase_date=datetime.date(2026, 7, 1),
            user_id=self.user.id,
        )
        self.db.add(product)
        self.db.commit()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=outgoing.card_id,
            collection_item_id=outgoing.id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            condition=outgoing.condition,
            variant=outgoing.variant,
            lang=outgoing.lang,
            purchase_price=outgoing.purchase_price,
            linked_at=datetime.datetime.utcnow(),
        )
        self.db.add(product_card)
        self.db.commit()

        create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing_cash=3,
                incoming_cash=5,
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1, value_per_card=10)],
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=self.incoming_card.id,
                        quantity=2,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                        value_per_card=7,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        summary = get_trades_summary(current_user=self.user, db=self.db)

        self.assertEqual(summary["trade_count"], 1)
        self.assertEqual(summary["outgoing_value"], 13)
        self.assertEqual(summary["incoming_value"], 19)
        self.assertEqual(summary["value_delta"], 6)
        self.assertEqual(summary["outgoing_cash"], 3)
        self.assertEqual(summary["incoming_cash"], 5)
        self.assertEqual(summary["cash_delta"], 2)
        self.assertEqual(summary["outgoing_card_quantity"], 1)
        self.assertEqual(summary["incoming_card_quantity"], 2)
        self.assertEqual(summary["product_locked_value"], 10)
        self.assertEqual(summary["product_locked_quantity"], 1)

    def test_create_trade_can_be_cash_only(self):
        response = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing_cash=10,
                incoming_cash=12,
            ),
            current_user=self.user,
            db=self.db,
        )

        cash_items = self.db.query(TradeItem).filter(TradeItem.card_id.is_(None)).all()
        self.assertEqual(response.outgoing_value, 10)
        self.assertEqual(response.incoming_value, 12)
        self.assertEqual(response.value_delta, 2)
        self.assertEqual(len(cash_items), 2)
        self.assertEqual(self.db.query(CollectionItem).count(), 0)

    def test_custom_card_delete_preserves_trade_snapshot_history(self):
        create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=self.custom_card.id,
                        quantity=1,
                        condition="NM",
                        variant="Holo",
                        lang="en",
                        value_per_card=25,
                        purchase_price=25,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        delete_custom_card(self.custom_card.id, current_user=self.user, db=self.db)
        trades = get_trades(current_user=self.user, db=self.db)

        self.assertEqual(len(trades), 1)
        self.assertEqual(len(trades[0].items), 1)
        self.assertIsNone(trades[0].items[0].card_id)
        self.assertEqual(trades[0].items[0].card_name, "Signed Pikachu")
        self.assertEqual(trades[0].items[0].value_total, 25)
        summary = get_trades_summary(current_user=self.user, db=self.db)
        self.assertEqual(summary["incoming_card_value"], 25)
        self.assertEqual(summary["incoming_card_quantity"], 1)
        self.assertEqual(summary["incoming_cash"], 0)

    def test_deleted_custom_card_named_cash_is_not_counted_as_cash(self):
        cash_named_card = Card(
            id="custom-cash-card",
            name="Cash",
            set_id="cash",
            number="promo",
            lang="en",
            is_custom=True,
            custom_owner_id=self.user.id,
            price_trend=33,
            variants_normal=True,
        )
        self.db.add(cash_named_card)
        self.db.commit()

        create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming=[
                    TradeIncomingItemCreate(
                        card_id=cash_named_card.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                        value_per_card=33,
                    )
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        delete_custom_card(cash_named_card.id, current_user=self.user, db=self.db)
        summary = get_trades_summary(current_user=self.user, db=self.db)

        self.assertEqual(summary["incoming_card_value"], 33)
        self.assertEqual(summary["incoming_card_quantity"], 1)
        self.assertEqual(summary["incoming_cash"], 0)

    def test_create_trade_rejects_too_much_outgoing_quantity(self):
        outgoing = self.add_collection_item(quantity=1)

        with self.assertRaises(HTTPException) as ctx:
            create_trade(
                TradeCreate(
                    trade_date=datetime.date(2026, 7, 15),
                    outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=2)],
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(self.db.query(Trade).count(), 0)

    def test_product_linked_outgoing_card_creates_trade_out_ledger(self):
        outgoing = self.add_collection_item(quantity=2)
        product = ProductPurchase(
            product_name="Booster Bundle",
            product_type="Bundle",
            purchase_price=20,
            purchase_date=datetime.date(2026, 7, 1),
            user_id=self.user.id,
        )
        self.db.add(product)
        self.db.commit()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=outgoing.card_id,
            collection_item_id=outgoing.id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            condition=outgoing.condition,
            variant=outgoing.variant,
            lang=outgoing.lang,
            purchase_price=outgoing.purchase_price,
            linked_at=datetime.datetime.utcnow(),
        )
        self.db.add(product_card)
        self.db.commit()

        create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1, value_per_card=11)],
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(product_card)
        ledger_entry = self.db.query(ProductLedgerEntry).one()
        self.assertEqual(product_card.active_quantity, 0)
        self.assertEqual(product_card.sold_quantity, 1)
        self.assertEqual(ledger_entry.entry_type, "trade_out")
        self.assertEqual(ledger_entry.trade_item_id, self.db.query(TradeItem).one().id)
        self.assertEqual(ledger_entry.amount, 11)
        self.assertEqual(ledger_entry.product_name, "Booster Bundle")

    def test_get_trades_only_returns_current_user(self):
        self.add_collection_item(quantity=1)
        other_item = self.add_collection_item(quantity=1, user=self.other_user)
        create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=other_item.id, quantity=1)],
            ),
            current_user=self.other_user,
            db=self.db,
        )

        trades = get_trades(current_user=self.user, db=self.db)

        self.assertEqual(trades, [])

    def test_update_trade_adds_forgotten_cards_and_preserves_existing_values(self):
        outgoing = self.add_collection_item(quantity=3)
        created = create_trade(
            TradeCreate(
                partner_name="Brock",
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1, value_per_card=9)],
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=1,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=12,
                    purchase_price=4,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        outgoing_trade_item = next(item for item in created.items if item.direction == "outgoing")
        incoming_trade_item = next(item for item in created.items if item.direction == "incoming")

        updated = update_trade(
            created.id,
            TradeUpdate(
                partner_name="Misty",
                trade_date=datetime.date(2026, 7, 16),
                notes="Corrected",
                outgoing=[
                    TradeOutgoingItemUpdate(trade_item_id=outgoing_trade_item.id, quantity=1),
                    TradeOutgoingItemUpdate(collection_item_id=outgoing.id, quantity=1, notes="Forgotten"),
                ],
                incoming=[
                    TradeIncomingItemUpdate(
                        trade_item_id=incoming_trade_item.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                    ),
                    TradeIncomingItemUpdate(
                        card_id=self.custom_card.id,
                        quantity=1,
                        condition="LP",
                        variant="Holo",
                        lang="en",
                        notes="Forgotten",
                    ),
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(updated.partner_name, "Misty")
        self.assertEqual(updated.trade_date, datetime.date(2026, 7, 16))
        self.assertEqual(updated.notes, "Corrected")
        self.assertEqual(len([item for item in updated.items if item.direction == "outgoing"]), 2)
        self.assertEqual(len([item for item in updated.items if item.direction == "incoming"]), 2)
        retained = next(item for item in updated.items if item.id == outgoing_trade_item.id)
        self.assertEqual(retained.value_per_card, 9)
        added_outgoing = next(item for item in updated.items if item.direction == "outgoing" and item.id != outgoing_trade_item.id)
        self.assertEqual(added_outgoing.value_per_card, 10)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.id == outgoing.id).one().quantity, 1)
        custom_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.custom_card.id).one()
        self.assertEqual(custom_item.condition, "LP")
        self.assertEqual(custom_item.variant, "Holo")

    def test_update_trade_same_incoming_card_gets_a_new_current_value_snapshot(self):
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=1,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=8,
                    purchase_price=3,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        historical_item = created.items[0]

        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=created.trade_date,
                incoming=[
                    TradeIncomingItemUpdate(
                        trade_item_id=historical_item.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                    ),
                    TradeIncomingItemUpdate(
                        card_id=self.incoming_card.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                    ),
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

        incoming_items = [item for item in updated.items if item.direction == "incoming"]
        self.assertEqual(len(incoming_items), 2)
        self.assertEqual(next(item for item in incoming_items if item.id == historical_item.id).value_per_card, 8)
        self.assertEqual(next(item for item in incoming_items if item.id != historical_item.id).value_per_card, 14)
        collection_items = self.db.query(CollectionItem).filter(
            CollectionItem.card_id == self.incoming_card.id,
        ).all()
        self.assertEqual(sum(item.quantity for item in collection_items), 2)
        self.assertEqual({item.purchase_price for item in collection_items}, {3, 14})

    def test_update_trade_reduces_product_linked_outgoing_and_restores_inventory(self):
        outgoing = self.add_collection_item(quantity=2)
        product = ProductPurchase(
            product_name="Booster Bundle",
            product_type="Bundle",
            purchase_price=20,
            purchase_date=datetime.date(2026, 7, 1),
            user_id=self.user.id,
        )
        self.db.add(product)
        self.db.commit()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=outgoing.card_id,
            collection_item_id=outgoing.id,
            initial_quantity=2,
            active_quantity=2,
            sold_quantity=0,
            condition=outgoing.condition,
            variant=outgoing.variant,
            lang=outgoing.lang,
            purchase_price=outgoing.purchase_price,
            linked_at=datetime.datetime.utcnow(),
        )
        self.db.add(product_card)
        self.db.commit()
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=2, value_per_card=11)],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]

        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=datetime.date(2026, 7, 16),
                outgoing=[TradeOutgoingItemUpdate(trade_item_id=trade_item.id, quantity=1, notes="Adjusted")],
            ),
            current_user=self.user,
            db=self.db,
        )

        self.db.refresh(product_card)
        restored = self.db.query(CollectionItem).filter(CollectionItem.card_id == outgoing.card_id).one()
        ledger = self.db.query(ProductLedgerEntry).one()
        self.assertEqual(restored.quantity, 1)
        self.assertEqual(restored.purchase_price, 2)
        self.assertEqual(product_card.collection_item_id, restored.id)
        self.assertEqual(product_card.active_quantity, 1)
        self.assertEqual(product_card.sold_quantity, 1)
        self.assertEqual(ledger.quantity, 1)
        self.assertEqual(ledger.amount, 11)
        self.assertEqual(ledger.event_date, datetime.date(2026, 7, 16))
        self.assertEqual(ledger.notes, "Adjusted")
        self.assertEqual(updated.outgoing_value, 11)

    def test_update_trade_corrects_outgoing_condition_and_restores_that_condition(self):
        outgoing = self.add_collection_item(quantity=2)
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(
                    collection_item_id=outgoing.id,
                    quantity=2,
                    value_per_card=11,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]

        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=created.trade_date,
                outgoing=[TradeOutgoingItemUpdate(
                    trade_item_id=trade_item.id,
                    quantity=1,
                    condition="LP",
                )],
            ),
            current_user=self.user,
            db=self.db,
        )

        restored = self.db.query(CollectionItem).filter(
            CollectionItem.card_id == outgoing.card_id,
        ).one()
        self.assertEqual(restored.quantity, 1)
        self.assertEqual(restored.condition, "LP")
        self.assertEqual(updated.items[0].condition, "LP")
        self.assertEqual(updated.items[0].value_per_card, 11)

    def test_update_trade_blocks_product_linked_outgoing_condition_correction(self):
        outgoing = self.add_collection_item(quantity=3)
        product = ProductPurchase(
            product_name="Booster Box",
            product_type="Booster Box",
            purchase_price=100,
            purchase_date=datetime.date(2026, 7, 1),
            user_id=self.user.id,
        )
        self.db.add(product)
        self.db.commit()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=outgoing.card_id,
            collection_item_id=outgoing.id,
            initial_quantity=3,
            active_quantity=3,
            sold_quantity=0,
            condition="NM",
            variant="Normal",
            lang="en",
            purchase_price=outgoing.purchase_price,
            linked_at=datetime.datetime.utcnow(),
        )
        self.db.add(product_card)
        self.db.commit()
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=2)],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]

        with self.assertRaises(HTTPException) as context:
            update_trade(
                created.id,
                TradeUpdate(
                    trade_date=created.trade_date,
                    outgoing=[TradeOutgoingItemUpdate(
                        trade_item_id=trade_item.id,
                        quantity=1,
                        condition="LP",
                    )],
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(context.exception.status_code, 409)
        self.db.refresh(product_card)
        retained_collection = self.db.query(CollectionItem).filter(
            CollectionItem.id == outgoing.id,
        ).one()
        retained_trade_item = self.db.query(TradeItem).filter(
            TradeItem.id == trade_item.id,
        ).one()
        self.assertEqual((product_card.active_quantity, product_card.sold_quantity), (1, 2))
        self.assertEqual(product_card.condition, "NM")
        self.assertEqual(retained_collection.quantity, 1)
        self.assertEqual(retained_collection.condition, "NM")
        self.assertEqual(retained_trade_item.quantity, 2)
        self.assertEqual(retained_trade_item.condition, "NM")

    def test_update_trade_incoming_reduction_respects_binder_allocations_atomically(self):
        created = create_trade(
            TradeCreate(
                partner_name="Brock",
                trade_date=datetime.date(2026, 7, 15),
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=2,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=14,
                    purchase_price=5,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]
        collection_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.add(BinderCard(
            binder_id=binder.id,
            card_id=collection_item.card_id,
            collection_item_id=collection_item.id,
            required_quantity=2,
        ))
        self.db.commit()

        with self.assertRaises(HTTPException) as context:
            update_trade(
                created.id,
                TradeUpdate(
                    partner_name="Changed",
                    trade_date=created.trade_date,
                    incoming=[TradeIncomingItemUpdate(
                        trade_item_id=trade_item.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                    )],
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.db.query(Trade).one().partner_name, "Brock")
        self.assertEqual(self.db.query(TradeItem).one().quantity, 2)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.id == collection_item.id).one().quantity, 2)

    def test_update_trade_changes_incoming_condition_and_keeps_historical_value(self):
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=2,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=12,
                    purchase_price=5,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]

        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=created.trade_date,
                incoming=[TradeIncomingItemUpdate(
                    trade_item_id=trade_item.id,
                    quantity=2,
                    condition="LP",
                    variant="Holo",
                    lang="en",
                    notes="Corrected condition",
                )],
            ),
            current_user=self.user,
            db=self.db,
        )

        collection_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        self.assertEqual(collection_item.quantity, 2)
        self.assertEqual(collection_item.condition, "LP")
        self.assertEqual(collection_item.variant, "Holo")
        self.assertEqual(collection_item.purchase_price, 5)
        self.assertEqual(updated.items[0].value_per_card, 12)
        self.assertEqual(updated.items[0].value_total, 24)

    def test_update_trade_allows_legacy_metadata_but_blocks_ambiguous_inventory_change(self):
        created = create_trade(
            TradeCreate(
                partner_name="Brock",
                trade_date=datetime.date(2026, 7, 15),
                incoming_cash=1,
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=1,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=14,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        card_item = next(item for item in created.items if item.card_id)
        db_item = self.db.query(TradeItem).filter(TradeItem.id == card_item.id).one()
        collection_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        db_item.snapshot_version = 0
        self.db.delete(collection_item)
        self.db.commit()

        metadata_only = update_trade(
            created.id,
            TradeUpdate(
                partner_name="Misty",
                trade_date=created.trade_date,
                incoming_cash=1,
                incoming=[TradeIncomingItemUpdate(
                    trade_item_id=card_item.id,
                    quantity=1,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(metadata_only.partner_name, "Misty")

        with self.assertRaises(HTTPException) as context:
            update_trade(
                created.id,
                TradeUpdate(
                    partner_name="Should roll back",
                    trade_date=created.trade_date,
                    incoming_cash=1,
                    incoming=[],
                ),
                current_user=self.user,
                db=self.db,
            )
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.db.query(Trade).one().partner_name, "Misty")

    def test_update_trade_rejects_other_users_trade(self):
        created = create_trade(
            TradeCreate(trade_date=datetime.date(2026, 7, 15), incoming_cash=2),
            current_user=self.other_user,
            db=self.db,
        )
        with self.assertRaises(HTTPException) as context:
            update_trade(
                created.id,
                TradeUpdate(trade_date=created.trade_date, incoming_cash=3),
                current_user=self.user,
                db=self.db,
            )
        self.assertEqual(context.exception.status_code, 404)

    def test_update_trade_rolls_back_earlier_inventory_changes_when_later_change_conflicts(self):
        outgoing = self.add_collection_item(quantity=1)
        created = create_trade(
            TradeCreate(
                partner_name="Brock",
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=1)],
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=2,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=14,
                    purchase_price=5,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        incoming_trade_item = next(item for item in created.items if item.direction == "incoming")
        incoming_collection = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        binder = Binder(name="Deck", user_id=self.user.id, binder_type="collection")
        self.db.add(binder)
        self.db.commit()
        self.db.add(BinderCard(
            binder_id=binder.id,
            card_id=incoming_collection.card_id,
            collection_item_id=incoming_collection.id,
            required_quantity=2,
        ))
        self.db.commit()

        with self.assertRaises(HTTPException):
            update_trade(
                created.id,
                TradeUpdate(
                    partner_name="Should roll back",
                    trade_date=created.trade_date,
                    outgoing=[],
                    incoming=[TradeIncomingItemUpdate(
                        trade_item_id=incoming_trade_item.id,
                        quantity=1,
                        condition="NM",
                        variant="Normal",
                        lang="en",
                    )],
                ),
                current_user=self.user,
                db=self.db,
            )

        self.assertEqual(self.db.query(Trade).one().partner_name, "Brock")
        self.assertEqual(self.db.query(TradeItem).count(), 2)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.card_id == outgoing.card_id).count(), 0)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.id == incoming_collection.id).one().quantity, 2)

    def test_update_trade_reconciles_multiple_product_sources(self):
        outgoing = self.add_collection_item(quantity=3)
        products = [
            ProductPurchase(
                product_name=f"Product {index}",
                product_type="Bundle",
                purchase_price=20,
                purchase_date=datetime.date(2026, 7, index),
                user_id=self.user.id,
            )
            for index in (1, 2)
        ]
        self.db.add_all(products)
        self.db.commit()
        product_cards = [
            ProductCard(
                product_id=products[0].id,
                user_id=self.user.id,
                card_id=outgoing.card_id,
                collection_item_id=outgoing.id,
                initial_quantity=1,
                active_quantity=1,
                sold_quantity=0,
                condition=outgoing.condition,
                variant=outgoing.variant,
                lang=outgoing.lang,
                purchase_price=outgoing.purchase_price,
                linked_at=datetime.datetime(2026, 7, 1),
            ),
            ProductCard(
                product_id=products[1].id,
                user_id=self.user.id,
                card_id=outgoing.card_id,
                collection_item_id=outgoing.id,
                initial_quantity=2,
                active_quantity=2,
                sold_quantity=0,
                condition=outgoing.condition,
                variant=outgoing.variant,
                lang=outgoing.lang,
                purchase_price=outgoing.purchase_price,
                linked_at=datetime.datetime(2026, 7, 2),
            ),
        ]
        self.db.add_all(product_cards)
        self.db.commit()
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing=[TradeOutgoingItemCreate(collection_item_id=outgoing.id, quantity=3, value_per_card=10)],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = created.items[0]
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 2)
        self.assertEqual({entry.trade_item_id for entry in self.db.query(ProductLedgerEntry).all()}, {trade_item.id})

        update_trade(
            created.id,
            TradeUpdate(
                trade_date=created.trade_date,
                outgoing=[TradeOutgoingItemUpdate(trade_item_id=trade_item.id, quantity=1)],
            ),
            current_user=self.user,
            db=self.db,
        )

        for product_card in product_cards:
            self.db.refresh(product_card)
        self.assertEqual((product_cards[0].active_quantity, product_cards[0].sold_quantity), (0, 1))
        self.assertEqual((product_cards[1].active_quantity, product_cards[1].sold_quantity), (2, 0))
        remaining_ledger = self.db.query(ProductLedgerEntry).one()
        self.assertEqual(remaining_ledger.product_card_id, product_cards[0].id)
        self.assertEqual(remaining_ledger.quantity, 1)
        restored = self.db.query(CollectionItem).filter(CollectionItem.card_id == outgoing.card_id).one()
        self.assertEqual(restored.quantity, 2)
        self.assertTrue(all(card.collection_item_id == restored.id for card in product_cards if card.active_quantity > 0))

    def test_update_trade_cash_recalculates_totals(self):
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing_cash=5,
                incoming_cash=7,
            ),
            current_user=self.user,
            db=self.db,
        )
        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=datetime.date(2026, 7, 20),
                outgoing_cash=2,
                incoming_cash=10,
            ),
            current_user=self.user,
            db=self.db,
        )
        self.assertEqual(updated.outgoing_value, 2)
        self.assertEqual(updated.incoming_value, 10)
        self.assertEqual(updated.value_delta, 8)
        self.assertEqual(len(updated.items), 2)

    def test_update_trade_recognizes_legacy_note_marked_cash_rows(self):
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                outgoing_cash=5,
            ),
            current_user=self.user,
            db=self.db,
        )
        legacy_cash = self.db.query(TradeItem).one()
        legacy_cash.set_id = None
        legacy_cash.card_number = None
        legacy_cash.notes = "Cash added to trade"
        self.db.commit()

        updated = update_trade(
            created.id,
            TradeUpdate(
                trade_date=created.trade_date,
                outgoing_cash=7,
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(updated.outgoing_value, 7)
        self.assertEqual(len(updated.items), 1)
        self.assertEqual(updated.items[0].card_name, "Cash")

    def test_update_trade_does_not_remove_received_copies_linked_to_a_product(self):
        created = create_trade(
            TradeCreate(
                trade_date=datetime.date(2026, 7, 15),
                incoming_cash=1,
                incoming=[TradeIncomingItemCreate(
                    card_id=self.incoming_card.id,
                    quantity=1,
                    condition="NM",
                    variant="Normal",
                    lang="en",
                    value_per_card=14,
                    purchase_price=5,
                )],
            ),
            current_user=self.user,
            db=self.db,
        )
        trade_item = next(item for item in created.items if item.card_id)
        collection_item = self.db.query(CollectionItem).filter(CollectionItem.card_id == self.incoming_card.id).one()
        product = ProductPurchase(
            product_name="Later product link",
            product_type="Bundle",
            purchase_price=20,
            purchase_date=datetime.date(2026, 7, 20),
            user_id=self.user.id,
        )
        self.db.add(product)
        self.db.commit()
        self.db.add(ProductCard(
            product_id=product.id,
            user_id=self.user.id,
            card_id=collection_item.card_id,
            collection_item_id=collection_item.id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            condition=collection_item.condition,
            variant=collection_item.variant,
            lang=collection_item.lang,
            purchase_price=collection_item.purchase_price,
            linked_at=datetime.datetime.utcnow(),
        ))
        self.db.commit()

        with self.assertRaises(HTTPException) as context:
            update_trade(
                created.id,
                TradeUpdate(
                    trade_date=created.trade_date,
                    incoming_cash=1,
                    incoming=[],
                ),
                current_user=self.user,
                db=self.db,
            )
        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(self.db.query(TradeItem).filter(TradeItem.id == trade_item.id).one().quantity, 1)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.id == collection_item.id).one().quantity, 1)


POSTGRES_TEST_URL = os.getenv("TEST_POSTGRES_URL", "")


@unittest.skipUnless(
    API_TEST_DEPS_AVAILABLE and POSTGRES_TEST_URL.startswith("postgresql"),
    "TEST_POSTGRES_URL is required for PostgreSQL trade-edit concurrency coverage",
)
class TradeEditPostgresConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.schema = f"trade_edit_test_{uuid.uuid4().hex}"
        self.admin_engine = create_engine(POSTGRES_TEST_URL, isolation_level="AUTOCOMMIT")
        with self.admin_engine.connect() as conn:
            conn.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_engine(
            POSTGRES_TEST_URL,
            connect_args={"options": f"-csearch_path={self.schema}"},
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autoflush=False)

        db = self.Session()
        user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Sprigatito",
            set_id="sv1",
            number="1",
            lang="en",
            price_trend=10,
            variants_normal=True,
        )
        db.add_all([user, card])
        db.commit()
        item = CollectionItem(
            card_id=card.id,
            user_id=user.id,
            quantity=1,
            condition="NM",
            variant="Normal",
            lang="en",
            purchase_price=2,
            added_at=datetime.datetime.utcnow(),
        )
        db.add(item)
        db.commit()
        trade = create_trade(
            TradeCreate(trade_date=datetime.date(2026, 8, 8), incoming_cash=1),
            current_user=user,
            db=db,
        )
        self.user_id = user.id
        self.collection_item_id = item.id
        self.trade_id = trade.id
        db.close()

    def tearDown(self):
        self.engine.dispose()
        with self.admin_engine.connect() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{self.schema}" CASCADE'))
        self.admin_engine.dispose()

    def test_two_edits_cannot_allocate_the_same_outgoing_copy(self):
        barrier = threading.Barrier(2)
        results = queue.Queue()

        def edit_trade():
            db = self.Session()
            try:
                user = db.query(User).filter(User.id == self.user_id).one()
                barrier.wait(timeout=5)
                update_trade(
                    self.trade_id,
                    TradeUpdate(
                        trade_date=datetime.date(2026, 8, 8),
                        incoming_cash=1,
                        outgoing=[TradeOutgoingItemUpdate(
                            collection_item_id=self.collection_item_id,
                            quantity=1,
                        )],
                    ),
                    current_user=user,
                    db=db,
                )
                results.put("success")
            except HTTPException as exc:
                results.put(exc.status_code)
            except Exception as exc:
                results.put(exc)
            finally:
                db.close()

        threads = [threading.Thread(target=edit_trade, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))

        outcomes = sorted([results.get_nowait(), results.get_nowait()], key=str)
        self.assertIn("success", outcomes)
        self.assertTrue(any(outcome in {404, 409} for outcome in outcomes if outcome != "success"))

        db = self.Session()
        self.assertEqual(db.query(CollectionItem).filter(CollectionItem.id == self.collection_item_id).count(), 0)
        card_items = db.query(TradeItem).filter(TradeItem.trade_id == self.trade_id, TradeItem.card_id.isnot(None)).all()
        self.assertEqual(len(card_items), 1)
        self.assertEqual(card_items[0].quantity, 1)
        db.close()

    def test_product_unlink_cannot_erase_concurrent_trade_provenance(self):
        setup_db = self.Session()
        product = ProductPurchase(
            product_name="Tracked box",
            product_type="Booster Box",
            purchase_price=100,
            purchase_date=datetime.date(2026, 8, 1),
            user_id=self.user_id,
        )
        setup_db.add(product)
        setup_db.flush()
        product_card = ProductCard(
            product_id=product.id,
            user_id=self.user_id,
            card_id="sv1-1_en",
            collection_item_id=self.collection_item_id,
            initial_quantity=1,
            active_quantity=1,
            sold_quantity=0,
            condition="NM",
            variant="Normal",
            lang="en",
            purchase_price=2,
            linked_at=datetime.datetime.utcnow(),
        )
        setup_db.add(product_card)
        setup_db.commit()
        product_id = product.id
        product_card_id = product_card.id
        setup_db.close()

        trade_linked = threading.Event()
        allow_trade_commit = threading.Event()
        delete_started = threading.Event()
        results = queue.Queue()
        original_record = trades_api._record_linked_trade_out

        def pause_after_record(*args, **kwargs):
            original_record(*args, **kwargs)
            trade_linked.set()
            if not allow_trade_commit.wait(timeout=5):
                raise RuntimeError("Timed out while coordinating the trade/unlink race")

        def observe_delete(_conn, _cursor, statement, _parameters, _context, _executemany):
            if statement.lstrip().upper().startswith("DELETE FROM PRODUCT_CARDS"):
                delete_started.set()

        def edit_trade():
            db = self.Session()
            try:
                user = db.query(User).filter(User.id == self.user_id).one()
                update_trade(
                    self.trade_id,
                    TradeUpdate(
                        trade_date=datetime.date(2026, 8, 8),
                        incoming_cash=1,
                        outgoing=[TradeOutgoingItemUpdate(
                            collection_item_id=self.collection_item_id,
                            quantity=1,
                        )],
                    ),
                    current_user=user,
                    db=db,
                )
                results.put(("trade", "success"))
            except Exception as exc:
                results.put(("trade", exc))
            finally:
                db.close()

        def unlink_card():
            db = self.Session()
            try:
                user = db.query(User).filter(User.id == self.user_id).one()
                unlink_product_card(product_id, product_card_id, current_user=user, db=db)
                results.put(("unlink", "success"))
            except HTTPException as exc:
                results.put(("unlink", exc.status_code))
            except Exception as exc:
                results.put(("unlink", exc))
            finally:
                db.close()

        event.listen(self.engine, "before_cursor_execute", observe_delete)
        try:
            with patch.object(trades_api, "_record_linked_trade_out", side_effect=pause_after_record):
                trade_thread = threading.Thread(target=edit_trade, daemon=True)
                trade_thread.start()
                self.assertTrue(trade_linked.wait(timeout=5))

                unlink_thread = threading.Thread(target=unlink_card, daemon=True)
                unlink_thread.start()
                # A broken implementation reaches a blocked DELETE here. The
                # fixed implementation blocks earlier on SELECT FOR UPDATE.
                delete_started.wait(timeout=0.25)
                allow_trade_commit.set()

                trade_thread.join(timeout=10)
                unlink_thread.join(timeout=10)
                self.assertFalse(trade_thread.is_alive())
                self.assertFalse(unlink_thread.is_alive())
        finally:
            allow_trade_commit.set()
            event.remove(self.engine, "before_cursor_execute", observe_delete)

        outcomes = dict([results.get_nowait(), results.get_nowait()])
        self.assertEqual(outcomes["trade"], "success")
        self.assertEqual(outcomes["unlink"], 409)

        verify_db = self.Session()
        retained_product_card = verify_db.query(ProductCard).filter(
            ProductCard.id == product_card_id,
        ).one()
        ledger = verify_db.query(ProductLedgerEntry).one()
        self.assertEqual(retained_product_card.sold_quantity, 1)
        self.assertEqual(retained_product_card.active_quantity, 0)
        self.assertEqual(ledger.product_card_id, product_card_id)
        self.assertIsNotNone(ledger.trade_item_id)
        verify_db.close()


if __name__ == "__main__":
    unittest.main()
