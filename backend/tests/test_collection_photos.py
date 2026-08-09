"""The owner's own photo of a card the catalogue has no scan of.

About one card in fourteen has no TCGdex image — trainer kits, Japanese
printings, the newest energy subsets — and the collection shows an anonymous
card back for every one of them. This lets the owner supply a photograph of the
actual card instead.

Most of what is asserted here is access control. A photograph of a card is also
a photograph of whatever it was resting on, and the obvious place to have put it
— the shared `cards` catalogue, served by the unauthenticated /api/images router
— would have handed every user's photos to anyone who could reach the instance.
It hangs off the collection row instead, and the tests below are what holds that
decision in place.
"""

import io
import unittest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image

    from api.auth import get_current_user
    from api.collection import _annotate_scan_photos, router as collection_router
    from database import get_db
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


def _fake_jpeg_bytes(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (24, 34), color).save(buf, format="JPEG")
    return buf.getvalue()


def _dominant_colour(data: bytes) -> tuple[int, int, int]:
    """Identify a photo by what it looks like rather than by its bytes.

    Storing re-encodes to strip EXIF, so the file that comes back is never the
    file that went in — but it is the same picture, which is what matters. Each
    fixture is a solid colour, so rounding away JPEG noise identifies it exactly.
    """
    pixel = Image.open(io.BytesIO(data)).convert("RGB").resize((1, 1)).getpixel((0, 0))
    return tuple(round(channel / 32) for channel in pixel)


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/httpx are not installed in this lightweight test environment")
class CollectionPhotoTests(unittest.TestCase):
    def setUp(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.pool import StaticPool
        from database import Base
        from models import Card, CollectionItem, Set, User

        # TestClient serves requests on another thread, so an in-memory SQLite
        # DB has to share one connection across threads to stay visible.
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()

        self.owner = User(username="owner", hashed_password="x")
        self.other = User(username="other", hashed_password="x")
        self.db.add_all([self.owner, self.other])
        self.db.commit()
        self.current_user = self.owner

        # A card with no catalogue scan — the case this whole feature exists for.
        self.db.add(Set(id="pmcg2", name="Pokemon Jungle", lang="ja"))
        self.db.add(Card(id="pmcg2-035", name="プリン", set_id="pmcg2", number="035", lang="ja"))
        self.db.commit()

        self.entry = CollectionItem(card_id="pmcg2-035", user_id=self.owner.id, quantity=1, lang="ja")
        self.db.add(self.entry)
        self.db.commit()

        app = FastAPI()
        app.include_router(collection_router, prefix="/api/collection")
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.db.close()

    def _upload(self, colour=(200, 30, 30), data=None):
        return self.client.post(
            f"/api/collection/{self.entry.id}/photo",
            files={"file": ("card.jpg", data or _fake_jpeg_bytes(colour), "image/jpeg")},
        )

    def test_a_photo_can_be_attached_and_read_back(self):
        self.assertEqual(self._upload().status_code, 200)
        resp = self.client.get(f"/api/collection/{self.entry.id}/photo")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["content-type"], "image/jpeg")
        # Not compared byte for byte: storing re-encodes to strip EXIF, so what
        # comes back is the same picture rather than the same file.
        self.assertEqual(_dominant_colour(resp.content), _dominant_colour(_fake_jpeg_bytes()))

    def test_a_second_upload_replaces_rather_than_duplicates(self):
        """Re-photographing a card should overwrite. The unique constraint means
        getting this wrong is an error, not a duplicate."""
        self._upload()
        self.assertEqual(self._upload(colour=(20, 180, 90)).status_code, 200)
        resp = self.client.get(f"/api/collection/{self.entry.id}/photo")
        self.assertEqual(_dominant_colour(resp.content), _dominant_colour(_fake_jpeg_bytes((20, 180, 90))))

    def test_the_stored_photo_carries_no_exif(self):
        """The reason normalisation exists: a phone photo carries GPS, a camera
        serial and a timestamp, none of which describe a Pokémon card."""
        img = Image.new("RGB", (60, 80), (200, 30, 30))
        exif = img.getexif()
        exif[0x010F] = "TestPhone"
        exif[0x8825] = {1: "S", 2: (33.0, 52.0, 0.0)}
        buf = io.BytesIO()
        img.save(buf, format="JPEG", exif=exif)
        self.assertTrue(dict(Image.open(io.BytesIO(buf.getvalue())).getexif()))

        self._upload(data=buf.getvalue())
        stored = self.client.get(f"/api/collection/{self.entry.id}/photo").content
        self.assertFalse(dict(Image.open(io.BytesIO(stored)).getexif()))

    def test_another_user_cannot_read_the_photo(self):
        self._upload()
        self.current_user = self.other
        self.assertEqual(self.client.get(f"/api/collection/{self.entry.id}/photo").status_code, 404)

    def test_another_user_cannot_upload_onto_someone_elses_card(self):
        self.current_user = self.other
        self.assertEqual(self._upload().status_code, 404)

    def test_another_user_cannot_delete_the_photo(self):
        self._upload()
        self.current_user = self.other
        self.assertEqual(self.client.delete(f"/api/collection/{self.entry.id}/photo").status_code, 404)

    def test_uploading_junk_is_refused(self):
        resp = self._upload(data=b"not an image at all")
        self.assertEqual(resp.status_code, 400)

    def test_a_photo_cannot_be_attached_to_a_collection_row_that_does_not_exist(self):
        resp = self.client.post(
            "/api/collection/99999/photo",
            files={"file": ("card.jpg", _fake_jpeg_bytes(), "image/jpeg")},
        )
        self.assertEqual(resp.status_code, 404)

    def test_removing_the_photo_falls_back_to_the_catalogue(self):
        self._upload()
        self.assertEqual(self.client.delete(f"/api/collection/{self.entry.id}/photo").status_code, 200)
        self.assertEqual(self.client.get(f"/api/collection/{self.entry.id}/photo").status_code, 404)

    def test_an_item_with_no_photo_reports_no_photo(self):
        self.assertEqual(self.client.get(f"/api/collection/{self.entry.id}/photo").status_code, 404)

    def test_the_listing_flag_tracks_the_photo(self):
        """The frontend decides whether to fetch the bytes from this flag alone,
        so it has to follow the photo in both directions."""
        _annotate_scan_photos(self.db, self.owner, [self.entry])
        self.assertFalse(self.entry.has_scan_photo)

        self._upload()
        _annotate_scan_photos(self.db, self.owner, [self.entry])
        self.assertTrue(self.entry.has_scan_photo)

        self.client.delete(f"/api/collection/{self.entry.id}/photo")
        _annotate_scan_photos(self.db, self.owner, [self.entry])
        self.assertFalse(self.entry.has_scan_photo)

    def test_the_listing_flag_is_not_set_from_another_users_photos(self):
        self._upload()
        _annotate_scan_photos(self.db, self.other, [self.entry])
        self.assertFalse(self.entry.has_scan_photo)

    def test_deleting_the_collection_item_takes_the_photo_with_it(self):
        """Otherwise removing a card would leave its photograph on disk.

        There is no ORM relationship between the two, so this is the database
        CASCADE doing the work — which means the test only proves anything with
        foreign keys actually enforced. SQLite has them off by default; Postgres,
        which is what runs in production, always enforces them.
        """
        from sqlalchemy import text
        from models import CollectionItemPhoto

        self._upload()
        self.db.execute(text("PRAGMA foreign_keys=ON"))
        self.assertEqual(self.db.execute(text("PRAGMA foreign_keys")).scalar(), 1)
        self.db.delete(self.entry)
        self.db.commit()
        self.assertIsNone(
            self.db.query(CollectionItemPhoto).filter(
                CollectionItemPhoto.collection_item_id == self.entry.id
            ).first()
        )


if __name__ == "__main__":
    unittest.main()
