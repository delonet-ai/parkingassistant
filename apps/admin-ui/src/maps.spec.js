import { describe, expect, it } from 'vitest'

import { planImageSrc } from './maps'

describe('planImageSrc', () => {
  it('uses the path the API recorded, whatever the file is called', () => {
    expect(planImageSrc({ metadata: { filePath: '/maps/parking-g3-7f3a.webp' } })).toBe(
      '/maps/parking-g3-7f3a.webp'
    )
  })

  it('prefixes a bare file name, which is what the seeds hold', () => {
    expect(planImageSrc({ metadata: { filePath: 'parking-g4.png' } })).toBe('/maps/parking-g4.png')
  })

  it('answers null for a floor with no plan, so no broken image is requested', () => {
    expect(planImageSrc({ metadata: null })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: '  ' } })).toBeNull()
    expect(planImageSrc(undefined)).toBeNull()
  })

  it('refuses a path that would leave this app, whatever the row says', () => {
    // The API stores any non-empty filePath, so the row is an attacker-controlled string for
    // an authenticated admin; none of these may become a request from an operator's browser.
    expect(planImageSrc({ metadata: { filePath: '//attacker.example/pixel.png' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: 'https://attacker.example/p.png' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: 'http://10.0.0.1/admin' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: '/etc/passwd' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: '/maps/../../etc/passwd' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: '/maps/..' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: '/maps/%2e%2e%2fsecret' } })).toBeNull()
    expect(planImageSrc({ metadata: { filePath: 'javascript:alert(1)' } })).toBeNull()
  })
})
