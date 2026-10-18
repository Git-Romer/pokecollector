"""Visual verification may only select a candidate whose decoded reference
image was sent to the model, and reference images are sent with their real
image type.
"""

import io
import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    from api.recognize import _reference_image_mime, match_card_info
    from services.scan_candidate_images import validate_candidate_image_url
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


def image_bytes(image_format):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (8, 11), (200, 30, 30)).save(out, image_format)
    return out.getvalue()


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class ReferenceImageTests(unittest.TestCase):
    def test_mime_type_follows_the_decoded_image(self):
        self.assertEqual(_reference_image_mime(image_bytes("PNG")), "image/png")
        self.assertEqual(_reference_image_mime(image_bytes("JPEG")), "image/jpeg")
        self.assertEqual(_reference_image_mime(image_bytes("WEBP")), "image/webp")

    def test_undecodable_or_unknown_content_is_rejected(self):
        self.assertIsNone(_reference_image_mime(b"\x89PNG\r\n\x1a\ntruncated"))
        self.assertIsNone(_reference_image_mime(b"<svg xmlns='http://www.w3.org/2000/svg'/>"))
        self.assertIsNone(_reference_image_mime(None))

    def test_candidate_cache_accepts_only_trusted_https_hosts(self):
        url = "https://assets.tcgdex.net/en/swsh/swsh11/TG06/high.webp"
        self.assertEqual(validate_candidate_image_url(url), url)
        for bad in ("http://assets.tcgdex.net/x.webp", "https://example.com/x.png",
                    "https://assets.tcgdex.net:8443/x.webp", "https://user@assets.tcgdex.net/x.webp"):
            with self.assertRaises(ValueError):
                validate_candidate_image_url(bad)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "backend dependencies are not installed")
class UnseenCandidateTests(unittest.IsolatedAsyncioTestCase):
    async def match(self, images):
        candidates = [{"id": "first", "number": None, "image": "https://assets.tcgdex.net/a.webp"},
                      {"id": "second", "number": None, "image": "https://assets.tcgdex.net/b.webp"}]
        provider = Mock()
        provider.name, provider.is_gemini = "openai", False
        provider.requires_credential.return_value = False
        provider.generate_text = AsyncMock(return_value=("2", None))
        self.provider = provider
        with patch("api.recognize._search_and_rank_candidates", new=AsyncMock(return_value=(candidates, 0))), \
                patch("api.recognize._download_candidate_images", new=AsyncMock(return_value=images)), \
                patch("api.recognize._phash_best_match", return_value=None):
            return await match_card_info(object(), {"name": "Dedenne"}, image_b64="cGhvdG8=",
                                         mime_type="image/jpeg", allow_visual_verification=True,
                                         provider=provider, request_timeout_seconds=60)

    async def test_pick_of_an_unseen_candidate_is_not_a_decision(self):
        self.assertFalse((await self.match({"first": image_bytes("PNG")}))["_identity_confident"])

    async def test_pick_of_an_undecodable_candidate_is_not_a_decision(self):
        result = await self.match({"first": image_bytes("PNG"), "second": b"not an image"})
        self.assertFalse(result["_identity_confident"])

    async def test_pick_of_a_seen_candidate_decides_and_sends_real_types(self):
        result = await self.match({"first": image_bytes("PNG"), "second": image_bytes("JPEG")})
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], "second")
        sent = [part["image"]["mime_type"] for part in self.provider.generate_text.await_args.args[2]
                if "image" in part]
        self.assertEqual(sent, ["image/jpeg", "image/png", "image/jpeg"])


if __name__ == "__main__":
    unittest.main()
