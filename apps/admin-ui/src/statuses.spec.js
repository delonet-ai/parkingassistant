import { describe, expect, it } from 'vitest'

import {
  PLACE_STATUS_OPTIONS,
  positionLabel,
  sourceColors,
  sourceLabel,
  statusColors,
  statusLabel
} from './statuses'

describe('place statuses', () => {
  it('keeps the six statuses and their Russian words from the SSR UI', () => {
    expect(PLACE_STATUS_OPTIONS.map((option) => option.status)).toEqual([
      'free',
      'released',
      'occupied',
      'guest',
      'rotatable',
      'blocked'
    ])
    expect(PLACE_STATUS_OPTIONS.map((option) => option.label)).toEqual([
      'свободно',
      'отдано',
      'занято',
      'гостевое',
      'ротируемое',
      'недоступно'
    ])
  })

  it('prints the status word, not the raw English token', () => {
    expect(statusLabel('rotatable')).toBe('ротируемое')
  })

  it('falls back to the raw value rather than rendering nothing for an unknown status', () => {
    // A status added to the domain must show up as itself instead of disappearing.
    expect(statusLabel('reserved-by-martians')).toBe('reserved-by-martians')
    expect(statusLabel(null)).toBe('—')
  })

  it('colours every status from design-system tokens, never a hard-coded hex', () => {
    // The form matters as much as the token. --vi-color-* holds a hex (#cfeed7), while the
    // deprecated --vi-primary layer holds an RGB triplet — so wrapping a new token in rgb()
    // produces rgb(#cfeed7), which the browser drops along with the whole declaration. That
    // is what left the first build with no nameplates, no slot borders and a flat white page.
    for (const option of PLACE_STATUS_OPTIONS) {
      const colors = statusColors(option.status)

      expect(colors.backgroundColor).toMatch(/^var\(--vi-color-[a-z]+-\d+\)$/)
      expect(colors.textColor).toMatch(/^var\(--vi-color-[a-z]+-\d+\)$/)
    }
  })

  it('names slot positions front to rear so the card mirrors the real line', () => {
    expect(positionLabel(3, 1)).toBe('перёд')
    expect(positionLabel(3, 2)).toBe('середина')
    expect(positionLabel(3, 3)).toBe('зад')
    expect(positionLabel(2, 1)).toBe('перёд')
    expect(positionLabel(1, 1)).toBe('')
  })
})

describe('reservation sources', () => {
  it('names every source the API can report', () => {
    expect(sourceLabel('manual')).toBe('ручное')
    expect(sourceLabel('auto')).toBe('авто')
    expect(sourceLabel('queue')).toBe('очередь')
    expect(sourceLabel('guest')).toBe('гость')
    expect(sourceLabel('permanent')).toBe('постоянное')
  })

  it('shows an unknown source as itself rather than swallowing it', () => {
    expect(sourceLabel('teleport')).toBe('teleport')
    expect(sourceColors('teleport').backgroundColor).toMatch(/gray/)
  })

  it('colours sources from tokens, like the statuses', () => {
    for (const source of ['manual', 'auto', 'queue', 'guest', 'permanent']) {
      expect(sourceColors(source).backgroundColor).toMatch(/^var\(--vi-color-[a-z]+-\d+\)$/)
      expect(sourceColors(source).textColor).toMatch(/^var\(--vi-color-[a-z]+-\d+\)$/)
    }
  })
})
