import re

def patch_file(filepath, replacements):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    for old, new in replacements:
        content = content.replace(old, new)
        
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

patch_file('frontend/src/components/ArchiveShell.jsx', [
    ("import AuroraBackground from './reactbits/AuroraBackground'", "import Grainient from './reactbits/Grainient'"),
    ('<AuroraBackground className="archive-shell min-h-dvh">', '<Grainient className="archive-shell min-h-dvh">'),
    ('</AuroraBackground>', '</Grainient>'),
])

patch_file('frontend/src/pages/Home.jsx', [
    ("import SpotlightCard from '../components/reactbits/SpotlightCard'", "import AnimatedCard from '../components/reactbits/AnimatedCard'"),
    ("import BlurText from '../components/reactbits/BlurText'", "import SplitText from '../components/reactbits/SplitText'"),
    ('<SpotlightCard', '<AnimatedCard'),
    ('</SpotlightCard>', '</AnimatedCard>'),
    ('BlurText', 'SplitText'),
    ('archive-featured p-4 flex gap-4', 'archive-featured p-4 flex gap-4 mag-card-featured'),
    ('text-3xl font-semibold text-text-primary', 'text-5xl font-bold text-text-primary mag-heading'),
])

patch_file('frontend/src/components/ArchiveNote.jsx', [
    ("import SpotlightCard from './reactbits/SpotlightCard'", "import AnimatedCard from './reactbits/AnimatedCard'"),
    ("import BlurText from './reactbits/BlurText'", "import SplitText from './reactbits/SplitText'"),
    ('<SpotlightCard', '<AnimatedCard'),
    ('</SpotlightCard>', '</AnimatedCard>'),
    ('BlurText', 'SplitText'),
])
