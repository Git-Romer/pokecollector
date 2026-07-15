import re

with open('frontend/src/pages/Home.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Add imports
if 'import BlurText' not in content:
    content = content.replace("import { deriveArchiveInsights } from '../utils/archiveInsights'", 
                              "import { deriveArchiveInsights } from '../utils/archiveInsights'\nimport BlurText from '../components/reactbits/BlurText'\nimport SpotlightCard from '../components/reactbits/SpotlightCard'")

# Replace loading state with BlurText
content = content.replace('<span>John John is opening the collection.</span>', '<BlurText text="John John is opening the collection..." delay={30} />')

# Replace <Card with <SpotlightCard for featured
content = content.replace('<Card className="archive-featured">', '<SpotlightCard className="archive-featured p-4 flex gap-4">')
content = content.replace('</Card>}', '</SpotlightCard>}')

# Replace <Card with <SpotlightCard for set shelf
content = content.replace('return <Card key={set.id}>', 'return <SpotlightCard key={set.id} className="p-4 flex flex-col gap-2">')
content = content.replace('</Card> })}', '</SpotlightCard> })}')

# Replace 'John John’s Notes' header with BlurText
content = content.replace('<h2 className="section-title">John John’s Notes</h2>', '<h2 className="section-title"><BlurText text="John John’s Notes" delay={80} /></h2>')

with open('frontend/src/pages/Home.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
