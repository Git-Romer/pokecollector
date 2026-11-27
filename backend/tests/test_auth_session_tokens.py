"""Session-token compatibility independent of the retired python-jose package."""
import ast
import base64
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import time
import unittest
from datetime import timedelta
from unittest.mock import patch

from joserfc.errors import JoseError

from services import auth


def signed_token(claims, key, algorithm="HS256"):
    """Produce the existing HS256 wire format without a JWT library."""
    def segment(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=")
    data = segment({"alg": algorithm, "typ": "JWT"}) + b"." + segment(claims)
    signature = hmac.new(key.encode(), data, hashlib.sha256).digest()
    return (data + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")).decode()


class SessionTokenTests(unittest.TestCase):
    def setUp(self):
        self.secret = secrets.token_urlsafe(48)
        self.key_patch = patch.object(auth, "SECRET_KEY", self.secret)
        self.key_patch.start()
        self.addCleanup(self.key_patch.stop)

    def test_retired_dependency_is_not_required_or_imported(self):
        backend = Path(__file__).resolve().parents[1]
        requirements = (backend / "requirements.txt").read_text()
        self.assertNotIn("python-jose", requirements)
        for path in [backend / "services/auth.py", backend / "api/auth.py"]:
            imports = [node.module for node in ast.walk(ast.parse(path.read_text())) if isinstance(node, ast.ImportFrom)]
            self.assertNotIn("jose", imports)

    def test_existing_session_wire_format_remains_valid(self):
        claims = {"sub": "12", "role": "admin", "exp": int(time.time()) + 3600}
        self.assertEqual(auth.decode_token(signed_token(claims, self.secret)), claims)

    def test_new_session_uses_same_signature_and_claims(self):
        data = {"sub": "12", "role": "user"}
        token = auth.create_access_token(data, timedelta(minutes=5))
        header, payload, signature = token.split(".")
        expected = base64.urlsafe_b64encode(hmac.new(self.secret.encode(), (header + "." + payload).encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(signature, expected)
        claims = auth.decode_token(token)
        self.assertEqual(claims["sub"], "12")
        self.assertEqual(claims["role"], "user")
        self.assertLessEqual(abs(claims["exp"] - int(time.time()) - 300), 2)
        self.assertEqual(data, {"sub": "12", "role": "user"})

    def test_default_session_lifetime_stays_seven_days(self):
        claims = auth.decode_token(auth.create_access_token({"sub": "12"}))
        self.assertLessEqual(abs(claims["exp"] - int(time.time()) - 604800), 2)

    def test_expired_session_is_rejected(self):
        with self.assertRaises(JoseError):
            auth.decode_token(signed_token({"sub": "12", "exp": int(time.time()) - 60}, self.secret))

    def test_not_yet_valid_session_is_rejected(self):
        with self.assertRaises(JoseError):
            auth.decode_token(signed_token({"sub": "12", "exp": int(time.time()) + 3600, "nbf": int(time.time()) + 600}, self.secret))

    def test_invalid_sessions_are_rejected(self):
        claims = {"sub": "12", "exp": int(time.time()) + 3600}
        for token in ["not-a-token", signed_token(claims, secrets.token_urlsafe(48)), signed_token(claims, self.secret, "HS512")]:
            with self.subTest(token_kind=token[:8]), self.assertRaises(JoseError):
                auth.decode_token(token)

    def test_unexpected_audience_is_rejected(self):
        with self.assertRaises(JoseError):
            auth.decode_token(signed_token({"sub": "12", "exp": int(time.time()) + 3600, "aud": "another-application"}, self.secret))


if __name__ == "__main__":
    unittest.main()
