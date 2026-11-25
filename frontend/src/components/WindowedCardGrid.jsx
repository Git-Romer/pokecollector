import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, observeWindowRect, observeWindowOffset, windowScroll, observeElementRect, observeElementOffset, elementScroll } from '@tanstack/react-virtual'

const defaultItemKey = (item, index) => item.id ?? item.binder_card_id ?? item.card?.id ?? index

const GRID = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2'
const FOCUS_TARGETS = 'a[href], button, input, select, textarea, [tabindex]'

export function gridFocusSnapshot(element, activeElement) {
  const item = activeElement?.closest?.('[data-window-item]')
  if (!item || !element.contains(item)) return null
  const index = [...item.querySelectorAll(FOCUS_TARGETS)].indexOf(activeElement)
  return index < 0 ? null : { key: item.dataset.windowItem, index }
}

export function restoreGridFocus(element, snapshot) {
  if (!snapshot) return false
  const item = [...element.querySelectorAll('[data-window-item]')].find(item => item.dataset.windowItem === snapshot.key)
  const target = item?.querySelectorAll(FOCUS_TARGETS)[snapshot.index]
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}

// The shared card system has a fixed artwork ratio and caption height. Reserving
// that same geometry for every row keeps the scrollbar stable before images load.
export function cardGridRowHeight(width, columns, gap, framePadding, captionHeight) {
  const cardWidth = (width - gap * (columns - 1)) / columns
  return Math.round(((cardWidth - framePadding * 2) * 1.4 + framePadding * 2 + captionHeight) * 64) / 64
}

