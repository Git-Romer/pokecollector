from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from database import get_db
from models import JohnJohnNote, JohnJohnAuditLog
from pydantic import BaseModel
from typing import List, Optional
import json

router = APIRouter(prefix="/agent", tags=["agent"])

class NoteResponse(BaseModel):
    id: int
    kind: str
    title: str
    body: str
    href: Optional[str] = None
    undo_action_id: Optional[int] = None
    dismissed: bool

@router.get("/notes", response_model=List[NoteResponse])
def get_notes(db: Session = Depends(get_db)):
    """Fetch active John John notes."""
    notes = db.query(JohnJohnNote).filter(JohnJohnNote.dismissed == False).order_by(JohnJohnNote.created_at.desc()).limit(10).all()
    return notes

@router.post("/notes/{note_id}/dismiss")
def dismiss_note(note_id: int, db: Session = Depends(get_db)):
    """Dismiss a note so it no longer appears."""
    note = db.query(JohnJohnNote).filter(JohnJohnNote.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note.dismissed = True
    db.commit()
    return {"status": "ok"}

@router.post("/undo/{audit_id}")
def undo_action(audit_id: int, db: Session = Depends(get_db)):
    """Reverse an autonomous action taken by John John."""
    log = db.query(JohnJohnAuditLog).filter(JohnJohnAuditLog.id == audit_id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Audit log not found")
    if log.reverted:
        raise HTTPException(status_code=400, detail="Action already reverted")

    # In a full implementation, we'd reverse the specific payload action here.
    # For now, mark it reverted and dismiss the associated note.
    log.reverted = True
    
    note = db.query(JohnJohnNote).filter(JohnJohnNote.undo_action_id == audit_id).first()
    if note:
        note.dismissed = True

    db.commit()
    return {"status": "ok"}
