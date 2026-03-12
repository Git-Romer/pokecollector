from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import User
from services.auth import create_access_token, decode_token, hash_password, verify_password

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "trainer"


class UpdateUserRequest(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def get_optional_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """Returns user if authenticated, None otherwise. For backward compat during transition."""
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            return None
    except JWTError:
        return None
    return db.query(User).filter(User.id == int(user_id), User.is_active == True).first()


@router.post("/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username, User.is_active == True).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_access_token({"sub": str(user.id), "role": user.role})
    return TokenResponse(
        access_token=token,
        user={"id": user.id, "username": user.username, "role": user.role},
    )


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role}


@router.get("/users")
def list_users(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.id.asc()).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "is_active": u.is_active,
            "created_at": str(u.created_at),
        }
        for u in users
    ]


@router.post("/users")
def create_user(
    data: CreateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    existing = db.query(User).filter(User.username == data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(
        username=data.username,
        hashed_password=hash_password(data.password),
        role=data.role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active}


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    data: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if data.username is not None:
        user.username = data.username
    if data.password is not None:
        user.hashed_password = hash_password(data.password)
    if data.role is not None:
        user.role = data.role
    if data.is_active is not None:
        user.is_active = data.is_active
    db.commit()
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(user)
    db.commit()
    return {"message": "User deleted"}


@router.put("/me/password")
def change_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.hashed_password = hash_password(data.new_password)
    db.commit()
    return {"message": "Password changed"}
