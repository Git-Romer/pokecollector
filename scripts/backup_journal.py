import urllib.request
import urllib.parse
import json
import os
import datetime

# Configuration
ENV_FILE = r"V:\dev\src\external\pokecollector\.env"
O_DRIVE_BACKUP_DIR = r"O:\Pokemon_TCG_Tracker\Backups"
O_DRIVE_JOURNAL_DIR = r"O:\Pokemon_TCG_Tracker\Journal"

os.makedirs(O_DRIVE_BACKUP_DIR, exist_ok=True)
os.makedirs(O_DRIVE_JOURNAL_DIR, exist_ok=True)

# Parse .env for credentials
env_vars = {}
with open(ENV_FILE, "r") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            env_vars[key.strip()] = val.strip()

username = env_vars.get("ADMIN_USERNAME", "admin")
password = env_vars.get("ADMIN_PASSWORD", "")

# 1. Login to get JWT
login_data = urllib.parse.urlencode({"username": username, "password": password}).encode("ascii")
req = urllib.request.Request("http://localhost:8000/api/v1/auth/login", data=login_data)
with urllib.request.urlopen(req) as response:
    auth_data = json.loads(response.read().decode())
    token = auth_data["access_token"]

headers = {"Authorization": f"Bearer {token}"}

# 2. Download XLSX Backup
req_xlsx = urllib.request.Request("http://localhost:8000/api/v1/collection/export/xlsx", headers=headers)
date_str = datetime.date.today().isoformat()
xlsx_path = os.path.join(O_DRIVE_BACKUP_DIR, f"Pokemon_Collection_{date_str}.xlsx")
with urllib.request.urlopen(req_xlsx) as response, open(xlsx_path, "wb") as out_file:
    out_file.write(response.read())

# 3. Get Dashboard Data for Journal
req_dash = urllib.request.Request("http://localhost:8000/api/v1/dashboard", headers=headers)
with urllib.request.urlopen(req_dash) as response:
    dash_data = json.loads(response.read().decode())

# 4. Generate Obsidian Journal
total_cards = dash_data.get("total_cards", 0)
unique_cards = dash_data.get("unique_cards", 0)
total_value = dash_data.get("total_value", 0.0)
currency = dash_data.get("currency", "EUR")
recent_additions = dash_data.get("recent_additions", [])

journal_path = os.path.join(O_DRIVE_JOURNAL_DIR, f"Journal_{date_str}.md")
with open(journal_path, "w", encoding="utf-8") as jf:
    jf.write(f"---\n")
    jf.write(f"date: {date_str}\n")
    jf.write(f"tags: [pokemon, collection, journal]\n")
    jf.write(f"---\n\n")
    jf.write(f"# Pokémon TCG Tracker - {date_str}\n\n")
    jf.write(f"## Collection Health\n")
    jf.write(f"- **Total Cards**: {total_cards}\n")
    jf.write(f"- **Unique Cards**: {unique_cards}\n")
    jf.write(f"- **Total Value**: {total_value:.2f} {currency}\n\n")
    
    jf.write(f"## Recent Acquisitions\n")
    if recent_additions:
        for card in recent_additions[:5]:
            jf.write(f"- {card.get('name', 'Unknown')} ({card.get('set_ref', {}).get('name', 'Unknown Set')})\n")
    else:
        jf.write(f"- No recent additions.\n")

print(f"Successfully backed up XLSX to {xlsx_path}")
print(f"Successfully generated Obsidian journal at {journal_path}")
