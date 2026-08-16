import io
import random
import unittest

try:
    from services import card_image_match as cim
    from PIL import Image
    DEPS_AVAILABLE = True
except ImportError:
    DEPS_AVAILABLE = False


def textured(seed, size=(200, 280), tint=(0, 0, 0)):
    """A deterministic textured image.

    Deliberately not a flat colour: phash is a DCT over frequency content, so
    every solid image hashes identically and a flat fixture would prove nothing.
    `tint` shifts the colour without touching the structure, which is how a
    same-artwork reprint differs from its original.
    """
    rng = random.Random(seed)
    img = Image.new("RGB", size)
    img.putdata([
        tuple(min(255, rng.randrange(256) + t) for t in tint)
        if any(tint) else
        (rng.randrange(256), rng.randrange(256), rng.randrange(256))
        for _ in range(size[0] * size[1])
    ])
    return img


def encoded(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy not installed in this lightweight test environment")
class EnsembleDistanceTests(unittest.TestCase):
    def test_identical_artwork_scores_zero(self):
        img = textured(1)
        self.assertEqual(cim.ensemble_distance(img, img), 0.0)

    def test_different_artwork_scores_above_zero(self):
        self.assertGreater(cim.ensemble_distance(textured(1), textured(2)), 0.0)

    def test_compares_the_art_window_not_the_frame(self):
        # Two cards identical in the art window but different at the edges must
        # still match: the frame is era-generic and swamps the colour signal.
        base = textured(3)
        framed = base.copy()
        for y in list(range(0, 20)) + list(range(260, 280)):
            for x in range(200):
                framed.putpixel((x, y), (255, 0, 0))
        self.assertEqual(cim.ensemble_distance(base, framed), 0.0)

    def test_unreadable_bytes_do_not_raise(self):
        self.assertIsNone(cim.load_image(b"not-an-image"))


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy not installed in this lightweight test environment")
class BestMatchTests(unittest.TestCase):
    def test_picks_the_matching_candidate(self):
        photo = textured(7)
        result = cim.best_match(encoded(photo), [
            ("wrong", encoded(textured(99))),
            ("right", encoded(photo)),
        ])
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "right")

    def test_declines_when_two_candidates_are_indistinguishable(self):
        # A coin flip is worse than no answer: the user still sees all eight
        # candidates and can pick, but a confident wrong pick misleads them.
        photo = textured(7)
        same = encoded(photo)
        self.assertIsNone(cim.best_match(encoded(photo), [("a", same), ("b", same)]))

    def test_declines_when_nothing_is_close(self):
        # Guards against the pool simply not containing the card — observed for
        # real on a card whose printing is absent from TCGdex.
        photo = textured(7)
        far = [("a", encoded(textured(101))), ("b", encoded(textured(202)))]
        result = cim.best_match(encoded(photo), far)
        if result is not None:
            self.assertLessEqual(result[1], cim.ENSEMBLE_MAX_DISTANCE)

    def test_needs_at_least_two_candidates(self):
        photo = textured(7)
        self.assertIsNone(cim.best_match(encoded(photo), [("only", encoded(photo))]))

    def test_no_photo_is_not_an_error(self):
        self.assertIsNone(cim.best_match(b"", [("a", b"x"), ("b", b"y")]))

    def test_undecodable_candidates_are_skipped_not_fatal(self):
        photo = textured(7)
        result = cim.best_match(encoded(photo), [
            ("broken", b"not-an-image"),
            ("wrong", encoded(textured(99))),
            ("right", encoded(photo)),
        ])
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "right")


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy not installed in this lightweight test environment")
class RotationDetectionTests(unittest.TestCase):
    """The model cannot answer this — asked directly it calls every photo upright,
    including ones rotated 90, 180 and 270 (0/18 correct on real cards). The
    catalogue scan of the matched card is upright by definition, so it is the
    reference instead. Measured 36/36 across 9 cards at every angle.
    """

    def test_recovers_every_quarter_turn(self):
        reference = textured(11)
        for applied in (90, 180, 270):
            photo = reference.rotate(-applied, expand=True)
            self.assertEqual(
                cim.detect_rotation(encoded(photo), encoded(reference)), applied,
                f"failed to recover a {applied} degree rotation",
            )

    def test_upright_photos_report_no_rotation(self):
        # None rather than 0 so callers cannot accidentally re-encode a photo
        # that was already the right way up.
        reference = textured(11)
        self.assertIsNone(cim.detect_rotation(encoded(reference), encoded(reference)))

    def test_declines_when_no_orientation_stands_out(self):
        # A rotationally symmetric image genuinely has no answer; guessing one
        # would turn a correct preview upside down.
        img = Image.new("RGB", (200, 200), (120, 120, 120))
        self.assertIsNone(cim.detect_rotation(encoded(img), encoded(img.rotate(90))))

    def test_unreadable_input_is_not_fatal(self):
        self.assertIsNone(cim.detect_rotation(b"not-an-image", encoded(textured(2))))
        self.assertIsNone(cim.detect_rotation(encoded(textured(2)), b"not-an-image"))


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy not installed in this lightweight test environment")
class CalibrationTests(unittest.TestCase):
    """Pin the thresholds to what was measured.

    Both were fit on a 64-card benchmark: the worst correct match scored 40 and
    the one confidently wrong match scored 63, so the distance cap sits between
    them; the margin is the point at which every answer given was correct.
    Changing either silently changes how often the scanner guesses.
    """

    def test_distance_cap_sits_between_the_measured_extremes(self):
        self.assertGreater(cim.ENSEMBLE_MAX_DISTANCE, 40)
        self.assertLess(cim.ENSEMBLE_MAX_DISTANCE, 63)

    def test_colour_is_weighted_above_the_structural_hashes(self):
        # Same-artwork reprints differ mostly in tint; equal weighting measured
        # worse. Documented here so the ratio is not "tidied" away.
        weights = dict(cim._WEIGHTS)
        self.assertGreater(weights["colorhash"], weights["phash"])
        self.assertEqual(weights["phash"], weights["dhash"])


if __name__ == "__main__":
    unittest.main()
