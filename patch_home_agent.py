import re

with open('frontend/src/pages/Home.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove deriveArchiveInsights
content = re.sub(r"import \{ deriveArchiveInsights \}[^\n]+\n", "", content)

# Change notes definition
old_notes = "  const notes = deriveArchiveInsights({ recentAdditions: recent, totalCards: data.total_cards || 0, sets })"

new_notes = """
  const { data: agentNotes } = useQuery({
    queryKey: ['agent-notes'],
    queryFn: () => fetch('/api/agent/notes').then(r => r.json()),
  })
  const notes = agentNotes || []
"""

content = content.replace(old_notes, new_notes)

with open('frontend/src/pages/Home.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
