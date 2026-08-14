import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.settings import (
        ScannerConfigurationUpdate,
        _get_user_settings,
        _safe_endpoint_summary,
        _scanner_configuration,
        test_scanner_configuration as run_scanner_configuration_test,
        update_scanner_configuration,
        update_settings,
    )
    from database import Base
    from models import User, UserSetting
    from services.scan_providers import ScanProvider, get_provider
    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy are not installed in this environment")
class ScannerConfigurationTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="admin", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _rows(self):
        return {
            row.key: row.value
            for row in self.db.query(UserSetting).filter(UserSetting.user_id == self.user.id)
        }

    def test_default_installation_only_exposes_gemini(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OPENAI_SCANNER_ENABLED", None)
            config = _scanner_configuration(self.db, self.user.id)
        self.assertEqual([item["id"] for item in config["providers"]], ["gemini"])
        self.assertEqual(config["status"], "api_key_required")
        self.assertEqual(config["visual_verification"], "automatic")
        self.assertEqual(config["providers"][0]["endpoint_type"], "hosted")
        self.assertNotIn("administrator", config)

    def test_admin_gets_a_secret_free_server_summary(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_PROVIDER_LABEL": "  Local   Ollama  ",
            "OPENAI_BASE_URL": "https://user:password@vision.example.test:8443/v1?token=secret",
            "OPENAI_MODEL": "vision-default",
        }
        with patch.dict(os.environ, env):
            config = _scanner_configuration(self.db, self.user.id, is_admin=True)
        summary = config["administrator"]
        compatible = next(item for item in summary["providers"] if item["id"] == "openai")
        self.assertEqual(compatible["label"], "Local Ollama")
        self.assertEqual(compatible["endpoint"], "https://vision.example.test:8443")
        self.assertEqual(compatible["endpoint_type"], "custom")
        self.assertNotIn("password", repr(summary))
        self.assertNotIn("secret", repr(summary))

    def test_endpoint_summary_does_not_reflect_invalid_or_credential_data(self):
        self.assertEqual(_safe_endpoint_summary("not a URL"), "Configured endpoint")
        self.assertEqual(
            _safe_endpoint_summary("http://name:key@[2001:db8::1]:11434/v1?q=private#x"),
            "http://[2001:db8::1]:11434",
        )

    def test_enabled_provider_and_models_are_guided_by_admin_allowlist(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "vision-default",
            "OPENAI_ALLOWED_MODELS": "vision-fast,vision-accurate",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        with patch.dict(os.environ, env):
            config = _scanner_configuration(self.db, self.user.id)
        openai = next(item for item in config["providers"] if item["id"] == "openai")
        self.assertEqual(
            openai["models"], ["vision-default", "vision-fast", "vision-accurate"]
        )
        self.assertFalse(openai["requires_api_key"])
        self.assertEqual(openai["endpoint_type"], "custom")
        self.assertIsNone(openai["key_help_url"])

    def test_provider_model_and_key_are_saved_atomically_and_per_provider(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "vision-default",
            "OPENAI_ALLOWED_MODELS": "vision-fast",
            "OPENAI_BASE_URL": "https://api.openai.com/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai", model="vision-fast", api_key="secret-value"
        )
        with patch.dict(os.environ, env):
            result = update_scanner_configuration(request, self.db, self.user)
        rows = self._rows()
        self.assertEqual(rows["scanner_provider"], "openai")
        self.assertEqual(rows["scanner_model_openai"], "vision-fast")
        self.assertEqual(rows["openai_api_key"], "secret-value")
        self.assertNotIn("scanner_model_gemini", rows)
        self.assertNotIn("secret-value", repr(result))
        self.assertTrue(next(p for p in result["providers"] if p["id"] == "openai")["api_key_configured"])

    def test_disallowed_model_does_not_partially_change_configuration(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "allowed-model",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(provider="openai", model="made-up-model")
        with patch.dict(os.environ, env), self.assertRaises(HTTPException):
            update_scanner_configuration(request, self.db, self.user)
        self.assertEqual(self._rows(), {})

    def test_invalid_installation_model_blocks_runtime_scans(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "invalid model with spaces",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        self.db.add(
            UserSetting(user_id=self.user.id, key="scanner_provider", value="openai")
        )
        self.db.commit()
        with patch.dict(os.environ, env):
            config = _scanner_configuration(self.db, self.user.id)
            with self.assertRaises(HTTPException) as caught:
                get_provider(self.db, self.user.id)
        self.assertEqual(config["status"], "admin_setup_required")
        self.assertEqual(config["model"], "")
        self.assertEqual(caught.exception.status_code, 400)

    def test_whitespace_only_legacy_key_is_not_ready(self):
        self.db.add(
            UserSetting(user_id=self.user.id, key="gemini_api_key", value="   ")
        )
        self.db.commit()
        config = _scanner_configuration(self.db, self.user.id)
        self.assertEqual(config["status"], "api_key_required")
        self.assertFalse(config["providers"][0]["api_key_configured"])

    def test_connection_test_rejects_text_only_ok_response(self):
        request = ScannerConfigurationUpdate(
            provider="gemini", model="gemini-flash-latest", api_key="test-key"
        )
        with patch.object(
            ScanProvider,
            "generate_text",
            new=AsyncMock(return_value=("OK", None)),
        ), self.assertRaises(HTTPException) as caught:
            asyncio.run(run_scanner_configuration_test(request, self.db, self.user))
        self.assertEqual(caught.exception.status_code, 502)

    def test_connection_test_accepts_the_image_color(self):
        request = ScannerConfigurationUpdate(
            provider="gemini", model="gemini-flash-latest", api_key="test-key"
        )
        generate = AsyncMock(return_value=("MAGENTA", None))
        with patch.object(ScanProvider, "generate_text", new=generate):
            result = asyncio.run(
                run_scanner_configuration_test(request, self.db, self.user)
            )
        self.assertEqual(result, {"status": "ready"})
        parts = generate.await_args.args[2]
        self.assertIn("image", parts[1])

    def test_legacy_settings_contract_never_returns_scanner_secrets(self):
        self.db.add(UserSetting(user_id=self.user.id, key="gemini_api_key", value="secret"))
        self.db.commit()
        result = _get_user_settings(self.db, self.user.id)
        self.assertNotIn("gemini_api_key", result)
        self.assertNotIn("secret", repr(result))

    def test_legacy_bulk_update_cannot_bypass_atomic_validation(self):
        with self.assertRaises(HTTPException) as caught:
            update_settings(
                {"scanner_provider": "openai", "scanner_model": "anything"},
                self.db,
                self.user,
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self._rows(), {})


if __name__ == "__main__":
    unittest.main()
