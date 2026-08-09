import unittest

try:
    from api.social import _card_payload
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip_without_deps = unittest.skipUnless(
    DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment"
)


class _StubCard:
    """A Card stand-in. Unset columns read as None rather than being listed
    here, so this does not need updating every time the serialiser grows."""

    def __init__(self, images_small=None, images_large=None, custom_image_url=None):
        self.id = "sv1-1"
        self.name = "Pikachu"
        self.number = "1"
        self.set_id = "sv1"
        self.lang = "en"
        self.rarity = "Rare"
        self.hp = "60"
        self.artist = "Ken Sugimori"
        self.types = ["Lightning"]
        self.supertype = "Pokémon"
        self.is_custom = False
        self.is_digital = False
        self.images_small = images_small
        self.images_large = images_large
        self.custom_image_url = custom_image_url
        self.price_market = 1.0
        self.price_trend = 1.0

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return None


@skip_without_deps
class LeaderboardCardDetailTests(unittest.TestCase):
    """The leaderboard and compare pages open the shared card modal, which
    renders rarity, HP, artist, types and supertype. The payload used to carry
    a name, a thumbnail, a price and a set id, so that modal opened blank."""

    def test_the_fields_the_modal_renders_are_present(self):
        payload = _card_payload(_StubCard())
        for field in ("rarity", "hp", "artist", "types", "supertype"):
            self.assertIn(field, payload, f"{field} missing - the overview renders it")
            self.assertIsNotNone(payload[field])

    def test_the_existing_fields_are_kept(self):
        # Both pages read name and price_market directly.
        payload = _card_payload(_StubCard())
        self.assertEqual(payload["name"], "Pikachu")
        self.assertIn("images_small", payload)
        self.assertIn("set_id", payload)

    def test_the_raw_custom_image_url_is_not_shared(self):
        # Someone else's card, and a user-supplied URL. Images resolve through
        # the card-id proxy, so the raw value never needs to travel.
        payload = _card_payload(_StubCard(custom_image_url="https://example.invalid/secret.png"))
        self.assertNotIn("custom_image_url", payload)
        self.assertNotIn("example.invalid", str(payload))

    def test_a_custom_image_fallback_is_still_signalled(self):
        payload = _card_payload(_StubCard(custom_image_url="https://example.invalid/a.png"))
        self.assertTrue(payload["has_custom_image_fallback"])

    def test_no_fallback_when_the_card_has_its_own_art(self):
        payload = _card_payload(
            _StubCard(images_small="x", custom_image_url="https://example.invalid/a.png")
        )
        self.assertFalse(payload["has_custom_image_fallback"])

    def test_a_missing_card_stays_none(self):
        self.assertIsNone(_card_payload(None))


if __name__ == "__main__":
    unittest.main()
