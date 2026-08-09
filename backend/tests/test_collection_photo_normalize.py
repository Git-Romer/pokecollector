"""Normalising owner-supplied card photos before they are stored.

A scan photo used to be transient — taken, matched, discarded. Keeping it as a
card's picture turns it into stored data that leaves the instance whenever a
collection is exported or shared, so what rides along inside it starts to matter.
Phone EXIF routinely carries GPS coordinates, a camera serial and a timestamp,
and none of that describes a Pokémon card. EXIF is only the best known hiding
place, though — XMP and an ICC profile ride along in their own JPEG markers and
carry their own idea of who made the file.

These tests exist because stripping metadata is exactly the kind of thing that
silently stops working: the photo still looks right in every view. Nothing here
asks the encoder to drop anything; the strip works because a freshly saved image
carries only what `save()` is explicitly handed. That makes it a property of
Pillow's behaviour rather than of our code, which is precisely why it is worth
pinning down.
"""

import io
import unittest

try:
    from PIL import Image
    from services.collection_photos import (
        InvalidPhoto,
        JPEG_QUALITY,
        MAX_EDGE,
        MAX_UPLOAD_BYTES,
        normalize_photo,
    )
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


# Pillow writes both of these into their JPEG markers verbatim, without
# validating them, so recognisable bytes are enough to prove whether they
# survive a round trip — no real colour profile needed.
_LEAKY_ICC = b"\x00\x00\x02\x0cLEAKYICCPROFILE" + b"\x00" * 100
_LEAKY_XMP = (
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"'
    b' dc:creator="Photographer Name" GPSLatitude="-33.87"/>'
    b"</rdf:RDF></x:xmpmeta>"
)


def _jpeg_with_exif(size=(120, 160), *, orientation=None, gps=True, xmp=True, icc=True) -> bytes:
    """A JPEG carrying the metadata a phone would attach."""
    img = Image.new("RGB", size, (180, 40, 40))
    exif = img.getexif()
    exif[0x010F] = "TestPhone"          # Make
    exif[0x0110] = "TestPhone 15 Pro"   # Model
    exif[0x0132] = "2026:08:03 09:15:00"  # DateTime
    if orientation is not None:
        exif[0x0112] = orientation      # Orientation
    if gps:
        # GPSInfo IFD pointer — the tag that makes this worth testing.
        exif[0x8825] = {1: "S", 2: (33.0, 52.0, 0.0), 3: "E", 4: (151.0, 12.0, 0.0)}
    extra = {}
    if xmp:
        extra["xmp"] = _LEAKY_XMP
    if icc:
        extra["icc_profile"] = _LEAKY_ICC
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif, **extra)
    return buf.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed in this lightweight test environment")
