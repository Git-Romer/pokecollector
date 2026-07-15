import re

with open('frontend/src/pages/Home.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

if 'ColorBends' not in content:
    content = content.replace("import OrbitImages from '../components/reactbits/OrbitImages'", "import OrbitImages from '../components/reactbits/OrbitImages'\nimport ColorBends from '../components/reactbits/ColorBends'")

old_orbit_div = '''<div className="flex-1 relative hidden md:block min-h-[300px]">
      <div className="mag-barcode">7390284719204</div>
      <OrbitImages 
        images={recent.slice(0, 5).map(c => c.image_url || c.image || '/cardback.jpg')} 
        centralText="JJ" 
      />
    </div>'''

new_orbit_div = '''<ColorBends className="flex-1 relative hidden md:block min-h-[300px]" opacity={0.6}>
      <div className="mag-barcode">7390284719204</div>
      <OrbitImages 
        images={recent.slice(0, 5).map(c => c.image_url || c.image || '/cardback.jpg')} 
        centralText="JJ" 
      />
    </ColorBends>'''

content = content.replace(old_orbit_div, new_orbit_div)

with open('frontend/src/pages/Home.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
