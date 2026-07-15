import os
import json
import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func
from models import Card, CollectionItem, Set, JohnJohnNote, JohnJohnAuditLog
import google.generativeai as genai

# Setup Gemini (assuming GEMINI_API_KEY is in environment)
genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))

# Path to the mounted Obsidian vault (if mapped in docker-compose as O:\ -> /mnt/odrive)
OBSIDIAN_DIR = "/mnt/odrive/Obsidian/Journal"

def read_recent_obsidian_notes(days=7):
    """Reads journal entries from the last `days` days."""
    notes_content = ""
    if not os.path.exists(OBSIDIAN_DIR):
        return "No journal found."
    
    cutoff_date = datetime.datetime.now() - datetime.timedelta(days=days)
    
    # Very basic reading of recent .md files
    for root, dirs, files in os.walk(OBSIDIAN_DIR):
        for file in files:
            if file.endswith(".md"):
                filepath = os.path.join(root, file)
                # Check modified time
                mtime = datetime.datetime.fromtimestamp(os.path.getmtime(filepath))
                if mtime > cutoff_date:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        notes_content += f"\n--- {file} ({mtime.strftime('%Y-%m-%d')}) ---\n"
                        notes_content += f.read()[:2000] # truncate to avoid massive tokens
    return notes_content

def build_context_packet(db: Session):
    """Compiles the compressed state of the archive."""
    total_cards = db.query(func.sum(CollectionItem.quantity)).scalar() or 0
    unique_cards = db.query(CollectionItem.card_id).distinct().count()
    
    # Recent additions (last 24 hours)
    yesterday = datetime.datetime.now() - datetime.timedelta(days=1)
    recent_items = db.query(CollectionItem).filter(CollectionItem.added_at > yesterday).limit(50).all()
    
    recent_list = []
    for item in recent_items:
        card = db.query(Card).filter(Card.id == item.card_id).first()
        if card:
            recent_list.append({"name": card.name, "set": card.set_id, "quantity": item.quantity})

    journal_entries = read_recent_obsidian_notes(days=7)

    return {
        "total_cards": total_cards,
        "unique_cards": unique_cards,
        "recent_additions": recent_list,
        "recent_journal": journal_entries
    }

def run_night_shift(db: Session):
    """Executes the Night Shift: reads context, generates insights, and logs to DB."""
    context = build_context_packet(db)
    
    prompt = f"""
    You are John John, the ambient AI curator of a local Pokémon TCG archive.
    Your tone is Contemporary, Human, Confident, Warm. 
    You do NOT use rainbows, emojis, or excessive enthusiasm. You are a quiet, stark professional.
    
    Here is the current Context Packet:
    {json.dumps(context, indent=2)}
    
    Write 1 to 3 "Notes" for the user. These notes will appear quietly on their dashboard.
    Output strictly as JSON:
    {{
        "notes": [
            {{
                "kind": "curation", // or 'recent', 'milestone', 'action'
                "title": "Short title",
                "body": "The text of the note",
                "href": "/collection" // Optional link to a page
            }}
        ]
    }}
    """
    
    try:
        model = genai.GenerativeModel('gemini-2.5-pro')
        response = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
        data = json.loads(response.text)
        
        # Write notes to DB
        user_id = 1 # Assuming single-user for now
        for n in data.get("notes", []):
            new_note = JohnJohnNote(
                user_id=user_id,
                kind=n.get("kind", "curation"),
                title=n.get("title", "Note"),
                body=n.get("body", ""),
                href=n.get("href")
            )
            db.add(new_note)
        db.commit()
    except Exception as e:
        print(f"Night Shift Error: {e}")