class NormalizePhotoTests(unittest.TestCase):
    def test_the_source_fixture_really_does_carry_metadata(self):
        """Guards the tests below: if the fixture stopped embedding this
        metadata they would all pass while proving nothing."""
        source = _jpeg_with_exif()
        image = Image.open(io.BytesIO(source))
        exif = image.getexif()
        self.assertTrue(dict(exif))
        self.assertIn(0x8825, exif)
        self.assertIn("xmp", image.info)
        self.assertTrue(image.info.get("icc_profile"))

    def test_exif_is_gone(self):
        data, _ = normalize_photo(_jpeg_with_exif())
        self.assertFalse(dict(Image.open(io.BytesIO(data)).getexif()))

    def test_gps_in_particular_is_gone(self):
        data, _ = normalize_photo(_jpeg_with_exif())
        exif = Image.open(io.BytesIO(data)).getexif()
        self.assertNotIn(0x8825, exif)
        self.assertEqual(exif.get_ifd(0x8825), {})

    def test_the_camera_make_and_model_are_gone(self):
        data, _ = normalize_photo(_jpeg_with_exif())
        exif = Image.open(io.BytesIO(data)).getexif()
        self.assertIsNone(exif.get(0x010F))
        self.assertIsNone(exif.get(0x0110))

    def test_the_xmp_block_is_gone(self):
        """EXIF is not the only place identity hides. XMP has its own creator
        and GPS fields, travels in a different marker, and is untouched by
        anything that only clears EXIF."""
        data, _ = normalize_photo(_jpeg_with_exif())
        image = Image.open(io.BytesIO(data))
        self.assertNotIn("xmp", image.info)
        self.assertEqual(image.getxmp(), {})
        self.assertNotIn(b"xmpmeta", data)

    def test_the_colour_profile_is_gone(self):
        """An ICC profile names the device or editor that produced the file.
        It is also the piece most likely to return by accident, being the one
        a re-encode has a legitimate reason to want to preserve."""
        data, _ = normalize_photo(_jpeg_with_exif())
        self.assertIsNone(Image.open(io.BytesIO(data)).info.get("icc_profile"))
        self.assertNotIn(b"LEAKYICCPROFILE", data)

    def test_orientation_is_applied_before_it_is_discarded(self):
        """Orientation 6 means "rotate 90°". Strip the tag without acting on it
        and every photo from a phone held upright ends up on its side."""
        portrait = _jpeg_with_exif(size=(160, 120), orientation=6)
        data, _ = normalize_photo(portrait)
        width, height = Image.open(io.BytesIO(data)).size
        self.assertGreater(height, width)

    def test_an_upright_photo_is_left_the_right_way_up(self):
        data, _ = normalize_photo(_jpeg_with_exif(size=(120, 160)))
        width, height = Image.open(io.BytesIO(data)).size
        self.assertGreater(height, width)

    def test_an_oversized_photo_is_bounded(self):
        big = Image.new("RGB", (4032, 3024), (10, 90, 10))
        buf = io.BytesIO()
        big.save(buf, format="JPEG")
        data, _ = normalize_photo(buf.getvalue())
        self.assertEqual(max(Image.open(io.BytesIO(data)).size), MAX_EDGE)

    def test_the_aspect_ratio_survives_resizing(self):
        buf = io.BytesIO()
        Image.new("RGB", (3000, 2000), (10, 90, 10)).save(buf, format="JPEG")
        data, _ = normalize_photo(buf.getvalue())
        width, height = Image.open(io.BytesIO(data)).size
        self.assertAlmostEqual(width / height, 1.5, places=2)

    def test_a_small_photo_is_not_upscaled(self):
        buf = io.BytesIO()
        Image.new("RGB", (300, 420), (10, 90, 10)).save(buf, format="JPEG")
        data, _ = normalize_photo(buf.getvalue())
        self.assertEqual(Image.open(io.BytesIO(data)).size, (300, 420))

    def test_a_png_becomes_a_jpeg(self):
        buf = io.BytesIO()
        Image.new("RGBA", (100, 140), (10, 90, 10, 255)).save(buf, format="PNG")
        data, content_type = normalize_photo(buf.getvalue())
        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(Image.open(io.BytesIO(data)).format, "JPEG")

    def test_the_photo_still_looks_like_the_photo(self):
        """Re-encoding must not quietly corrupt the image — the whole point is
        being able to recognise the card in it."""
        buf = io.BytesIO()
        Image.new("RGB", (200, 280), (200, 30, 30)).save(buf, format="JPEG")
        data, _ = normalize_photo(buf.getvalue())
        red, green, blue = Image.open(io.BytesIO(data)).convert("RGB").getpixel((100, 140))
        self.assertGreater(red, 150)
        self.assertLess(green, 80)

    def test_junk_is_refused(self):
        with self.assertRaises(InvalidPhoto):
            normalize_photo(b"this is not an image")

    def test_empty_input_is_refused(self):
        with self.assertRaises(InvalidPhoto):
            normalize_photo(b"")

    def test_an_absurdly_large_upload_is_refused_before_decoding(self):
        with self.assertRaises(InvalidPhoto):
            normalize_photo(b"\xff\xd8\xff" + b"0" * MAX_UPLOAD_BYTES)


if __name__ == "__main__":
    unittest.main()
