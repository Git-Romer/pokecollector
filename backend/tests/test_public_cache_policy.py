import asyncio
import unittest

try:
    from starlette.requests import Request
    from starlette.responses import Response

    from main import prevent_failed_public_response_caching

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _request(path: str) -> Request:
    return Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    })


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed")
class PublicCachePolicyTests(unittest.TestCase):
    def test_every_failed_public_api_response_is_no_store(self):
        async def call_next(_request):
            return Response(status_code=422)

        response = asyncio.run(
            prevent_failed_public_response_caching(
                _request("/api/public/profiles/ash/binders/not-an-id"),
                call_next,
            )
        )
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_non_public_failures_are_not_changed(self):
        async def call_next(_request):
            return Response(status_code=422)

        response = asyncio.run(
            prevent_failed_public_response_caching(
                _request("/api/settings/"),
                call_next,
            )
        )
        self.assertNotIn("Cache-Control", response.headers)

    def test_successful_public_cache_policy_is_preserved(self):
        async def call_next(_request):
            return Response(
                status_code=200,
                headers={"Cache-Control": "public, max-age=0, must-revalidate"},
            )

        response = asyncio.run(
            prevent_failed_public_response_caching(
                _request("/api/public/profiles"),
                call_next,
            )
        )
        self.assertEqual(
            response.headers["Cache-Control"],
            "public, max-age=0, must-revalidate",
        )


if __name__ == "__main__":
    unittest.main()
