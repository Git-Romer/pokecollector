import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import en from '../i18n/en'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './Collection.jsx'), 'utf-8')

test('Collection is the My Collection owned-lot gallery surface', () => {
    expect(source).toContain("const [viewMode, setViewMode] = useState('grid')")
    expect(source).toContain("const activeView = ['owned', 'bulk', 'sealed', 'history'].includes(requestedView) ? requestedView : 'owned'")
    expect(source).toContain("<SplitText text={'My Collection'}")
    expect(source).toContain('Collection Lots group matching copies')
    expect(source).toContain('Gallery Showcase')
    expect(en.collection.binderView).toBe('Gallery Showcase')
    expect(source).not.toContain("title={t('collection.totalValue')}")
})


test('Collection incorporates art-collection vocabulary mapped to TCG concepts', () => {
    ;[
        'Private Collection',
        'Permanent Collection',
        'Investment-Grade Cards',
        'Personal Collection',
        'Curated Collection',
        'Collection Focus',
        'Grail',
        'Provenance',
        'Accession',
        'Deaccession',
        'Condition Report',
        'Catalog',
        'Exhibition',
        'Collection Care',
        'John John’s PC',
        'Main Collection',
        'Vault',
        'PC',
        'Collection Theme',
        'Collecting Goal',
        '★ Grail Card',
        'Card History',
        'Add to Collection',
        'Archive as Sold / Traded / Gifted',
        'Condition & Protection',
        'Collection Catalog',
        'Showcase Binder / Display Case',
        'Card Care',
    ].forEach((term) => expect(source).toContain(term))
})
