"""Password-login request bounds must run before form parsing."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

import main
from services.auth_request_limits import (
    MAX_PASSWORD_LOGIN_BODY_BYTES,
    PasswordLoginBodyLimitMiddleware,
)


class PasswordLoginBodyLimitTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        # Each case owns its login budget; earlier cases must not make this
        # body-parsing check stop at the application's outer rate limiter.
        attempts = patch.object(main.app.state, "_login_attempts", {}, create=True)
        attempts.start()
        self.addCleanup(attempts.stop)

        async def login_handler(request):
            self.received.append(await request.body())
            return Response("accepted")

        self.route = Route("/api/auth/login", login_handler, methods=["POST"])
        main.app.router.routes.insert(0, self.route)
        self.addCleanup(main.app.router.routes.remove, self.route)
        self.client = TestClient(main.app, base_url="https://testserver")
        self.addCleanup(self.client.close)

    def test_oversized_login_forms_are_rejected_before_handler(self):
        for encoding in ("urlencoded", "multipart"):
            with self.subTest(encoding=encoding):
                oversized = "x" * (256 * 1024)
                if encoding == "urlencoded":
                    response = self.client.post(
                        "/api/auth/login",
                        data={"username": "synthetic", "password": oversized},
                    )
                else:
                    response = self.client.post(
                        "/api/auth/login",
                        files={
                            "username": (None, "synthetic"),
                            "password": (None, oversized),
                        },
                    )
                self.assertEqual(response.status_code, 413)
                self.assertEqual(response.headers.get("cache-control"), "no-store")
                self.assertEqual(self.received, [])


    def test_ordinary_login_forms_preserve_their_body(self):
        for encoding in ("urlencoded", "multipart"):
            with self.subTest(encoding=encoding):
                if encoding == "urlencoded":
                    response = self.client.post(
                        "/api/auth/login",
                        data={"username": "synthetic", "password": "synthetic"},
                    )
                else:
                    response = self.client.post(
                        "/api/auth/login",
                        files={
                            "username": (None, "synthetic"),
                            "password": (None, "synthetic"),
                        },
                    )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.received[-1], response.request.content)

    def test_exact_limit_is_accepted(self):
        body = b"x" * MAX_PASSWORD_LOGIN_BODY_BYTES
        response = self.client.post("/api/auth/login", content=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.received, [body])

    def test_large_non_login_upload_is_unchanged(self):
        route = Route("/synthetic-upload", self.route.endpoint, methods=["POST"])
        main.app.router.routes.insert(0, route)
        self.addCleanup(main.app.router.routes.remove, route)
        body = b"x" * (256 * 1024)
        response = self.client.post("/synthetic-upload", content=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.received, [body])

    def test_host_header_cannot_change_login_limit_scope(self):
        response = self.client.post(
            "/api/auth/login",
            content=b"x" * (MAX_PASSWORD_LOGIN_BODY_BYTES + 1),
            headers={"Host": "testserver/decoy#"},
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.received, [])


class StreamingPasswordLoginBodyLimitTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, chunks, *, headers=(), path="/api/auth/login"):
        incoming = iter(chunks)
        result = {"called": False, "body": bytearray(), "sent": [], "reads": 0}

        async def receive():
            result["reads"] += 1
            return next(incoming, {"type": "http.disconnect"})

        async def send(message):
            result["sent"].append(message)

        async def endpoint(scope, receive, send):
            result["called"] = True
            while True:
                message = await receive()
                result["body"].extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            await JSONResponse({"accepted": True})(scope, receive, send)

        scope = {"type": "http", "method": "POST", "path": path, "headers": headers}
        await PasswordLoginBodyLimitMiddleware(endpoint)(scope, receive, send)
        return result

    def request_chunk(self, body, *, more=False):
        return {"type": "http.request", "body": body, "more_body": more}

    def assert_rejected(self, result):
        self.assertFalse(result["called"])
        self.assertEqual(result["sent"][0]["status"], 413)
        self.assertIn((b"cache-control", b"no-store"), result["sent"][0]["headers"])

    async def test_chunked_request_without_length_is_bounded(self):
        result = await self.exercise(
            [
                self.request_chunk(b"x" * MAX_PASSWORD_LOGIN_BODY_BYTES, more=True),
                self.request_chunk(b"y"),
            ],
            headers=[(b"transfer-encoding", b"chunked")],
        )
        self.assert_rejected(result)
        self.assertEqual(result["reads"], 2)

    async def test_forged_small_content_length_does_not_bypass_limit(self):
        result = await self.exercise(
            [self.request_chunk(b"x" * (MAX_PASSWORD_LOGIN_BODY_BYTES + 1))],
            headers=[(b"content-length", b"1")],
        )
        self.assert_rejected(result)

    async def test_oversized_declared_length_is_rejected_without_reading(self):
        result = await self.exercise(
            [], headers=[(b"content-length", str(MAX_PASSWORD_LOGIN_BODY_BYTES + 1).encode())]
        )
        self.assert_rejected(result)
        self.assertEqual(result["reads"], 0)

    async def test_fragmented_valid_body_is_replayed_unchanged(self):
        result = await self.exercise(
            [
                self.request_chunk(b"username=synthetic&", more=True),
                self.request_chunk(b"", more=True),
                self.request_chunk(b"password=synthetic"),
            ]
        )
        self.assertTrue(result["called"])
        self.assertEqual(bytes(result["body"]), b"username=synthetic&password=synthetic")
        self.assertEqual(result["sent"][0]["status"], 200)

    async def test_disconnected_request_never_reaches_parser(self):
        result = await self.exercise(
            [self.request_chunk(b"partial", more=True), {"type": "http.disconnect"}]
        )
        self.assertFalse(result["called"])
        self.assertEqual(result["sent"], [])

    async def test_trailing_slash_cannot_bypass_limit(self):
        result = await self.exercise(
            [self.request_chunk(b"x" * (MAX_PASSWORD_LOGIN_BODY_BYTES + 1))],
            path="/api/auth/login/",
        )
        self.assert_rejected(result)


if __name__ == "__main__":
    unittest.main()
