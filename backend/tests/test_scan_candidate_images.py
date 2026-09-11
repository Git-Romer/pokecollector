import asyncio
import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from database import Base
    from models import ImageCache
    from services.scan_candidate_images import (
        CANDIDATE_IMAGE_MAX_BYTES,
        cache_key_for,
        fetch_and_cache_candidate_image,
        get_cached_candidate_image,
        prewarm_candidate_images,
        validate_candidate_image_url,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class ScanCandidateImagesTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_cache_key_is_stable_and_url_specific(self):
        first = cache_key_for("https://assets.tcgdex.net/en/x/1/1/high.webp")
        again = cache_key_for("https://assets.tcgdex.net/en/x/1/1/high.webp")
        other = cache_key_for("https://assets.tcgdex.net/en/x/1/2/high.webp")
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)
        self.assertTrue(first.startswith("scan-candidate:"))

    def test_candidate_url_only_accepts_the_tcgdex_https_cdn(self):
        allowed = "https://assets.tcgdex.net/en/base/base1/1/high.webp"
        self.assertEqual(validate_candidate_image_url(allowed), allowed)
        for rejected in (
            "http://assets.tcgdex.net/en/base/base1/1/high.webp",
            "https://assets.tcgdex.net.evil.test/card.webp",
            "https://example.test/card.webp",
            "https://user@assets.tcgdex.net/card.webp",
            "https://assets.tcgdex.net:8443/card.webp",
        ):
            with self.subTest(rejected=rejected):
                with self.assertRaises(ValueError):
                    validate_candidate_image_url(rejected)

    def test_get_cached_candidate_image_misses_when_not_stored(self):
        self.assertIsNone(
            get_cached_candidate_image(self.db, "https://assets.tcgdex.net/en/x/1/1/high.webp")
        )

    def test_fetch_and_cache_reads_back_a_stored_entry_without_fetching(self):
        url = "https://assets.tcgdex.net/en/x/1/1/high.webp"
        self.db.add(ImageCache(image_key=cache_key_for(url), data=b"stored", content_type="image/webp"))
        self.db.commit()

        with patch("services.scan_candidate_images.httpx.AsyncClient") as client_cls:
            result = asyncio.run(fetch_and_cache_candidate_image(self.db, url))
            client_cls.assert_not_called()

        self.assertEqual(result, (b"stored", "image/webp"))

    def test_fetch_and_cache_stores_a_fresh_download(self):
        url = "https://assets.tcgdex.net/en/x/1/1/high.webp"

        class FakeResponse:
            headers = {"content-type": "image/webp"}

            def raise_for_status(self):
                return None

            async def aiter_bytes(self):
                yield b"downloaded"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, _method, _url):
                return FakeResponse()

        with patch("services.scan_candidate_images.httpx.AsyncClient", return_value=FakeClient()):
            result = asyncio.run(fetch_and_cache_candidate_image(self.db, url))

        self.assertEqual(result, (b"downloaded", "image/webp"))
        stored = self.db.query(ImageCache).filter(ImageCache.image_key == cache_key_for(url)).first()
        self.assertIsNotNone(stored)
        self.assertEqual(stored.data, b"downloaded")

    def test_fetch_and_cache_returns_none_when_the_download_fails(self):
        class FailingClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, _method, _url):
                raise RuntimeError("network is down")

        with patch("services.scan_candidate_images.httpx.AsyncClient", return_value=FailingClient()):
            result = asyncio.run(
                fetch_and_cache_candidate_image(self.db, "https://assets.tcgdex.net/en/x/1/1/high.webp")
            )
        self.assertIsNone(result)

    def test_fetch_rejects_untrusted_urls_without_network_access(self):
        with patch("services.scan_candidate_images.httpx.AsyncClient") as client_cls:
            result = asyncio.run(
                fetch_and_cache_candidate_image(self.db, "https://example.test/card.webp")
            )
        self.assertIsNone(result)
        client_cls.assert_not_called()

    def test_fetch_rejects_non_images_and_oversized_images(self):
        class FakeResponse:
            def __init__(self, headers, chunks=(b"not-an-image",)):
                self.headers = headers
                self.chunks = chunks

            def raise_for_status(self):
                return None

            async def aiter_bytes(self):
                for chunk in self.chunks:
                    yield chunk

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class FakeClient:
            def __init__(self, response):
                self.response = response

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, _method, _url):
                return self.response

        url = "https://assets.tcgdex.net/en/x/1/1/high.webp"
        responses = (
            FakeResponse({}),
            FakeResponse({"content-type": "text/html"}),
            FakeResponse({
                "content-type": "image/webp",
                "content-length": str(CANDIDATE_IMAGE_MAX_BYTES + 1),
            }),
            FakeResponse(
                {"content-type": "image/webp"},
                (b"x" * CANDIDATE_IMAGE_MAX_BYTES, b"overflow"),
            ),
        )
        for response in responses:
            with self.subTest(headers=response.headers), patch(
                "services.scan_candidate_images.httpx.AsyncClient",
                return_value=FakeClient(response),
            ):
                self.assertIsNone(asyncio.run(fetch_and_cache_candidate_image(self.db, url)))
        self.assertEqual(self.db.query(ImageCache).count(), 0)

    def test_candidate_cache_prunes_old_entries(self):
        for number in (1, 2):
            url = f"https://assets.tcgdex.net/en/x/1/{number}/high.webp"
            self.db.add(ImageCache(
                image_key=cache_key_for(url),
                data=str(number).encode(),
                content_type="image/webp",
            ))
        self.db.commit()

        class FakeResponse:
            headers = {"content-type": "image/webp"}

            def raise_for_status(self):
                return None

            async def aiter_bytes(self):
                yield b"new"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, _method, _url):
                return FakeResponse()

        newest = "https://assets.tcgdex.net/en/x/1/3/high.webp"
        with patch("services.scan_candidate_images.CANDIDATE_IMAGE_CACHE_LIMIT", 2), patch(
            "services.scan_candidate_images.httpx.AsyncClient", return_value=FakeClient()
        ):
            result = asyncio.run(fetch_and_cache_candidate_image(self.db, newest))

        self.assertEqual(result, (b"new", "image/webp"))
        self.assertEqual(
            self.db.query(ImageCache).filter(ImageCache.image_key.like("scan-candidate:%")).count(),
            2,
        )
        self.assertIsNotNone(get_cached_candidate_image(self.db, newest))

    def test_prewarm_only_warms_the_top_candidates_and_skips_ones_without_an_image(self):
        candidates = [
            {"image_hd": "https://assets.tcgdex.net/en/x/1/1/high.webp"},
            {"image_hd": "https://assets.tcgdex.net/en/x/1/2/high.webp"},
            {"image_hd": "https://assets.tcgdex.net/en/x/1/3/high.webp"},
            {},
        ]
        warmed_urls = []

        async def fake_fetch(_db, url):
            warmed_urls.append(url)
            return b"x", "image/webp"

        with patch("database.SessionLocal", return_value=self.db), \
                patch("services.scan_candidate_images.fetch_and_cache_candidate_image", new=fake_fetch):
            warmed = asyncio.run(prewarm_candidate_images(candidates))

        self.assertEqual(warmed, 2)
        self.assertEqual(warmed_urls, [
            "https://assets.tcgdex.net/en/x/1/1/high.webp",
            "https://assets.tcgdex.net/en/x/1/2/high.webp",
        ])

    def test_prewarm_swallows_a_failure_on_one_candidate_and_keeps_going(self):
        candidates = [
            {"image_hd": "https://assets.tcgdex.net/en/x/1/1/high.webp"},
            {"image_hd": "https://assets.tcgdex.net/en/x/1/2/high.webp"},
        ]

        async def flaky_fetch(_db, url):
            if url.endswith("/1/high.webp"):
                raise RuntimeError("boom")
            return b"x", "image/webp"

        with patch("database.SessionLocal", return_value=self.db), \
                patch("services.scan_candidate_images.fetch_and_cache_candidate_image", new=flaky_fetch):
            warmed = asyncio.run(prewarm_candidate_images(candidates))

        self.assertEqual(warmed, 1)


if __name__ == "__main__":
    unittest.main()
