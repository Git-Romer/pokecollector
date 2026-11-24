import { describe, expect, it } from 'vitest'
import { readPwaFlags } from './flags'

const docWith = content => ({
  querySelector: () => (content === undefined ? null : { getAttribute: () => content }),
})

describe('readPwaFlags', () => {
  it('parses the meta tag', () => {
    expect(readPwaFlags(docWith('sw=1;queue=0'))).toEqual({ sw: true, queue: false })
    expect(readPwaFlags(docWith('sw=0;queue=1'))).toEqual({ sw: false, queue: true })
    expect(readPwaFlags(docWith('sw=1;queue=1'))).toEqual({ sw: true, queue: true })
  })

  it('treats garbage as off', () => {
    expect(readPwaFlags(docWith('nonsense'))).toEqual({ sw: false, queue: false })
    expect(readPwaFlags(docWith(''))).toEqual({ sw: false, queue: false })
  })

  it('falls back to the off build-time default without the meta tag', () => {
    expect(readPwaFlags(docWith(undefined))).toEqual({ sw: false, queue: false })
    expect(readPwaFlags(null)).toEqual({ sw: false, queue: false })
  })
})
