import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException, Response
import httpx

from api.community import (
    MAX_RESPONSE_BYTES,
    SupporterSnapshotError,
    fetch_public_supporters,
    get_supporters,
    router,
    validate_public_snapshot,
)


def snapshot(*supporters):
    return {"version": 1, "supporters": list(supporters)}


DEFAULT_SUPPORT = object()


def supporter(
    name="Example Trainer",
    url="https://example.org/profile",
    crown="gold",
    support=DEFAULT_SUPPORT,
):
    if support is DEFAULT_SUPPORT:
        support = {
            "total_amount_cents": 1000,
            "currency": "EUR",
            "donation_count": 1,
            "latest_supported_on": "2026-08-16",
        }
    return {"name": name, "url": url, "crown": crown, "support": support}


class SnapshotValidationTests(unittest.TestCase):
    def test_accepts_exact_v1_shape_and_sorts_only_after_validation(self):
        result = validate_public_snapshot(
            snapshot(
                supporter("Lower", crown=None, support=None),
                supporter("Highest", support={
                    "total_amount_cents": 2000,
                    "currency": "EUR",
                    "donation_count": 2,
                    "latest_supported_on": None,
                }),
            )
        )

        self.assertEqual([entry["name"] for entry in result], ["Highest", "Lower"])
        self.assertIsNone(result[1]["support"])

    def test_normalizes_empty_optional_values_to_null_like_the_registry_writer(self):
        result = validate_public_snapshot(snapshot(supporter(url="", support={
            "total_amount_cents": 1000,
            "currency": "EUR",
            "donation_count": 1,
            "latest_supported_on": "",
        })))
        self.assertIsNone(result[0]["url"])
        self.assertIsNone(result[0]["support"]["latest_supported_on"])

    def test_rejects_unknown_fields_at_every_level(self):
        invalid_values = [
            {**snapshot(), "metadata": {}},
            {"version": True, "supporters": []},
            snapshot({**supporter(), "internal_id": 1}),
            snapshot(supporter(support={
                "total_amount_cents": 1000,
                "currency": "EUR",
                "donation_count": 1,
                "latest_supported_on": None,
                "private_note": "no",
            })),
        ]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(SupporterSnapshotError):
                validate_public_snapshot(value)

    def test_rejects_duplicate_or_unsafe_names_and_urls(self):
        invalid_values = [
            snapshot(supporter("Trainer"), supporter(" trainer ", crown=None)),
            snapshot(supporter("=formula")),
            snapshot(supporter("unsafe\u202ename")),
            snapshot(supporter(url="http://example.org/profile")),
            snapshot(supporter(url="https://user:password@example.org/profile")),
            snapshot(supporter(url="https://127.0.0.1/profile")),
        ]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(SupporterSnapshotError):
                validate_public_snapshot(value)

    def test_rejects_invalid_numbers_dates_currency_and_crowns(self):
        base_support = {
            "total_amount_cents": 1000,
            "currency": "EUR",
            "donation_count": 1,
            "latest_supported_on": "2026-08-16",
        }
        invalid_changes = [
            {"total_amount_cents": True},
            {"total_amount_cents": -1},
            {"donation_count": 0},
            {"currency": "eur"},
            {"latest_supported_on": "2026-02-30"},
        ]
        for changes in invalid_changes:
            with self.subTest(changes=changes), self.assertRaises(SupporterSnapshotError):
                validate_public_snapshot(snapshot(supporter(support={**base_support, **changes})))
        with self.assertRaises(SupporterSnapshotError):
            validate_public_snapshot(snapshot(supporter(crown="platinum")))


class FetchSupportersTests(unittest.IsolatedAsyncioTestCase):
    async def _fetch(self, response: httpx.Response):
        async def handler(_request):
            return response

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_public_supporters(client)

    async def test_fetches_valid_json_without_redirects_or_fallbacks(self):
        response = httpx.Response(
            200,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store, max-age=0",
            },
            content=json.dumps(snapshot(supporter())).encode(),
        )
        result = await self._fetch(response)
        self.assertEqual(result[0]["name"], "Example Trainer")

    async def test_rejects_http_errors_wrong_content_type_and_malformed_json(self):
        responses = [
            httpx.Response(503, headers={"Content-Type": "application/json"}),
            httpx.Response(200, headers={"Content-Type": "text/html"}, text="{}"),
            httpx.Response(
                200,
                headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
                text="{",
            ),
            httpx.Response(200, headers={"Content-Type": "application/json"}, text="{}"),
            httpx.Response(
                200,
                headers={"Content-Type": "application/json", "Cache-Control": "x-no-store"},
                text="{}",
            ),
        ]
        for response in responses:
            with self.subTest(status=response.status_code, content_type=response.headers.get("content-type")):
                with self.assertRaises((httpx.HTTPError, SupporterSnapshotError)):
                    await self._fetch(response)

    async def test_rejects_oversized_body_before_json_parsing(self):
        response = httpx.Response(
            200,
            headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
            content=b" " * (MAX_RESPONSE_BYTES + 1),
        )
        with self.assertRaisesRegex(SupporterSnapshotError, "too large"):
            await self._fetch(response)

    async def test_route_returns_no_store_and_maps_any_failure_to_503(self):
        response = Response()
        with patch("api.community.fetch_public_supporters", AsyncMock(return_value=[])):
            self.assertEqual(await get_supporters(response), [])
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")

        with patch(
            "api.community.fetch_public_supporters",
            AsyncMock(side_effect=SupporterSnapshotError("invalid")),
        ):
            with self.assertRaises(HTTPException) as raised:
                await get_supporters(Response())
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.headers["Cache-Control"], "no-store, max-age=0")

    async def test_fastapi_route_exposes_only_validated_data_with_no_store(self):
        app = FastAPI()
        app.include_router(router, prefix="/api/community")
        transport = httpx.ASGITransport(app=app)
        with patch(
            "api.community.fetch_public_supporters",
            AsyncMock(return_value=[supporter()]),
        ):
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                response = await client.get("/api/community/supporters")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")
        self.assertEqual(response.json()[0]["name"], "Example Trainer")

        with patch(
            "api.community.fetch_public_supporters",
            AsyncMock(side_effect=SupporterSnapshotError("invalid")),
        ):
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                failed = await client.get("/api/community/supporters")
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.headers["cache-control"], "no-store, max-age=0")
        self.assertEqual(failed.json(), {"detail": "Supporter registry temporarily unavailable"})


if __name__ == "__main__":
    unittest.main()
