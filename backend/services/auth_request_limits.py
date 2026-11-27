"""Bound password-login forms before framework parsing allocates their fields."""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

MAX_PASSWORD_LOGIN_BODY_BYTES = 8 * 1024


class PasswordLoginBodyLimitMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] not in ("/api/auth/login", "/api/auth/login/")
        ):
            return await self.app(scope, receive, send)

        async def reject():
            response = JSONResponse(
                {"detail": f"Login request body exceeds {MAX_PASSWORD_LOGIN_BODY_BYTES} bytes"},
                status_code=413,
                headers={"Cache-Control": "no-store"},
            )
            await response(scope, receive, send)

        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    oversized = int(value) > MAX_PASSWORD_LOGIN_BODY_BYTES
                except ValueError:
                    # The server validates framing; never trust this header as
                    # a substitute for counting the actual received bytes.
                    oversized = False
                if oversized:
                    return await reject()

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_PASSWORD_LOGIN_BODY_BYTES:
                return await reject()
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        pending = True

        async def replay():
            nonlocal pending
            if pending:
                pending = False
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)
