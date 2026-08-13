import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

try:
    from jose import JWTError, jwt

    from services.auth import resolve_jwt_secret

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Backend dependencies are not installed in this lightweight test environment")
class JwtSecretResolutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.secret_file = os.path.join(self.tmp.name, "auth", "jwt_secret.key")

    def _env(self, **overrides):
        base = {"JWT_SECRET_FILE": self.secret_file}
        base.update(overrides)
        return base

    def test_empty_configured_secret_is_ignored_not_used(self):
        # docker-compose passes JWT_SECRET_KEY through as an empty string; the old code used
        # it verbatim, making the signing key "". It must be ignored instead.
        with patch.dict(os.environ, self._env(JWT_SECRET_KEY=""), clear=False):
            secret = resolve_jwt_secret()
        self.assertTrue(secret)
        self.assertNotEqual(secret, "")

    def test_token_forged_with_empty_key_is_rejected(self):
        with patch.dict(os.environ, self._env(JWT_SECRET_KEY=""), clear=False):
            secret = resolve_jwt_secret()
        forged = jwt.encode({"sub": "1", "role": "admin"}, "", algorithm="HS256")
        with self.assertRaises(JWTError):
            jwt.decode(forged, secret, algorithms=["HS256"])

    def test_configured_nonempty_secret_is_used_as_is(self):
        with patch.dict(os.environ, self._env(JWT_SECRET_KEY="  a-real-configured-secret  "), clear=False):
            secret = resolve_jwt_secret()
        # preserved verbatim (whitespace included) so operator-set values are honoured exactly
        self.assertEqual(secret, "  a-real-configured-secret  ")

    def test_unset_generates_and_persists_a_stable_key(self):
        env = self._env()
        env.pop("JWT_SECRET_KEY", None)
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            first = resolve_jwt_secret()
            self.assertTrue(os.path.exists(self.secret_file))
            second = resolve_jwt_secret()
        self.assertTrue(first)
        # survives "restart": a second resolution reads the same persisted key
        self.assertEqual(first, second)

    def test_concurrent_startup_uses_one_persisted_key(self):
        env = self._env()
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            with ThreadPoolExecutor(max_workers=8) as executor:
                secrets = list(executor.map(lambda _: resolve_jwt_secret(), range(16)))
        self.assertEqual(len(set(secrets)), 1)

    def test_empty_persisted_file_is_repaired(self):
        os.makedirs(os.path.dirname(self.secret_file), exist_ok=True)
        with open(self.secret_file, "w", encoding="utf-8"):
            pass
        env = self._env()
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            secret = resolve_jwt_secret()
        self.assertTrue(secret)
        with open(self.secret_file, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.read(), secret)

    def test_relative_secret_file_path_is_supported(self):
        old_cwd = os.getcwd()
        self.addCleanup(os.chdir, old_cwd)
        os.chdir(self.tmp.name)
        with patch.dict(os.environ, {"JWT_SECRET_FILE": "jwt.key"}, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            secret = resolve_jwt_secret()
        self.assertTrue(secret)
        self.assertTrue(os.path.exists("jwt.key"))

    def test_persisted_key_file_is_not_world_readable(self):
        env = self._env()
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            resolve_jwt_secret()
        mode = os.stat(self.secret_file).st_mode & 0o777
        self.assertEqual(mode & 0o077, 0, f"secret file mode was {oct(mode)}")

    def test_unwritable_location_falls_back_to_ephemeral_not_empty(self):
        with patch.dict(os.environ, {"JWT_SECRET_FILE": "/proc/nonexistent/jwt.key"}, clear=False):
            os.environ.pop("JWT_SECRET_KEY", None)
            secret = resolve_jwt_secret()
        self.assertTrue(secret)
        self.assertNotEqual(secret, "")


if __name__ == "__main__":
    unittest.main()
