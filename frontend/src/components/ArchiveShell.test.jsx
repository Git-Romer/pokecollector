import {PRIMARY_ARCHIVE_DESTINATIONS} from './archiveNavigation'

test('keeps the five primary destinations', () => {
    // Sets → All Cards and Analytics → Trends & Insights were renamed for
    // clarity; the routes /sets and /analytics still redirect to the new
    // paths, so old links keep working. The count of five is the contract.
    expect(PRIMARY_ARCHIVE_DESTINATIONS.map((item) => item.label)).toEqual([
        'Collection',
        'Card Search',
        'All Cards',
        'Trends & Insights',
        'Settings',
    ])
})
