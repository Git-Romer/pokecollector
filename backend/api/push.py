import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import PushSubscription, User
from services import push as push_service

router = APIRouter()


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=255)
    auth: str = Field(min_length=1, max_length=255)


class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=push_service.MAX_ENDPOINT_LENGTH)
    keys: PushKeys
    user_agent: str | None = Field(default=None, max_length=1000)


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=push_service.MAX_ENDPOINT_LENGTH)


@router.get("/vapid-public-key")
def get_vapid_public_key(current_user: User = Depends(get_current_user)):
    _vapid, public_key = push_service.get_or_create_vapid_keys()
    return {"public_key": public_key}


@router.post("/subscribe")
def subscribe(
    body: PushSubscribeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        endpoint = push_service.validate_push_endpoint(body.endpoint)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    now = datetime.datetime.utcnow()
    user_agent = (body.user_agent or "")[:255] or None
    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
    if sub is None:
        sub = PushSubscription(endpoint=endpoint, user_id=current_user.id)
        db.add(sub)
    sub.user_id = current_user.id
    sub.p256dh = body.keys.p256dh
    sub.auth = body.keys.auth
    sub.user_agent = user_agent
    sub.last_seen_at = now
    sub.failure_count = 0
    db.commit()
    db.refresh(sub)
    return {"id": sub.id}


@router.delete("/subscribe", status_code=204)
def unsubscribe(
    body: PushUnsubscribeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == body.endpoint,
        PushSubscription.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()
    return Response(status_code=204)


@router.post("/test")
def send_test_notification(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return push_service.send_test(db, current_user.id)
