import re

def patch_file(filepath, replacements):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    for old, new in replacements:
        content = content.replace(old, new)
        
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

patch_file('frontend/src/pages/Boxes.jsx', [
    ("import { Button, Card, Dialog, DialogBody, DialogContent, DialogSurface, Field, Input, Spinner, Text } from '@fluentui/react-components'", 
     "import { Button, Dialog, DialogBody, DialogContent, DialogSurface, Field, Input, Spinner, Text } from '@fluentui/react-components'\nimport SpotlightCard from '../components/reactbits/SpotlightCard'"),
    ('<Card className="archive-box">', '<SpotlightCard className="archive-box p-4 flex flex-col gap-2">'),
    ('</Card>', '</SpotlightCard>')
])

patch_file('frontend/src/pages/Discover.jsx', [
    ("import { Button, Card, Input, Text } from '@fluentui/react-components'",
     "import { Button, Input, Text } from '@fluentui/react-components'\nimport SpotlightCard from '../components/reactbits/SpotlightCard'"),
    ('<Card className="archive-discover-card">', '<SpotlightCard className="archive-discover-card p-4 flex flex-col items-center text-center gap-2">'),
    ('</Card>', '</SpotlightCard>')
])
