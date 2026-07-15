import os
import re

PAGE_DIR = 'frontend/src/pages'

def patch_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content

    # 1. Replace SpotlightCard with AnimatedCard
    content = content.replace("import SpotlightCard from '../components/reactbits/SpotlightCard'", "import AnimatedCard from '../components/reactbits/AnimatedCard'")
    content = content.replace("<SpotlightCard", "<AnimatedCard")
    content = content.replace("</SpotlightCard>", "</AnimatedCard>")

    # 2. Add SplitText import if not present and if there's an h1 to replace
    h1_pattern = re.compile(r'<h1[^>]*>([^<]+)</h1>')
    if h1_pattern.search(content) and 'SplitText' not in content:
        # try to insert after last import
        imports_end = content.rfind("import ")
        if imports_end != -1:
            eol = content.find("\n", imports_end)
            content = content[:eol] + "\nimport SplitText from '../components/reactbits/SplitText'" + content[eol:]

    # 3. Replace <h1> with SplitText version
    def replace_h1(match):
        text = match.group(1)
        # Only replace if it doesn't already have SplitText
        if 'SplitText' in text:
            return match.group(0)
        return f'<h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2"><SplitText text="{text}" delay={{40}} /></h1>'

    content = h1_pattern.sub(replace_h1, content)

    # 4. Find headers with <p className="text-sm text-text-muted">... subtitle ...</p>
    # and change them to the mag-issue style
    p_pattern = re.compile(r'<p className="text-sm text-text-muted">([^<]+)</p>')
    def replace_p(match):
        text = match.group(1)
        if text.startswith('VOL.'):
            return match.group(0)
        return f'<span className="mag-issue">{text.upper()}</span>'
    content = p_pattern.sub(replace_p, content)

    # 5. Clean up duplicate react-query imports in Home.jsx or anywhere else
    content = re.sub(r'(import \{ useQuery \} from \'@tanstack/react-query\'\n.*?)import \{ useQuery \} from \'@tanstack/react-query\'\n', r'\1', content, flags=re.DOTALL)

    if original != content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Patched {filepath}")

for filename in os.listdir(PAGE_DIR):
    if filename.endswith('.jsx'):
        patch_file(os.path.join(PAGE_DIR, filename))
