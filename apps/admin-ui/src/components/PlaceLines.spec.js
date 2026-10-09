import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PlaceLines from './PlaceLines.vue'

const LINES = [
  {
    lineId: 'line-4',
    code: 'line-4-118',
    name: 'Линия 4 / 118',
    capacity: 3,
    floorLabel: '4',
    slots: [
      { placeId: 'p1', code: '118', placeType: 'triple', position: 1, status: 'free' },
      { placeId: 'p2', code: '119', placeType: 'triple', position: 2, status: 'occupied', userDisplayName: 'Иванов И. И.' },
      { placeId: 'p3', code: '120', placeType: 'triple', position: 3, status: 'guest' }
    ]
  },
  {
    lineId: 'line-5',
    code: 'line-5-501',
    name: 'Линия 5 / 501',
    capacity: 1,
    floorLabel: '5',
    slots: [{ placeId: 'p4', code: '501', placeType: 'single', position: 1, status: 'blocked' }]
  }
]

function render(props = {}) {
  return mount(PlaceLines, { props: { lines: LINES, floorLabel: '4', ...props } })
}

describe('PlaceLines', () => {
  it('shows only the selected floor', () => {
    const wrapper = render()

    expect(wrapper.text()).toContain('118')
    expect(wrapper.text()).not.toContain('501')
  })

  it('renders every slot as a real button, so the list stays keyboard-operable', () => {
    const buttons = render().findAll('button.slot-button')

    expect(buttons).toHaveLength(3)
    expect(buttons[0].attributes('type')).toBe('button')
  })

  it('conveys status by word as well as colour', () => {
    const text = render().text()

    expect(text).toContain('свободно')
    expect(text).toContain('занято')
    expect(text).toContain('гостевое')
  })

  it('stacks slots front to rear and names who is parked there', () => {
    const text = render().text()

    expect(text).toContain('перёд')
    expect(text).toContain('середина')
    expect(text).toContain('зад')
    expect(text).toContain('Иванов И. И.')
  })

  it('marks the selected slot with aria-pressed, not with colour alone', () => {
    const buttons = render({ selectedPlaceId: 'p2' }).findAll('button.slot-button')

    expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false'
    ])
  })

  it('emits the place id when a slot is clicked', async () => {
    const wrapper = render()

    await wrapper.findAll('button.slot-button')[2].trigger('click')

    expect(wrapper.emitted('select')).toEqual([['p3']])
  })

  it('hides elements that no slot matches when a status filter is on', () => {
    expect(render({ statusFilter: 'free' }).findAll('button.slot-button')).toHaveLength(3)
    expect(render({ statusFilter: 'released' }).findAll('button.slot-button')).toHaveLength(0)
  })

  it('hides elements that no slot matches when a type filter is on', () => {
    expect(render({ typeFilter: 'triple' }).findAll('button.slot-button')).toHaveLength(3)
    expect(render({ typeFilter: 'single' }).findAll('button.slot-button')).toHaveLength(0)
  })

  it('says the floor is empty instead of rendering nothing at all', () => {
    const wrapper = render({ floorLabel: '3' })

    expect(wrapper.findAll('button.slot-button')).toHaveLength(0)
    expect(wrapper.text()).toContain('Этаж G3: линий 0.')
  })
})
