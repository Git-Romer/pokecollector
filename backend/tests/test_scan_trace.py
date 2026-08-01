import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from services.scan_trace import ScanTrace, record_ground_truth, trace_enabled
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


class TraceDirMixin:
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.dict("os.environ", {"SCAN_TRACE_DIR": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def written(self):
        return sorted(Path(self.tmp.name).glob("*/*.json"))


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class TraceDisabledTests(unittest.TestCase):
    def test_tracing_is_off_without_the_env_var(self):
        # Production installs must pay nothing for this.
        with patch.dict("os.environ", {"SCAN_TRACE_DIR": ""}):
            self.assertFalse(trace_enabled())
            trace = ScanTrace(mode="single")
            trace.set_image(b"bytes")
            trace.record_extraction(prompt="p", raw_response="r", parsed={"name": "Gengar"})
            trace.record_decision("phash", "me03-050")
            self.assertIsNone(trace.save())

    def test_disabled_trace_still_accepts_every_call(self):
        # Call sites should never have to branch on whether tracing is on.
        with patch.dict("os.environ", {"SCAN_TRACE_DIR": ""}):
            trace = ScanTrace(mode="batch", job_id=1, item_id=2)
            trace.record_tcgdex("http://x", 200, 5)
            trace.record_prefilter("52", 1, 39)
            trace.record_candidates([{"tcg_card_id": "a"}])
            trace.record_phash([(4, "a")], accepted="a", reason="accepted")
            trace.record_error("boom")
            self.assertEqual(trace.data["candidates"], [])


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class TraceWriteTests(TraceDirMixin, unittest.TestCase):
    def test_writes_json_and_image_together(self):
        trace = ScanTrace(mode="single", job_id=7, item_id=3, filename="c.jpg", model="gemini-flash-latest")
        trace.set_image(b"fake-image-bytes")
        trace.record_extraction(prompt="PROMPT", raw_response='{"name":"Gengar"}', parsed={"name": "Gengar"})
        trace.record_decision("phash", "me03-050")
        path = trace.save()

        self.assertIsNotNone(path)
        data = json.loads(path.read_text())
        self.assertEqual(data["extraction"]["prompt"], "PROMPT")
        self.assertEqual(data["decision"], {"mechanism": "phash", "selected": "me03-050"})
        self.assertEqual(data["model"], "gemini-flash-latest")
        # Image written alongside, and hashed so duplicate photos are identifiable.
        self.assertTrue((path.parent / data["image_file"]).exists())
        self.assertEqual(len(data["image_sha256"]), 64)

    def test_candidates_capture_the_rank_key_that_ranking_used(self):
        trace = ScanTrace(mode="single", job_id=1, item_id=1)
        cards = [
            {"tcg_card_id": "base2-52", "artist": "Mitsuhiro Arita", "hp": "50"},
            {"tcg_card_id": "base4-74", "artist": "Mitsuhiro Arita", "hp": "50"},
        ]
        trace.record_candidates(cards, rank_key=lambda c: (0, 1) if c["tcg_card_id"] == "base2-52" else (0, 2))
        trace.save()

        data = json.loads(self.written()[0].read_text())
        self.assertEqual(data["candidates"][0]["rank_key"], [0, 1])
        self.assertEqual(data["candidates"][0]["position"], 0)
        self.assertEqual(data["candidates"][1]["tcg_card_id"], "base4-74")

    def test_a_failing_rank_key_does_not_lose_the_trace(self):
        trace = ScanTrace(mode="single", job_id=1, item_id=1)

        def boom(_card):
            raise RuntimeError("bad key")

        trace.record_candidates([{"tcg_card_id": "x"}], rank_key=boom)
        self.assertIsNotNone(trace.save())
        data = json.loads(self.written()[0].read_text())
        self.assertEqual(data["candidates"][0]["tcg_card_id"], "x")
        self.assertNotIn("rank_key", data["candidates"][0])


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class GroundTruthTests(TraceDirMixin, unittest.TestCase):
    def _trace_with_candidates(self, selected, ids):
        trace = ScanTrace(mode="batch", job_id=9, item_id=4)
        trace.record_candidates([{"tcg_card_id": i} for i in ids])
        trace.record_decision("rank_order", selected)
        trace.save()

    def test_marks_a_correct_top_match(self):
        self._trace_with_candidates("base2-52", ["base2-52", "base4-74"])
        record_ground_truth(9, 4, "base2-52")

        data = json.loads(self.written()[0].read_text())
        self.assertEqual(data["ground_truth"], "base2-52")
        self.assertTrue(data["correct"])
        self.assertEqual(data["ground_truth_rank"], 1)

    def test_marks_a_near_miss_with_the_rank_it_landed_at(self):
        # A wrong pick where the right card was second is a different problem
        # from one where it was never retrieved, so the rank is recorded.
        self._trace_with_candidates("base4-74", ["base4-74", "base2-52"])
        record_ground_truth(9, 4, "base2-52")

        data = json.loads(self.written()[0].read_text())
        self.assertFalse(data["correct"])
        self.assertEqual(data["ground_truth_rank"], 2)

    def test_records_when_the_right_card_was_never_a_candidate(self):
        self._trace_with_candidates("base4-74", ["base4-74", "lc-75"])
        record_ground_truth(9, 4, "base2-52")

        data = json.loads(self.written()[0].read_text())
        self.assertFalse(data["correct"])
        self.assertIsNone(data["ground_truth_rank"])

    def test_unknown_item_is_a_no_op(self):
        self.assertIsNone(record_ground_truth(999, 999, "base2-52"))

    def test_no_card_id_is_a_no_op(self):
        self._trace_with_candidates("base2-52", ["base2-52"])
        self.assertIsNone(record_ground_truth(9, 4, ""))


if __name__ == "__main__":
    unittest.main()
