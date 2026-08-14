import os
import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.settings import (
        ScannerConfigurationUpdate,
        _get_user_settings,
        _scanner_configuration,
        update_scanner_configuration,
        update_settings,
    )
    from database import Base
    from models import User, UserSetting
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
