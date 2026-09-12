import { expect, test } from '@playwright/test'

test('root canvas stays opaque without blocking vertical scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/__card-system')

  const initial = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    const bodyStyle = getComputedStyle(document.body)
    return {
      rootBackground: rootStyle.backgroundColor,
      bodyBackground: bodyStyle.backgroundColor,
      rootOverflowX: rootStyle.overflowX,
      bodyOverflowX: bodyStyle.overflowX,
    }
  })

  expect(initial).toEqual({
    rootBackground: 'rgb(8, 8, 15)',
    bodyBackground: 'rgb(8, 8, 15)',
    rootOverflowX: 'hidden',
    bodyOverflowX: 'hidden',
  })

  const scrolling = await page.evaluate(() => {
    const overflowProbe = document.createElement('div')
    overflowProbe.style.width = '1000px'
    overflowProbe.style.height = '2000px'
    document.body.appendChild(overflowProbe)

    window.scrollTo(500, 100)
    const result = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }

    overflowProbe.remove()
    window.scrollTo(0, 0)
    return result
  })

  expect(scrolling.scrollX).toBe(0)
  expect(scrolling.scrollY).toBeGreaterThan(0)
  expect(scrolling.rootScrollWidth).toBe(scrolling.viewportWidth)

  const themedRootBackground = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'fire'
    return getComputedStyle(document.documentElement).backgroundColor
  })
  expect(themedRootBackground).toBe('rgb(15, 8, 5)')
})
