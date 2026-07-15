with open('frontend/src/pages/BinderDetail.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

import_line = "import SplitText from '../components/reactbits/SplitText'\n"
content = content.replace(import_line, '')
content = import_line + content

with open('frontend/src/pages/BinderDetail.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
