import glob

files = glob.glob('frontend/src/pages/*.jsx')

for fpath in files:
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()

    import_line = "import SplitText from '../components/reactbits/SplitText'\n"
    if import_line in content:
        content = content.replace(import_line, '')
        content = import_line + content
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(content)
