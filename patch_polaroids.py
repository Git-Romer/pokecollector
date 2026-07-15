import re

with open('frontend/src/pages/Home.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

old_recent = '<Link key={card.id || card.card_id} to="/collection" className="archive-recent-card"><div className="aspect-[2/3] overflow-hidden rounded-lg"><CardImage src={card.image_url || card.image} alt={card.name} /></div><span>{card.name}</span></Link>'

new_recent = '''<Link key={card.id || card.card_id} to="/collection" className="polaroid-card block w-full" style={{ '--rand': Math.random() }}><div className="aspect-[2/3] overflow-hidden border-2 border-black"><CardImage src={card.image_url || card.image} alt={card.name} /></div><div className="mt-4 font-bold text-center text-sm uppercase tracking-wide truncate px-2">{card.name}</div></Link>'''

content = content.replace(old_recent, new_recent)

with open('frontend/src/pages/Home.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
