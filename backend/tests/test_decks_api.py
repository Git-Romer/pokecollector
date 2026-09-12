import unittest

try:
    from fastapi import HTTPException
    from pydantic import ValidationError
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.decks import add_deck_entry, compare_owned_decks, create_deck, delete_deck, delete_deck_entry, duplicate_deck, get_deck, get_deck_assembly_progress, get_decks, reset_deck_assembly_progress, update_deck, update_deck_assembly_progress, update_deck_entry
    from database import Base
    from models import Card, CollectionItem, Deck, DeckAssemblyProgress, DeckEntry, User
    from schemas import DeckAssemblyProgressUpdate, DeckCreate, DeckEntryCreate, DeckEntryUpdate, DeckUpdate
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class DeckApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        self.db = self.Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.card = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Pikachu ex", set_id="sv1", number="1", lang="en", supertype="Pokemon", variants_normal=True)
        self.energy = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Basic Lightning Energy", set_id="sv1", number="2", lang="en", supertype="Energy", subtypes=["Basic"], variants_normal=True)
        self.grass_energy = Card(id="sv1-3_en", tcg_card_id="sv1-3", name="Grass Energy", set_id="sv1", number="3", lang="en", supertype="Energy", subtypes=["Basic"], variants_normal=True)
        self.ultra_ball = Card(id="sv1-4_en", tcg_card_id="sv1-4", name="Ultra Ball", set_id="sv1", number="4", lang="en", supertype="Trainer", variants_normal=True)
        self.virizion = Card(id="sv1-5_en", tcg_card_id="sv1-5", name="Virizion", set_id="sv1", number="5", lang="en", supertype="Pokemon", variants_normal=True)
        self.db.add_all([self.user, self.other_user, self.card, self.energy, self.grass_energy, self.ultra_ball, self.virizion])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def _own(self, card_id, quantity, variant="Normal", condition="NM"):
        item = CollectionItem(card_id=card_id, user_id=self.user.id, quantity=quantity, variant=variant, condition=condition, lang="en")
        self.db.add(item)
        self.db.commit()
        return item

    def _create(self, target_size=60):
        return create_deck(DeckCreate(name="Practice", target_size=target_size), current_user=self.user, db=self.db)

    def test_creates_20_40_and_60_card_decks(self):
        for target_size in (20, 40, 60):
            deck = self._create(target_size)
            self.assertEqual(deck.target_size, target_size)
            self.assertEqual(deck.status, "under")
            self.assertEqual(deck.remaining_to_target, target_size)

    def test_invalid_target_size_is_rejected(self):
        with self.assertRaises(ValidationError):
            DeckCreate(name="Invalid", target_size=30)

    def test_rename_and_change_target_size_preserves_entries(self):
        self._own(self.card.id, 2)
        deck = self._create(20)
        updated = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=2), current_user=self.user, db=self.db)
        updated = update_deck(deck.id, DeckUpdate(name="Renamed", target_size=40), current_user=self.user, db=self.db)
        self.assertEqual(updated.name, "Renamed")
        self.assertEqual(updated.target_size, 40)
        self.assertEqual(updated.current_card_count, 2)
        self.assertEqual(len(updated.entries), 1)

    def test_entry_quantity_counts_ownership_and_shortage(self):
        self._own(self.card.id, 1, variant="Normal")
        self._own(self.card.id, 2, variant="Reverse Holo", condition="LP")
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=4), current_user=self.user, db=self.db)
        entry = result.entries[0]
        self.assertEqual(result.current_card_count, 4)
        self.assertEqual(entry.owned_quantity, 3)
        self.assertEqual(entry.shortage, 1)
        self.assertEqual(result.missing_copy_count, 1)

    def test_existing_entry_can_exceed_ownership(self):
        self._own(self.card.id, 1)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=1), current_user=self.user, db=self.db)
        result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=7), current_user=self.user, db=self.db)
        self.assertEqual(result.entries[0].required_quantity, 7)
        self.assertEqual(result.entries[0].shortage, 6)

    def test_remove_entry_and_delete_deck_cascade_entries(self):
        self._own(self.card.id, 2)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=2), current_user=self.user, db=self.db)
        delete_deck_entry(deck.id, result.entries[0].id, current_user=self.user, db=self.db)
        self.assertEqual(self.db.query(DeckEntry).count(), 0)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id), current_user=self.user, db=self.db)
        delete_deck(deck.id, current_user=self.user, db=self.db)
        self.assertEqual(self.db.query(Deck).count(), 0)
        self.assertEqual(self.db.query(DeckEntry).count(), 0)

    def test_other_user_cannot_access_deck_or_entry(self):
        self._own(self.card.id, 1)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id), current_user=self.user, db=self.db)
        with self.assertRaises(HTTPException) as access:
            get_deck(deck.id, current_user=self.other_user, db=self.db)
        self.assertEqual(access.exception.status_code, 404)
        with self.assertRaises(HTTPException) as entry_access:
            update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=2), current_user=self.other_user, db=self.db)
        self.assertEqual(entry_access.exception.status_code, 404)

    def test_duplicate_copies_entries_but_not_assembly_progress(self):
        self._own(self.card.id, 4)
        deck = self._create(40)
        original = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=4), current_user=self.user, db=self.db)
        update_deck_assembly_progress(deck.id, DeckAssemblyProgressUpdate(entry_id=original.entries[0].id, pulled_quantity=2), current_user=self.user, db=self.db)
        copied = duplicate_deck(deck.id, current_user=self.user, db=self.db)
        self.assertNotEqual(copied.id, deck.id)
        self.assertEqual((copied.target_size, copied.format, copied.entries[0].required_quantity), (40, deck.format or "Casual", 4))
        self.assertEqual(get_deck_assembly_progress(copied.id, current_user=self.user, db=self.db), [])
        update_deck_entry(copied.id, copied.entries[0].id, DeckEntryUpdate(required_quantity=3), current_user=self.user, db=self.db)
        self.assertEqual(get_deck(deck.id, current_user=self.user, db=self.db).entries[0].required_quantity, 4)

    def test_other_user_cannot_duplicate_deck(self):
        deck = self._create()
        with self.assertRaises(HTTPException) as access:
            duplicate_deck(deck.id, current_user=self.other_user, db=self.db)
        self.assertEqual(access.exception.status_code, 404)

    def test_other_user_cannot_compare_a_private_deck(self):
        left, right = self._create(), self._create()
        with self.assertRaises(HTTPException) as access:
            compare_owned_decks(left.id, right.id, current_user=self.other_user, db=self.db)
        self.assertEqual(access.exception.status_code, 404)

    def test_basic_energy_is_excluded_from_copy_limit_warning(self):
        self._own(self.card.id, 6)
        self._own(self.energy.id, 6)
        deck = self._create()
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=5), current_user=self.user, db=self.db)
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.energy.id, required_quantity=5), current_user=self.user, db=self.db)
        self.assertEqual(result.copy_limit_warnings[0].name, "Pikachu ex")
        self.assertEqual(len(result.copy_limit_warnings), 1)

    def test_basic_energy_is_excluded_while_non_basic_cards_warn(self):
        for card in (self.grass_energy, self.ultra_ball, self.virizion):
            self._own(card.id, 14)
        deck = self._create(40)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.grass_energy.id, required_quantity=14), current_user=self.user, db=self.db)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.ultra_ball.id, required_quantity=5), current_user=self.user, db=self.db)
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.virizion.id, required_quantity=5), current_user=self.user, db=self.db)
        self.assertEqual([(warning.name, warning.quantity) for warning in result.copy_limit_warnings], [("Ultra Ball", 5), ("Virizion", 5)])

    def test_over_target_quantity_changes_remain_loadable(self):
        self._own(self.card.id, 60)
        deck = self._create(40)
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=39), current_user=self.user, db=self.db)
        for quantity in (40, 41, 42, 41, 40, 39):
            result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=quantity), current_user=self.user, db=self.db)
            self.assertEqual(result.current_card_count, quantity)
        result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=55), current_user=self.user, db=self.db)
        result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=56), current_user=self.user, db=self.db)
        self.assertEqual(result.current_card_count, 56)
        result = update_deck_entry(deck.id, result.entries[0].id, DeckEntryUpdate(required_quantity=55), current_user=self.user, db=self.db)
        self.assertEqual(result.current_card_count, 55)
        self.assertEqual(get_deck(deck.id, current_user=self.user, db=self.db).current_card_count, 55)

    def test_list_includes_composition_summary_without_entries(self):
        for card in (self.card, self.ultra_ball, self.energy):
            self._own(card.id, 20)
        deck = self._create(40)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=8), current_user=self.user, db=self.db)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.ultra_ball.id, required_quantity=10), current_user=self.user, db=self.db)
        add_deck_entry(deck.id, DeckEntryCreate(card_id=self.energy.id, required_quantity=6), current_user=self.user, db=self.db)
        listed = get_decks(current_user=self.user, db=self.db)[0]
        self.assertEqual(listed.composition_counts, {"Pokemon": 8, "Trainer": 10, "Energy": 6, "Other": 0})
        self.assertEqual(listed.entries, [])

    def test_assembly_progress_is_clamped_to_owned_copies_and_resets_without_changing_deck(self):
        self._own(self.card.id, 3)
        deck = self._create()
        result = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id, required_quantity=4), current_user=self.user, db=self.db)
        entry = result.entries[0]
        saved = update_deck_assembly_progress(deck.id, DeckAssemblyProgressUpdate(entry_id=entry.id, pulled_quantity=9), current_user=self.user, db=self.db)
        self.assertEqual(saved.pulled_quantity, 3)
        saved = update_deck_assembly_progress(deck.id, DeckAssemblyProgressUpdate(entry_id=entry.id, pulled_quantity=0), current_user=self.user, db=self.db)
        self.assertEqual(saved.pulled_quantity, 0)
        self.assertEqual(get_deck_assembly_progress(deck.id, current_user=self.user, db=self.db)[0].pulled_quantity, 0)
        reset_deck_assembly_progress(deck.id, current_user=self.user, db=self.db)
        self.assertEqual(self.db.query(DeckAssemblyProgress).count(), 0)
        self.assertEqual(get_deck(deck.id, current_user=self.user, db=self.db).entries[0].required_quantity, 4)
        self.assertEqual(self.db.query(CollectionItem).filter(CollectionItem.card_id == self.card.id).first().quantity, 3)

    def test_other_user_cannot_read_or_update_assembly_progress(self):
        self._own(self.card.id, 1)
        deck = self._create()
        entry = add_deck_entry(deck.id, DeckEntryCreate(card_id=self.card.id), current_user=self.user, db=self.db).entries[0]
        with self.assertRaises(HTTPException) as access:
            get_deck_assembly_progress(deck.id, current_user=self.other_user, db=self.db)
        self.assertEqual(access.exception.status_code, 404)
        with self.assertRaises(HTTPException) as update_access:
            update_deck_assembly_progress(deck.id, DeckAssemblyProgressUpdate(entry_id=entry.id, pulled_quantity=1), current_user=self.other_user, db=self.db)
        self.assertEqual(update_access.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
