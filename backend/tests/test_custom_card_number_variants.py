import unittest
from unittest.mock import call, patch

from services.card_numbers import (
    candidate_card_ids,
    card_number_variants,
    number_matches_candidate,
    printed_number_variants,
)

DEPS_AVAILABLE = True
try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, CustomCardMatch, User
    from services.sync_service import check_custom_card_matches
except ModuleNotFoundError:  # pragma: no cover
    DEPS_AVAILABLE = False


class CustomCardNumberVariantTests(unittest.TestCase):
    """TCGdex pads localId inconsistently, so one literal id is not enough."""

    def test_padded_and_unpadded_are_both_offered(self):
        # The reason this exists. Against the live catalogue today:
        #   me02-12  -> 404      me02-012 -> 200
        #   base1-4  -> 200      base1-004 -> 404
        # so a verbatim id misses in one direction or the other depending on
        # the set, and both forms have to be tried.
        self.assertEqual(candidate_card_ids("me02", "12"), ["me02-12", "me02-012"])
        self.assertIn("base1-4", candidate_card_ids("base1", "004"))

    def test_a_number_still_carrying_its_set_total_is_usable(self):
        # Manually entered cards often keep the printed "001/093" form.
        self.assertEqual(candidate_card_ids("B2a", "001/093"), ["B2a-001", "B2a-1"])

    def test_zero_is_offered_in_literal_unpadded_and_common_padded_forms(self):
        self.assertEqual(card_number_variants(0), ["0", "000"])
        self.assertEqual(candidate_card_ids("set", "000"), ["set-000", "set-0"])
        self.assertTrue(number_matches_candidate("000", "0"))

    def test_a_suffix_is_never_dropped(self):
        # 74a and 74 are different, real cards. Reducing one to the other would
        # silently match the wrong card, which is worse than not matching.
        self.assertEqual(printed_number_variants("74a/102"), ["74a"])
        self.assertNotIn("74", card_number_variants("74a"))

    def test_a_prefixed_number_survives(self):
        self.assertEqual(printed_number_variants("TG01/TG30"), ["TG01"])

    def test_a_candidate_is_confirmed_rather_than_trusted(self):
        # An id resolving is not proof it is the right card.
        self.assertTrue(number_matches_candidate("12", "012"))
        self.assertTrue(number_matches_candidate("012", "12"))
        self.assertFalse(number_matches_candidate("74a", "74"))
        self.assertFalse(number_matches_candidate("74", "74a"))

    def test_malformed_input_yields_nothing_rather_than_a_wrong_guess(self):
        self.assertEqual(candidate_card_ids("me02", ""), [])
        self.assertEqual(candidate_card_ids("", "12"), [])
        self.assertEqual(printed_number_variants("12/34/56"), [])

    def test_an_absent_local_id_is_not_treated_as_a_contradiction(self):
        # Some catalogue payloads carry no localId. The id we asked for is
        # itself the constraint, so an absent field must not veto the match;
        # only a present and mismatched one should.
        self.assertFalse(number_matches_candidate("12", None))
        self.assertFalse(number_matches_candidate("12", ""))

    def test_the_candidate_list_stays_short(self):
        # Each candidate is one catalogue request, so the list must not grow.
        for number in ("12", "012", "74a", "TG01", "001/093"):
            self.assertLessEqual(len(candidate_card_ids("set", number)), 3, number)


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class CustomCardMatchCandidateTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.owner = User(username="owner", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.owner)
        self.db.commit()
        self.db.refresh(self.owner)

    def tearDown(self):
        self.db.close()

    def _custom_card(self, set_id: str, number: str, *, lang: str = "en") -> Card:
        card = Card(
            id=f"custom-{set_id}-{number}",
            name="Manual card",
            set_id=set_id,
            number=number,
            is_custom=True,
            custom_owner_id=self.owner.id,
            lang=lang,
        )
        self.db.add(card)
        self.db.commit()
        return card

    def _stored_match(self, card: Card) -> CustomCardMatch | None:
        return self.db.query(CustomCardMatch).filter(
            CustomCardMatch.custom_card_id == card.id,
        ).one_or_none()

    def test_sync_tries_literal_then_padded_and_records_the_resolved_id(self):
        card = self._custom_card("me02", "12", lang="de")

        with (
            patch(
                "services.sync_service.pokemon_api.get_card",
                side_effect=[None, {"id": "me02-012", "localId": "012"}],
            ) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True) as send_message,
        ):
            check_custom_card_matches(self.db)

        self.assertEqual(
            get_card.call_args_list,
            [call("me02-12", lang="de"), call("me02-012", lang="de")],
        )
        match = self._stored_match(card)
        self.assertIsNotNone(match)
        self.assertEqual(match.api_card_id, "me02-012")
        self.assertEqual(match.status, "pending")
        send_message.assert_called_once()
        self.assertEqual(send_message.call_args.kwargs["user_id"], self.owner.id)

    def test_sync_tries_unpadded_id_when_literal_padded_id_is_absent(self):
        card = self._custom_card("base1", "004")

        with (
            patch(
                "services.sync_service.pokemon_api.get_card",
                side_effect=[None, {"id": "base1-4", "localId": "4"}],
            ) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True),
        ):
            check_custom_card_matches(self.db)

        self.assertEqual(
            get_card.call_args_list,
            [call("base1-004", lang="en"), call("base1-4", lang="en")],
        )
        self.assertEqual(self._stored_match(card).api_card_id, "base1-4")

    def test_sync_drops_printed_total_and_stops_after_the_first_match(self):
        card = self._custom_card("B2a", "001/093")

        with (
            patch(
                "services.sync_service.pokemon_api.get_card",
                return_value={"id": "B2a-001", "localId": "001"},
            ) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True),
        ):
            check_custom_card_matches(self.db)

        get_card.assert_called_once_with("B2a-001", lang="en")
        self.assertEqual(self._stored_match(card).api_card_id, "B2a-001")

    def test_sync_rejects_a_wrong_number_then_accepts_a_valid_candidate(self):
        card = self._custom_card("me02", "12")

        with (
            patch(
                "services.sync_service.pokemon_api.get_card",
                side_effect=[
                    {"id": "me02-999", "localId": "999"},
                    {"id": "me02-012", "localId": "012"},
                ],
            ) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True),
        ):
            check_custom_card_matches(self.db)

        self.assertEqual(get_card.call_count, 2)
        self.assertEqual(self._stored_match(card).api_card_id, "me02-012")

    def test_sync_never_drops_a_suffix_to_force_a_match(self):
        card = self._custom_card("ecard2", "74a")

        with (
            patch(
                "services.sync_service.pokemon_api.get_card",
                return_value={"id": "ecard2-74", "localId": "74"},
            ) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True) as send_message,
        ):
            check_custom_card_matches(self.db)

        get_card.assert_called_once_with("ecard2-74a", lang="en")
        self.assertIsNone(self._stored_match(card))
        send_message.assert_not_called()

    def test_sync_request_count_is_bounded_when_every_candidate_is_absent(self):
        card = self._custom_card("set", "01")

        with (
            patch("services.sync_service.pokemon_api.get_card", return_value=None) as get_card,
            patch("services.sync_service.telegram.send_message", return_value=True) as send_message,
        ):
            check_custom_card_matches(self.db)

        self.assertEqual(
            get_card.call_args_list,
            [
                call("set-01", lang="en"),
                call("set-1", lang="en"),
                call("set-001", lang="en"),
            ],
        )
        self.assertIsNone(self._stored_match(card))
        send_message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
