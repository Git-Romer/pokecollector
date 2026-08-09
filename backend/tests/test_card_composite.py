import io
import unittest

try:
    from PIL import Image
    from services.card_composite import GRID_SIZE, build_composite, chunk_for_composite
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _fake_jpeg(size=(300, 420), color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed in this lightweight test environment")
class BuildCompositeTests(unittest.TestCase):
    def test_builds_a_valid_jpeg_for_a_full_grid(self):
        images = [_fake_jpeg() for _ in range(GRID_SIZE)]
        out = build_composite(images)
        result = Image.open(io.BytesIO(out))
        self.assertEqual(result.format, "JPEG")

    def test_handles_a_partial_grid_smaller_than_grid_size(self):
        # A leftover chunk (e.g. 10 uploads / 4 per grid = 4, 4, 2) must not error
        # or silently drop the last two images.
        images = [_fake_jpeg() for _ in range(2)]
        out = build_composite(images, cols=2)
        result = Image.open(io.BytesIO(out))
        self.assertEqual(result.format, "JPEG")
        # A 2-image, 2-col grid is one row tall, not two.
        one_image = build_composite([_fake_jpeg()], cols=2)
        self.assertEqual(Image.open(io.BytesIO(one_image)).size[1], result.size[1])

    def test_canvas_grows_with_more_rows(self):
        two = Image.open(io.BytesIO(build_composite([_fake_jpeg() for _ in range(2)], cols=2)))
        four = Image.open(io.BytesIO(build_composite([_fake_jpeg() for _ in range(4)], cols=2)))
        self.assertEqual(two.size[0], four.size[0])  # same width, 2 cols either way
        self.assertLess(two.size[1], four.size[1])  # 4 images need a second row

    def test_empty_list_raises(self):
        with self.assertRaises(ValueError):
            build_composite([])


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed in this lightweight test environment")
class ChunkForCompositeTests(unittest.TestCase):
    def test_splits_into_fixed_size_chunks_with_a_smaller_remainder(self):
        chunks = chunk_for_composite(list(range(10)), size=4)
        self.assertEqual([len(c) for c in chunks], [4, 4, 2])
        self.assertEqual([item for chunk in chunks for item in chunk], list(range(10)))

    def test_exact_multiple_has_no_remainder_chunk(self):
        chunks = chunk_for_composite(list(range(8)), size=4)
        self.assertEqual([len(c) for c in chunks], [4, 4])

    def test_empty_list_returns_no_chunks(self):
        self.assertEqual(chunk_for_composite([], size=4), [])

    def test_default_size_matches_locked_grid_size(self):
        chunks = chunk_for_composite(list(range(GRID_SIZE + 1)))
        self.assertEqual(len(chunks[0]), GRID_SIZE)
        self.assertEqual(len(chunks[1]), 1)


if __name__ == "__main__":
    unittest.main()
