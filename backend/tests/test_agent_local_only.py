import unittest
from pathlib import Path


class AgentLocalOnlyTests(unittest.TestCase):
    def test_agent_service_has_no_external_ai_or_obsidian_reads(self):
        source = Path("services/agent.py").read_text(encoding="utf-8")

        forbidden = [
            "google.generativeai",
            "genai.",
            "GEMINI_API_KEY",
            "OBSIDIAN_DIR",
            "os.walk",
            "generate_content",
        ]
        for token in forbidden:
            with self.subTest(token=token):
                self.assertNotIn(token, source)

    def test_agent_service_declares_local_only_boundary(self):
        source = Path("services/agent.py").read_text(encoding="utf-8")
        self.assertIn("Local-only John John collection note generation", source)
        self.assertIn("does not call external AI services", source)


if __name__ == "__main__":
    unittest.main()
