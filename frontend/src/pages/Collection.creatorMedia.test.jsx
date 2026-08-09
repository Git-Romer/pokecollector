import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

test('Collection Lots expose primary creator photo and social links', () => {
    const source = readFileSync(resolve(__dirname, './Collection.jsx'), 'utf-8')

    expect(source).toContain('Creator photos')
    expect(source).toContain('primary_photo_url')
    expect(source).toContain('instagram_url')
    expect(source).toContain('pinterest_url')
    expect(source).toContain('reels_url')
    expect(source).toContain('lotImageUrl(item)')
})
