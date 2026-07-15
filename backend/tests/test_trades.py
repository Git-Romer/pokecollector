import datetime
import unittest

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import delete_custom_card
    from api.trades import create_trade, get_trades
    from database import Base
    from models import Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, Trade, TradeItem, User
    from schemas import TradeCreate, TradeIncomingItemCreate, TradeOutgoingItemCreate
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
        self.assertEqual(self.db.query(ProductLedgerEntry).count(), 0)

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
        self.assertEqual(trades[0].items[0].card_name, "Signed Pikachu")
        self.assertEqual(trades[0].items[0].value_total, 25)

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


if __name__ == "__main__":
    unittest.main()
