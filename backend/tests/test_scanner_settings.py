import asyncio
import base64
import os
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.settings import (
        ScannerConfigurationUpdate,
        SCANNER_TEST_IMAGE_B64,
        SCANNER_TEST_SECOND_IMAGE_B64,
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
        self.assertNotIn("custom_model_allowed", config["providers"][0])
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
        configured_openai = next(
            item for item in config["providers"] if item["id"] == "openai"
        )
        self.assertEqual(compatible["label"], "Local Ollama")
        self.assertEqual(compatible["endpoint"], "https://vision.example.test:8443")
        self.assertEqual(compatible["endpoint_type"], "custom")
        self.assertNotIn("password", repr(summary))
        self.assertNotIn("secret", repr(summary))
        self.assertTrue(configured_openai["custom_model_allowed"])
        self.assertEqual(configured_openai["custom_model"], "")

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

    def test_provider_model_and_key_are_tested_and_saved_atomically(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "vision-default",
            "OPENAI_ALLOWED_MODELS": "vision-fast",
            "OPENAI_BASE_URL": "https://api.openai.com/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai",
            model="vision-fast",
            api_key="secret-value",
            save_on_success=True,
        )
        with patch.dict(os.environ, env), patch.object(
            ScanProvider,
            "generate_text",
            new=AsyncMock(return_value=("MAGENTA-GREEN", None)),
        ):
            result = asyncio.run(
                run_scanner_configuration_test(request, self.db, self.user)
            )
        rows = self._rows()
        self.assertEqual(rows["scanner_provider"], "openai")
        self.assertEqual(rows["scanner_model_openai"], "vision-fast")
        self.assertEqual(rows["scanner_custom_model_openai"], "")
        self.assertEqual(rows["openai_api_key"], "secret-value")
        self.assertNotIn("scanner_model_gemini", rows)
        self.assertNotIn("secret-value", repr(result))
        self.assertEqual(result, {"status": "ready", "saved": True})

    def test_approved_configuration_cannot_bypass_test_and_save(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "vision-default",
            "OPENAI_ALLOWED_MODELS": "vision-fast",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai", model="vision-fast"
        )
        with patch.dict(os.environ, env), self.assertRaises(HTTPException) as caught:
            update_scanner_configuration(request, self.db, self.user)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self._rows(), {})

    def test_configured_key_can_still_be_removed_without_provider_access(self):
        self.db.add_all(
            [
                UserSetting(
                    user_id=self.user.id,
                    key="scanner_provider",
                    value="gemini",
                ),
                UserSetting(
                    user_id=self.user.id,
                    key="gemini_api_key",
                    value="configured-key",
                ),
            ]
        )
        self.db.commit()
        request = ScannerConfigurationUpdate(
            provider="gemini",
            model="gemini-flash-latest",
            clear_api_key=True,
        )
        update_scanner_configuration(request, self.db, self.user)
        self.assertEqual(self._rows()["gemini_api_key"], "")

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

    def test_connection_test_requires_and_sends_two_valid_images(self):
        request = ScannerConfigurationUpdate(
            provider="gemini", model="gemini-flash-latest", api_key="test-key"
        )
        generate = AsyncMock(return_value=("MAGENTA-GREEN", None))
        with patch.object(ScanProvider, "generate_text", new=generate):
            result = asyncio.run(
                run_scanner_configuration_test(request, self.db, self.user)
            )
        self.assertEqual(result, {"status": "ready", "saved": False})
        parts = generate.await_args.args[2]
        self.assertNotIn("MAGENTA-GREEN", parts[0]["text"])
        images = [part["image"]["data"] for part in parts if "image" in part]
        self.assertEqual(len(images), 2)
        decoded = [base64.b64decode(encoded, validate=True) for encoded in images]
        self.assertEqual(
            decoded,
            [
                base64.b64decode(SCANNER_TEST_IMAGE_B64, validate=True),
                base64.b64decode(SCANNER_TEST_SECOND_IMAGE_B64, validate=True),
            ],
        )

    def test_new_custom_model_cannot_be_saved_without_a_successful_test(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "approved-model",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai",
            model="new-vision-model",
            custom_model=True,
        )
        with patch.dict(os.environ, env), self.assertRaises(HTTPException) as caught:
            update_scanner_configuration(request, self.db, self.user)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(self._rows(), {})

    def test_successful_custom_model_test_and_save_is_atomic(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "approved-model",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai",
            model="new-vision-model",
            custom_model=True,
            save_on_success=True,
        )
        generate = AsyncMock(return_value=("MAGENTA-GREEN", None))
        with patch.dict(os.environ, env), patch.object(
            ScanProvider, "generate_text", new=generate
        ):
            result = asyncio.run(
                run_scanner_configuration_test(request, self.db, self.user)
            )

        self.assertEqual(result, {"status": "ready", "saved": True})
        self.assertEqual(
            self._rows(),
            {
                "scanner_provider": "openai",
                "scanner_model_openai": "new-vision-model",
                "scanner_custom_model_openai": "new-vision-model",
            },
        )
        with patch.dict(os.environ, env):
            self.assertEqual(get_provider(self.db, self.user.id).model(), "new-vision-model")

    def test_failed_custom_model_test_saves_nothing(self):
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "approved-model",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai",
            model="new-vision-model",
            custom_model=True,
            save_on_success=True,
        )
        with patch.dict(os.environ, env), patch.object(
            ScanProvider,
            "generate_text",
            new=AsyncMock(return_value=("GREEN-MAGENTA", None)),
        ), self.assertRaises(HTTPException):
            asyncio.run(run_scanner_configuration_test(request, self.db, self.user))
        self.assertEqual(self._rows(), {})

    def test_normal_user_cannot_test_or_save_a_custom_model(self):
        self.user.role = "trainer"
        self.db.commit()
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": "approved-model",
            "OPENAI_BASE_URL": "http://model-host:11434/v1",
        }
        request = ScannerConfigurationUpdate(
            provider="openai",
            model="new-vision-model",
            custom_model=True,
            save_on_success=True,
        )
        with patch.dict(os.environ, env), self.assertRaises(HTTPException) as caught:
            asyncio.run(run_scanner_configuration_test(request, self.db, self.user))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(self._rows(), {})

    def test_legacy_settings_contract_never_returns_scanner_secrets(self):
        self.db.add_all(
            [
                UserSetting(
                    user_id=self.user.id,
                    key="gemini_api_key",
                    value="gemini-secret",
                ),
                UserSetting(
                    user_id=self.user.id,
                    key="openai_api_key",
                    value="openai-secret",
                ),
            ]
        )
        self.db.commit()
        result = _get_user_settings(self.db, self.user.id)
        self.assertNotIn("gemini_api_key", result)
        self.assertNotIn("openai_api_key", result)
        self.assertNotIn("gemini-secret", repr(result))
        self.assertNotIn("openai-secret", repr(result))

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
