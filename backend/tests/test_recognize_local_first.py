from pathlib import Path
import unittest


class RecognizeLocalFirstTests(unittest.TestCase):
    def test_recognize_has_no_external_ai_client_or_key_path(self):
        source = Path("api/recognize.py").read_text(encoding="utf-8")

        self.assertIn("Built-in AI recognition is disabled", source)
        self.assertIn("status_code=501", source)
        self.assertNotIn("UserSetting", source)
        self.assertNotIn("Setting", source)
        self.assertNotIn("httpx", source)
        self.assertNotIn("generativelanguage", source)
        self.assertNotIn("post_gemini", source)
        self.assertNotIn("gemini_api_key", source)
        self.assertNotIn("GEMINI_API_KEY", source)
        self.assertNotIn("os.environ", source)

    def test_settings_api_does_not_expose_external_ai_key(self):
        settings_source = Path("api/settings.py").read_text(encoding="utf-8")
        database_source = Path("database.py").read_text(encoding="utf-8")

        self.assertNotIn("gemini_api_key", settings_source)
        self.assertNotIn("GEMINI_API_KEY", settings_source)
        self.assertNotIn("gemini_api_key", database_source)
        self.assertNotIn("GEMINI_API_KEY", database_source)



if __name__ == "__main__":
    unittest.main()
