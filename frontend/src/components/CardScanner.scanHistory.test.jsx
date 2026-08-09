import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

test('scanner surfaces 14-day local scan history retention without implying ownership', () => {
    const source = readFileSync(resolve(__dirname, './CardScanner.jsx'), 'utf-8')
    const api = readFileSync(resolve(__dirname, '../api/client.js'), 'utf-8')

    expect(source).toContain('Local scan history retained for 14 days')
    expect(source).toContain('results.scan_history?.expires_at')
    expect(api).toContain("/cards/scan-history")
})
