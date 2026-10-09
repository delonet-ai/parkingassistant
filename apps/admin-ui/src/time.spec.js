import { describe, expect, it } from 'vitest'

import { digitsToTime } from './time'

describe('digitsToTime', () => {
  it('puts the separator back into what a masked field emits', () => {
    // ViInput with mask="##:##" shows 15:30 and emits "1530".
    expect(digitsToTime('1530')).toBe('15:30')
    expect(digitsToTime('0700')).toBe('07:00')
    expect(digitsToTime('15:30')).toBe('15:30')
  })

  it('refuses an incomplete time instead of posting a half-typed one', () => {
    expect(digitsToTime('153')).toBeNull()
    expect(digitsToTime('')).toBeNull()
    expect(digitsToTime(null)).toBeNull()
  })

  it('refuses an impossible clock reading', () => {
    expect(digitsToTime('2460')).toBeNull()
    expect(digitsToTime('2400')).toBeNull()
    expect(digitsToTime('1299')).toBeNull()
    expect(digitsToTime('2359')).toBe('23:59')
  })
})
