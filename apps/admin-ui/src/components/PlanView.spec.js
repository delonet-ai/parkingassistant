import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PlanView from './PlanView.vue'

const LINES = [
  {
    lineId: 'l1',
    code: 'line-4-118',
    name: 'Линия 4 / 118',
    capacity: 2,
    floorLabel: '4',
    slots: [
      { placeId: 'p1', code: '118', position: 1, status: 'free' },
      { placeId: 'p2', code: '119', position: 2, status: 'occupied', userDisplayName: 'Иванов И. И.' }
    ]
  },
  {
    lineId: 'l2',
    code: 'line-4-120',
    name: 'Линия 4 / 120',
    capacity: 1,
    floorLabel: '4',
    slots: [{ placeId: 'p3', code: '120', position: 1, status: 'guest' }]
  }
]

const MARKUP = {
  mapCode: 'g4',
  imageWidth: 1000,
  imageHeight: 600,
  revision: 2,
  planChanged: false,
  places: {
    p1: { polygon: [[100, 100], [160, 100], [160, 220], [100, 220]] },
    p2: { polygon: [[100, 220], [160, 220], [160, 340], [100, 340]] },
    p3: { polygon: [[300, 100], [360, 100], [360, 220], [300, 220]] },
    // A place the inventory no longer has: not drawn.
    gone: { polygon: [[0, 0], [10, 0], [10, 10]] }
  },
  editor: {}
}

function render(props = {}) {
  return mount(PlanView, { props: { lines: LINES, markup: MARKUP, planSrc: '/maps/plan.png', ...props } })
}

const places = (wrapper) => wrapper.findAll('polygon.plan-view__place')

describe('PlanView', () => {
  it('draws one polygon per marked place, filled with its status colour and labelled with its code', () => {
    const wrapper = render()
    const drawn = places(wrapper)

    expect(drawn).toHaveLength(3)
    expect(drawn[0].attributes('points')).toBe('100,100 160,100 160,220 100,220')
    expect(drawn[0].attributes('style')).toContain('var(--vi-color-green-200)')
    expect(drawn[1].attributes('style')).toContain('var(--vi-color-yellow-200)')
    expect(wrapper.findAll('text.plan-view__label').map((label) => label.text())).toEqual(['118', '119', '120'])
  })

  it('says the status in words and names the occupant in the tooltip', () => {
    const title = places(render())[1].find('title').text()

    expect(title).toContain('119 · занято')
    expect(title).toContain('зад')
    expect(title).toContain('Иванов И. И.')
  })

  it('frames a multi-slot line', () => {
    expect(render().findAll('polygon.plan-view__outline')).toHaveLength(1)
  })

  it('dims places that do not match the status filter instead of hiding them', () => {
    const drawn = places(render({ statusFilter: 'free' }))

    expect(drawn).toHaveLength(3)
    expect(drawn.map((place) => place.classes().includes('plan-view__place--dim'))).toEqual([false, true, true])
  })

  it('outlines the selected place', () => {
    const drawn = places(render({ selectedPlaceId: 'p3' }))

    expect(drawn[2].classes()).toContain('plan-view__place--selected')
    expect(drawn[2].attributes('aria-pressed')).toBe('true')
  })

  it('emits the place id when a place is clicked', async () => {
    const wrapper = render()

    await places(wrapper)[2].trigger('click')

    expect(wrapper.emitted('select')).toEqual([['p3']])
  })

  it('shows only the image and a hint when the floor has no markup', () => {
    const wrapper = render({ markup: null })

    expect(places(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('План ещё не размечен — разметьте его во вкладке «Места»')
  })

  it('warns when the plan image was replaced after the markup was drawn', () => {
    expect(render().text()).not.toContain('Подложка плана заменена')
    expect(render({ markup: { ...MARKUP, planChanged: true } }).text()).toContain('Подложка плана заменена')
  })
})
