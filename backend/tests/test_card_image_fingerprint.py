import hashlib
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.images import router as images_router
from database import Base, get_db
from models import Card, ImageCache, Set


class CardImageFingerprintTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.image_url = "https://assets.tcgdex.net/en/sv/sv01/1/high.webp"
        self.card = Card(
            id="sv1-1_en",
            tcg_card_id="sv1-1",
            name="Pikachu",
            set_id="sv1",
            lang="en",
            images_large=self.image_url,
        )
        self.db.add(Set(id="sv1_en", tcg_set_id="sv1", name="Set", lang="en"))
        self.db.add(self.card)
        self.db.flush()
        self.image_bytes = b"exact large image bytes"
        self.cache_key = (
            f"card:{self.card.id}:large:"
            f"{hashlib.sha1(self.image_url.encode('utf-8')).hexdigest()}"
        )
        self.db.add(ImageCache(
            image_key=self.cache_key,
            data=self.image_bytes,
            content_type="image/webp",
        ))
        self.db.commit()

        app = FastAPI()
        app.include_router(images_router, prefix="/api/images")
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_fingerprint_hashes_exact_large_proxy_cache_bytes(self):
        response = self.client.get("/api/images/card/sv1-1_en/fingerprint")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "tcgCardId": "sv1-1",
            "language": "en",
            "sha256": hashlib.sha256(self.image_bytes).hexdigest(),
        })
        self.assertEqual(response.headers["etag"], f'"{hashlib.sha256(self.image_bytes).hexdigest()}"')
        self.assertIn("max-age", response.headers["cache-control"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

        image = self.client.get("/api/images/card/sv1-1_en/large")
        self.assertEqual(image.content, self.image_bytes)
        self.assertEqual(image.headers["content-type"], "image/webp")

    def test_rejects_cross_language_fallback_artwork(self):
        self.card.image_source_lang = "de"
        self.db.commit()

        response = self.client.get("/api/images/card/sv1-1_en/fingerprint")

        self.assertEqual(response.status_code, 404)

    def test_fingerprint_supports_etag_revalidation(self):
        digest = hashlib.sha256(self.image_bytes).hexdigest()
        response = self.client.get(
            "/api/images/card/sv1-1_en/fingerprint",
            headers={"If-None-Match": f'"{digest}"'},
        )
        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.headers["etag"], f'"{digest}"')

    def test_rejects_cards_without_official_large_artwork_even_with_manual_fallback(self):
        self.card.images_large = None
        self.card.custom_image_url = "https://example.test/manual.webp"
        self.db.commit()

        response = self.client.get("/api/images/card/sv1-1_en/fingerprint")

        self.assertEqual(response.status_code, 404)

    def test_rejects_manual_cards_even_if_an_image_url_is_present(self):
        manual = Card(
            id="manual-card",
            tcg_card_id=None,
            name="Manual",
            lang="en",
            is_custom=True,
            custom_image_url="https://example.test/manual.webp",
        )
        self.db.add(manual)
        self.db.commit()

        response = self.client.get("/api/images/card/manual-card/fingerprint")

        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
