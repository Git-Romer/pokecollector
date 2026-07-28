import {PRIMARY_ARCHIVE_DESTINATIONS} from './archiveNavigation'

test('keeps the familiar five primary destinations', () => {
    expect(PRIMARY_ARCHIVE_DESTINATIONS.map((item) => item.label)).toEqual([
        'Collection',
        'Card Search',
        'Sets',
        'Analytics',
        'Settings',
    ])
})
