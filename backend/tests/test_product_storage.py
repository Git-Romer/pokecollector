import datetime
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.products import create_product
from database import Base
from models import User
from schemas import ProductPurchaseCreate


class ProductStorageTests(unittest.TestCase):
    def test_sealed_product_persists_storage_metadata(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        user = User(username="john", hashed_password="x", role="admin", is_active=True)
        db.add(user)
        db.commit()
        db.refresh(user)

        product = create_product(
            ProductPurchaseCreate(
                product_name="Prismatic Evolutions Elite Trainer Box",
                product_type="Elite Trainer Box",
                purchase_price=0,
                purchase_date=datetime.date(2025, 1, 17),
                storage_type="Sealed",
                storage_detail="Storage Box A",
            ),
            current_user=user,
            db=db,
        )

        self.assertEqual(product.storage_type, "Sealed")
        self.assertEqual(product.storage_detail, "Storage Box A")
        db.close()

