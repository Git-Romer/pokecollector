import {PRIVACY_DATA_POINTS} from './privacyData'

test('states the local Privacy & Data boundary', () => {
    const text = PRIVACY_DATA_POINTS.map((point) => `${point.title} ${point.body}`).join(' ')

    expect(text).toMatch(/local/i)
    expect(text).toMatch(/External AI is disabled by default/i)
    expect(text).toMatch(/HoloDex, Collectr, PSA, TAG/)
    expect(text).toMatch(/Excel export is local/)
    expect(text).toMatch(/Scheduled backups remain off/)
    expect(text).toMatch(/live smoke check/)
    expect(text).toMatch(/visible local destination/)
})