/** A buffered grid using its nearest vertical scroller, or the page window. */
export default function WindowedCardGrid({ items, renderItem, label, listKey, className = GRID, measureRows = false, overscanItems = 40, deferOffscreen = false, rowHeightEstimate = null, getKey = defaultItemKey, ...gridProps }) {
  const ref = useRef(null)
  const pendingScroll = useRef(null)
  const pendingFocus = useRef(null)
  const reflowItems = useRef([])
  const releaseReflow = useRef(null)
  const reservedFootprint = useRef(null)
  const [metrics, setMetrics] = useState({ width: 0, columns: 3, gap: 8, rowHeight: 210, top: 0, scrollElement: null })
  const currentMetrics = useRef(metrics)
  const [focusedRow, setFocusedRow] = useState(null)
  const [nearViewport, setNearViewport] = useState(!deferOffscreen)

  const measure = useCallback(() => {
    const element = ref.current
    if (!element) return
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    // Suspense may hide a route while preparing its replacement. Zero-width
    // geometry is not a resize and must not replace the last usable layout.
    if (rect.width <= 0) return
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length
    const focusedItem = element.contains(document.activeElement) && document.activeElement.closest('[data-window-item]')
    if (focusedItem) setFocusedRow(Math.floor((Number(focusedItem.getAttribute('aria-posinset')) - 1) / columns))
    // Measured composite rows regroup their children at a column breakpoint.
    // Remember the exact control before React replaces its row parent.
    if (measureRows && focusedItem && columns !== currentMetrics.current.columns) {
      pendingFocus.current = gridFocusSnapshot(element, document.activeElement)
    }
    const gap = parseFloat(style.columnGap) || 8
    const estimatedRowHeight = rowHeightEstimate ?? cardGridRowHeight(rect.width, columns, gap,
      parseFloat(style.getPropertyValue('--pc-card-frame-padding')) || 4,
      parseFloat(style.getPropertyValue('--pc-card-caption-height')) || 48)
    // A stack/photo/candidate can add metadata outside the standard caption.
    // Use its actual row footprint for *all* reserved rows, not only mounted ones.
    const measuredHeight = measureRows && currentMetrics.current.width === rect.width && currentMetrics.current.columns === columns
      ? Math.max(0, ...[...element.querySelectorAll('[data-window-row]')].map(row => parseFloat(getComputedStyle(row).height))) : 0
    // Offscreen rows are intentionally unmounted. Keep their last measured
    // footprint rather than reverting a compact list to artwork-sized rows.
    const sameLayout = currentMetrics.current.width === rect.width && currentMetrics.current.columns === columns
    const rowHeight = measuredHeight || (measureRows && sameLayout ? currentMetrics.current.rowHeight : estimatedRowHeight)
    let scrollElement = element.parentElement
    while (scrollElement && scrollElement !== document.body && scrollElement !== document.documentElement) {
      // overflow-x:hidden also computes overflow-y:auto on an auto-height
      // layout wrapper. That wrapper still grows with the page; it is not the
      // viewport. Only choose ancestors that actually constrain vertical content.
      if (/(auto|scroll|overlay)/.test(getComputedStyle(scrollElement).overflowY)
        && scrollElement.scrollHeight > scrollElement.clientHeight + 1) break
      scrollElement = scrollElement.parentElement
    }
    if (scrollElement === document.body || scrollElement === document.documentElement) scrollElement = null
    const scrollOffset = scrollElement ? scrollElement.scrollTop : window.scrollY
    const viewportTop = scrollElement ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop : 0
    const top = rect.top - viewportTop + scrollOffset
    const previous = currentMetrics.current
    if (previous.scrollElement === scrollElement && previous.width === rect.width && previous.columns === columns && previous.rowHeight === rowHeight && Math.abs(previous.top - top) < 0.5) return
    // Preserve the first visible item's neighbourhood across responsive reflow.
    if (previous.width && previous.width !== rect.width && scrollOffset > previous.top && rect.bottom > viewportTop) {
      // The new range initially sees the old scroll offset. Keep the currently
      // mounted controllers until the corresponding scroll adjustment arrives.
      reflowItems.current = [...element.querySelectorAll('[data-window-item]')].map(item => Number(item.getAttribute('aria-posinset')) - 1)
      const oldRow = (scrollOffset - previous.top) / (previous.rowHeight + previous.gap)
      const itemIndex = Math.floor(oldRow) * previous.columns
      pendingScroll.current = top + (Math.floor(itemIndex / columns) + oldRow % 1) * (rowHeight + gap)
    }
    const next = { width: rect.width, columns, gap, rowHeight, top, scrollElement }
    currentMetrics.current = next
    setMetrics(next)
  }, [measureRows, rowHeightEstimate])

  useLayoutEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(ref.current)
    // Filters, selection toolbars and translated headings can move the grid.
    if (ref.current.parentElement?.parentElement) observer.observe(ref.current.parentElement.parentElement)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(releaseReflow.current) }
  }, [measure])

  // Grouped layouts can contain hundreds of grids. Reserve their complete
  // height, but do not multiply each grid's artwork/controller overscan budget.
  useLayoutEffect(() => {
    if (!deferOffscreen) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) measure()
      setNearViewport(entry.isIntersecting)
    }, { root: metrics.scrollElement, rootMargin: '600px 0px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [deferOffscreen, metrics.scrollElement, measure])

  // Folding a preceding section moves this grid without changing its size.
  // Far-away grids need their new position only when they enter the viewport.
  useLayoutEffect(() => { if (deferOffscreen && nearViewport) measure() })

  useLayoutEffect(() => {
    if (!pendingFocus.current || metrics.columns !== currentMetrics.current.columns) return
    restoreGridFocus(ref.current, pendingFocus.current)
    pendingFocus.current = null
  }, [metrics.columns])

  useLayoutEffect(() => {
    if (pendingScroll.current === null) return
    (metrics.scrollElement || window).scrollTo({ top: pendingScroll.current, behavior: 'instant' })
    pendingScroll.current = null
    // scrollTo updates the DOM offset before the virtualizer receives its scroll
    // event. Release only after that event's frame, not in the same layout pass.
    cancelAnimationFrame(releaseReflow.current)
    releaseReflow.current = requestAnimationFrame(() => { reflowItems.current = [] })
  }, [metrics])

  // TanStack invalidates estimates when getItemKey changes, not estimateSize.
  // Include height so a resize within the same column breakpoint reflows too.
  const getItemKey = useCallback(index => `${metrics.columns}:${getKey(items[index * metrics.columns] ?? {}, index * metrics.columns)}`, [items, metrics.columns, metrics.rowHeight, getKey])
  const rangeExtractor = useCallback(range => {
    const indexes = deferOffscreen && !nearViewport ? [] : defaultRangeExtractor(range)
    for (const itemIndex of reflowItems.current) {
      const row = Math.floor(itemIndex / metrics.columns)
      if (row < range.count && !indexes.includes(row)) indexes.push(row)
    }
    if (focusedRow !== null && focusedRow < range.count && !indexes.includes(focusedRow)) indexes.push(focusedRow)
    return indexes.sort((a, b) => a - b)
  }, [focusedRow, metrics.columns, deferOffscreen, nearViewport])
  const windowingEnabled = !deferOffscreen || nearViewport || focusedRow !== null
  const virtualizer = useVirtualizer({
    // Empty ranges alone still subscribe every offscreen grid to every scroll.
    // Disable its observers as well; the wrapper retains the complete footprint.
    enabled: windowingEnabled,
    // TanStack's default rounds measured rows to whole pixels, accumulating
    // error across many fractional-height rows. Preserve the CSS footprint.
    ...(measureRows ? { measureElement: element => parseFloat(getComputedStyle(element).height) } : {}),
    getScrollElement: () => metrics.scrollElement || (typeof window === 'undefined' ? null : window),
    observeElementRect: metrics.scrollElement ? observeElementRect : observeWindowRect,
    observeElementOffset: metrics.scrollElement ? observeElementOffset : observeWindowOffset,
    scrollToFn: metrics.scrollElement ? elementScroll : windowScroll,
    initialOffset: () => metrics.scrollElement?.scrollTop ?? (typeof window === 'undefined' ? 0 : window.scrollY),
    count: Math.ceil(items.length / metrics.columns),
    estimateSize: () => metrics.rowHeight,
    gap: metrics.gap,
    // Count items, not rows; composite tiles can use a smaller artwork budget.
    overscan: Math.ceil(overscanItems / metrics.columns),
    scrollMargin: metrics.top,
    getItemKey,
    rangeExtractor,
  })

  useLayoutEffect(() => {
    if (!measureRows) return
    virtualizer.measure()
    ref.current?.querySelectorAll('[data-window-row]').forEach(virtualizer.measureElement)
  }, [measureRows, metrics.width, metrics.columns, virtualizer])

  if (typeof window === 'undefined') return (
    <div {...gridProps} className={className} role="list" aria-label={label}>
      {items.map((item, index) => <div key={getKey(item, index)} role="listitem">{renderItem(item, index)}</div>)}
    </div>
  )

  const footprintKey = `${listKey}:${items.length}:${metrics.width}:${metrics.columns}:${metrics.gap}:${metrics.rowHeight}`
  const estimatedFootprint = Math.max(0, Math.ceil(items.length / metrics.columns) * (metrics.rowHeight + metrics.gap) - metrics.gap)
  const height = windowingEnabled ? virtualizer.getTotalSize()
    : reservedFootprint.current?.key === footprintKey ? reservedFootprint.current.height : estimatedFootprint
  if (windowingEnabled) reservedFootprint.current = { key: footprintKey, height }

  return (
    <div ref={ref} {...gridProps} className={className} role="list" aria-label={label} data-windowed-grid data-scroll-list={listKey} id={listKey ? `${listKey}-grid` : undefined}
      style={{ height, position: 'relative', overflowAnchor: 'none' }}
      onFocusCapture={event => {
        const item = event.target.closest('[data-window-item]')
        if (item) setFocusedRow(Math.floor((Number(item.getAttribute('aria-posinset')) - 1) / metrics.columns))
      }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRow(null) }}>
      {virtualizer.getVirtualItems().map(row => (
        <div key={row.key} data-window-row={row.index} data-index={row.index} ref={measureRows ? virtualizer.measureElement : undefined} aria-hidden={measureRows ? undefined : true}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', display: 'grid', gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`, columnGap: metrics.gap, height: measureRows ? undefined : metrics.rowHeight, transform: `translateY(${row.start - metrics.top}px)`, pointerEvents: measureRows ? undefined : 'none' }}>
          {measureRows && items.slice(row.index * metrics.columns, (row.index + 1) * metrics.columns).map((item, column) => (
            <div key={getKey(item, row.index * metrics.columns + column)} role="listitem" aria-setsize={items.length} aria-posinset={row.index * metrics.columns + column + 1} data-window-item={getKey(item, row.index * metrics.columns + column)}>
              {renderItem(item, row.index * metrics.columns + column)}
            </div>
          ))}
        </div>
      ))}
      {/* Keep fixed-size card controllers under one stable parent. Regrouping
          them into row parents on a column change would close card-owned dialogs. */}
      {!measureRows && virtualizer.getVirtualItems().flatMap(row => items.slice(row.index * metrics.columns, (row.index + 1) * metrics.columns).map((item, column) => {
        const index = row.index * metrics.columns + column
        return (
          <div key={getKey(item, index)} role="listitem" aria-setsize={items.length} aria-posinset={index + 1} data-window-item={getKey(item, index)}
            style={{ position: 'absolute', top: row.start - metrics.top, left: column * (metrics.width + metrics.gap) / metrics.columns, width: (metrics.width - metrics.gap * (metrics.columns - 1)) / metrics.columns }}>
            {renderItem(item, index)}
          </div>
        )
      }))}
    </div>
  )
}
