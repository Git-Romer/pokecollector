import re

with open('frontend/src/pages/Home.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

if 'OrbitImages' not in content:
    content = content.replace("import AnimatedCard from '../components/reactbits/AnimatedCard'", "import AnimatedCard from '../components/reactbits/AnimatedCard'\nimport OrbitImages from '../components/reactbits/OrbitImages'")

old_featured = '''{featured && <AnimatedCard className="archive-featured p-4 flex gap-4 mag-card-featured"><div className="h-44 w-28 shrink-0 overflow-hidden rounded-lg"><CardImage src={featured.image_url || featured.image} alt={featured.name} /></div><div><Text weight="semibold">Featured addition</Text><h2 className="mt-2 text-2xl font-semibold">{featured.name}</h2><p className="mt-2 text-text-secondary">Recently filed in your archive.</p><Link className="mt-4 inline-block" to="/collection">View collection</Link></div></AnimatedCard>}'''

new_featured = '''
{recent.length > 0 && (
  <div className="flex flex-col md:flex-row items-center gap-12 my-12 relative overflow-hidden p-8 border-4 border-black bg-white" style={{boxShadow: '10px 10px 0 #00B4D8'}}>
    <div className="flex-1 z-10 relative">
      <span className="mag-issue">VOL. 01</span>
      <h2 className="text-6xl font-bold text-text-primary mag-heading uppercase leading-none mt-2">
        <SplitText text="THE LATEST DROPS" delay={40} />
      </h2>
      <p className="mt-4 text-xl font-bold border-l-4 border-black pl-4">
        Fresh ink. New arrivals straight to the archive.
      </p>
      <Link className="mt-6 inline-block bg-black text-white px-6 py-3 font-bold uppercase tracking-wider hover:-translate-y-1 transition-transform" style={{boxShadow: '4px 4px 0 #03045E'}} to="/collection">
        Access Full Archive
      </Link>
    </div>
    <div className="flex-1 relative hidden md:block min-h-[300px]">
      <div className="mag-barcode">7390284719204</div>
      <OrbitImages 
        images={recent.slice(0, 5).map(c => c.image_url || c.image || '/cardback.jpg')} 
        centralText="JJ" 
      />
    </div>
  </div>
)}
'''

content = content.replace(old_featured, new_featured)

with open('frontend/src/pages/Home.jsx', 'w', encoding='utf-8') as f:
    f.write(content)
