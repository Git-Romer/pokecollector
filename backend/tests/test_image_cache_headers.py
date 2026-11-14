import hashlib
import unittest
from unittest.mock import MagicMock, patch

try:
    from fastapi import Request
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.images import get_card_image, get_set_image, _card_back_response, _set_fallback_response
    from database import Base
    from models import Card, Set, Setting
    from fastapi import HTTPException

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


def _make_request(headers=None):
    scope = {
        "type": "http",
        "method": "GET",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()],
    }
    return Request(scope)


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy not installed in this environment")
class ImageCacheHeadersTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        # Enable English sync language
        self.db.add(Setting(key="tcgdex_sync_languages", value="en"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    @patch("api.images._get_or_fetch", return_value=(b"card-image-bytes", "image/webp"))
    def test_card_image_returns_bounded_cache_control_and_content_etag(self, mock_fetch):
        card = Card(
            id="sv1-1_en",
            name="Bulbasaur",
            images_small="https://assets.example.test/sv1-1_small.webp",
            images_large="https://assets.example.test/sv1-1_large.webp",
            lang="en",
        )
        self.db.add(card)
        self.db.commit()

        expected_hash = hashlib.sha256(b"card-image-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'

        response = get_card_image("sv1-1_en", "small", db=self.db)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b"card-image-bytes")
        self.assertEqual(response.headers["cache-control"], "public, max-age=0, s-maxage=60, must-revalidate")
        self.assertEqual(response.headers["etag"], expected_etag)

    @patch("api.images._get_or_fetch", return_value=(b"card-image-bytes", "image/webp"))
    def test_card_image_returns_304_when_if_none_match_matches(self, mock_fetch):
        card = Card(
            id="sv1-1_en",
            name="Bulbasaur",
            images_small="https://assets.example.test/sv1-1_small.webp",
            images_large="https://assets.example.test/sv1-1_large.webp",
            lang="en",
        )
        self.db.add(card)
        self.db.commit()

        expected_hash = hashlib.sha256(b"card-image-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'
        request = _make_request({"if-none-match": expected_etag})

        response = get_card_image("sv1-1_en", "small", request=request, db=self.db)

        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.body, b"")
        self.assertEqual(response.headers["etag"], expected_etag)
        self.assertEqual(response.headers["cache-control"], "public, max-age=0, s-maxage=60, must-revalidate")
        # The validator must describe the actual representation, not just its URL.
        mock_fetch.assert_called_once()

    @patch("api.images._get_or_fetch", return_value=(b"card-image-bytes", "image/webp"))
    def test_card_image_accepts_weak_etag_and_comma_separated_if_none_match(self, mock_fetch):
        card = Card(
            id="sv1-1_en",
            name="Bulbasaur",
            images_small="https://assets.example.test/sv1-1_small.webp",
            images_large="https://assets.example.test/sv1-1_large.webp",
            lang="en",
        )
        self.db.add(card)
        self.db.commit()

        expected_hash = hashlib.sha256(b"card-image-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'
        weak_header = f'W/"other-etag", W/{expected_etag}'
        request = _make_request({"if-none-match": weak_header})

        response = get_card_image("sv1-1_en", "small", request=request, db=self.db)

        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.headers["etag"], expected_etag)
        mock_fetch.assert_called_once()

    @patch("api.images._get_or_fetch_custom_image", return_value=(b"custom-card-bytes", "image/png"))
    def test_custom_card_image_is_not_stored_in_shared_or_browser_cache(self, mock_custom_fetch):
        card = Card(
            id="custom-1_en",
            name="Custom Card",
            is_custom=True,
            images_small="https://assets.example.test/custom_small.png",
            images_large="https://assets.example.test/custom_large.png",
            lang="en",
        )
        self.db.add(card)
        self.db.commit()

        expected_hash = hashlib.sha256(b"custom-card-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'

        response = get_card_image("custom-1_en", "small", db=self.db)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b"custom-card-bytes")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["etag"], expected_etag)

    @patch("api.images._get_or_fetch", return_value=(b"set-logo-bytes", "image/png"))
    def test_set_image_returns_bounded_cache_control_and_content_etag(self, mock_fetch):
        s = Set(
            id="sv1_en",
            tcg_set_id="sv1",
            name="Scarlet & Violet",
            images_logo="https://assets.example.test/sv1_logo.png",
            lang="en",
        )
        self.db.add(s)
        self.db.commit()

        expected_hash = hashlib.sha256(b"set-logo-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'

        response = get_set_image("sv1_en", "logo", db=self.db)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.body, b"set-logo-bytes")
        self.assertEqual(response.headers["cache-control"], "public, max-age=0, s-maxage=60, must-revalidate")
        self.assertEqual(response.headers["etag"], expected_etag)

    @patch("api.images._get_or_fetch", return_value=(b"set-logo-bytes", "image/png"))
    def test_set_image_returns_304_when_if_none_match_matches(self, mock_fetch):
        s = Set(
            id="sv1_en",
            tcg_set_id="sv1",
            name="Scarlet & Violet",
            images_logo="https://assets.example.test/sv1_logo.png",
            lang="en",
        )
        self.db.add(s)
        self.db.commit()

        expected_hash = hashlib.sha256(b"set-logo-bytes").hexdigest()
        expected_etag = f'"{expected_hash}"'
        request = _make_request({"if-none-match": expected_etag})

        response = get_set_image("sv1_en", "logo", request=request, db=self.db)

        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.body, b"")
        self.assertEqual(response.headers["etag"], expected_etag)
        self.assertEqual(response.headers["cache-control"], "public, max-age=0, s-maxage=60, must-revalidate")
        mock_fetch.assert_called_once()

    def test_card_back_fallback_redirect_has_cache_control(self):
        resp = _card_back_response()
        self.assertEqual(resp.status_code, 307)
        self.assertEqual(resp.headers["cache-control"], "no-store")
        self.assertEqual(resp.headers["location"], "/cardback.jpg")

    def test_set_fallback_response_is_not_cached(self):
        resp = _set_fallback_response()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["cache-control"], "no-store")


    @patch("api.images._get_or_fetch")
    def test_same_url_with_replaced_bytes_does_not_return_a_false_304(self, fetch):
        self.db.add(Card(id="changed_en", name="Changed", lang="en", images_small="https://assets.example.test/same.webp"))
        self.db.commit()
        fetch.side_effect = [(b"old-art", "image/webp"), (b"new-art", "image/webp")]
        first = get_card_image("changed_en", "small", db=self.db)
        second = get_card_image("changed_en", "small", request=_make_request({"if-none-match": first.headers["etag"]}), db=self.db)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.body, b"new-art")
        self.assertNotEqual(first.headers["etag"], second.headers["etag"])

    @patch("api.images._get_or_fetch")
    def test_matching_validator_cannot_hide_an_upstream_failure(self, fetch):
        self.db.add(Card(id="failed_en", name="Failed", lang="en", images_small="https://assets.example.test/fail.webp"))
        self.db.commit()
        url_etag = '"' + hashlib.sha1(b"https://assets.example.test/fail.webp").hexdigest() + '"'
        fetch.side_effect = HTTPException(status_code=502, detail="unavailable")
        response = get_card_image("failed_en", "small", request=_make_request({"if-none-match": url_etag}), db=self.db)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["cache-control"], "no-store")

    @patch("api.images._client.get")
    def test_set_artwork_url_change_does_not_reuse_the_previous_blob(self, get):
        artwork = Set(id="changed_en", tcg_set_id="changed", name="Changed", lang="en", images_logo="https://assets.example.test/old.png")
        self.db.add(artwork)
        self.db.commit()
        def upstream(url):
            response = MagicMock()
            response.headers = {"content-type": "image/png"}
            response.content = url.encode()
            return response
        get.side_effect = upstream
        first = get_set_image("changed_en", "logo", db=self.db)
        artwork.images_logo = "https://assets.example.test/new.png"
        self.db.commit()
        second = get_set_image("changed_en", "logo", db=self.db)
        self.assertNotEqual(first.body, second.body)
        self.assertEqual(second.body, b"https://assets.example.test/new.png")
        self.assertEqual(get.call_count, 2)

    @patch("api.images._get_or_fetch_custom_image", return_value=(b"fallback", "image/png"))
    def test_manual_fallback_on_catalogue_card_is_private(self, fetch):
        self.db.add(Card(id="fallback_en", name="Fallback", lang="en", custom_image_url="https://assets.example.test/custom.png"))
        self.db.commit()
        response = get_card_image("fallback_en", "large", db=self.db)
        self.assertEqual(response.headers["cache-control"], "private, no-store")

    @patch("api.images._get_or_fetch")
    def test_hidden_language_cannot_be_retrieved_with_an_old_validator(self, fetch):
        self.db.add(Card(id="hidden_fr", name="Hidden", lang="fr", images_small="https://assets.example.test/hidden.webp"))
        self.db.commit()
        with self.assertRaises(HTTPException) as context:
            get_card_image("hidden_fr", "small", request=_make_request({"if-none-match": "*"}), db=self.db)
        self.assertEqual(context.exception.status_code, 404)
        fetch.assert_not_called()

    @patch("api.images._get_or_fetch", return_value=(b"card-image-bytes", "image/webp"))
    def test_wildcard_validator_and_nonmatching_validator(self, fetch):
        self.db.add(Card(id="wild_en", name="Wildcard", lang="en", images_small="https://assets.example.test/wild.webp"))
        self.db.commit()
        matched = get_card_image("wild_en", "small", request=_make_request({"if-none-match": "*"}), db=self.db)
        missed = get_card_image("wild_en", "small", request=_make_request({"if-none-match": '"different"'}), db=self.db)
        self.assertEqual(matched.status_code, 304)
        self.assertEqual(missed.status_code, 200)
        self.assertEqual(missed.body, b"card-image-bytes")


    @patch("api.images._get_or_fetch_custom_image")
    def test_clearing_custom_fallback_removes_its_cached_bytes(self, fetch):
        from types import SimpleNamespace
        from api.cards import update_card_custom_image
        from models import ImageCache
        from schemas import CardCustomImageUpdate

        self.db.add(Card(id="clear_en", name="Clear", lang="en", custom_image_url="https://assets.example.test/custom.png"))
        self.db.add(ImageCache(image_key="unrelated", data=b"keep", content_type="image/png"))
        self.db.commit()
        def save_fixture(db, key, url, **kwargs):
            db.add(ImageCache(image_key=key, data=b"private-art", content_type="image/png"))
            db.commit()
            return b"private-art", "image/png"
        fetch.side_effect = save_fixture
        get_card_image("clear_en", "large", db=self.db)
        self.assertEqual(self.db.query(ImageCache).count(), 2)
        update_card_custom_image("clear_en", CardCustomImageUpdate(custom_image_url=None), db=self.db, current_user=SimpleNamespace(id=1))
        self.assertEqual(self.db.query(ImageCache).count(), 1)
        self.assertEqual(self.db.query(ImageCache).one().image_key, "unrelated")


if __name__ == "__main__":
    unittest.main()
