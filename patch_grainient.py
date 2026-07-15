import re

with open('frontend/src/components/reactbits/Grainient.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

content = re.sub(r'\{Array\.from\(\{ length: 10 \}\)\.map\(\(_, i\) => \([\s\S]*?</div>\n\s+\)\)\}', '', content)

with open('frontend/src/components/reactbits/Grainient.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
