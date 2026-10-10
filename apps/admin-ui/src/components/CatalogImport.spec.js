import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CatalogImport from './CatalogImport.vue'
import { state } from '../store'

const DRY_RUN = {
  status: 'ok',
  import: {
    dryRun: true,
    placesStaged: 5,
    placesCreated: 3,
    placesUpdated: 2,
    linesCreated: 1,
    linesUpdated: 2,
    rowsRead: 7,
    sheet: 'Лист1'
  },
  problems: [
    { row: 4, reason: 'duplicate_code', code: '101', floor: 'G4', place: '101', status: 'Закреплено' },
    { row: 6, reason: 'place_without_digits', code: null, floor: 'G4', place: 'итого', status: 'x' }
  ]
}

const APPLIED = {
  status: 'ok',
  import: { ...DRY_RUN.import, dryRun: false },
  problems: DRY_RUN.problems
}

/** Answers each call in turn; `loadDay()` after an apply reads through the same stub. */
function stub(answers) {
  const queue = [...answers]
  const fetchMock = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]

    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

const buttonBy = (wrapper, text) =>
  wrapper.findAll('button').find((button) => button.text().includes(text))

/** happy-dom will not let a test pick a file, so the chosen one is planted on the input. */
async function choose(wrapper, filename = 'parking-catalog.xlsx') {
  const input = wrapper.find('input[type="file"]')
  const file = new File([new Uint8Array([1, 2, 3])], filename, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })

  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')

  return file
}

afterEach(() => {
  vi.unstubAllGlobals()
  state.notice = null
})

describe('CatalogImport', () => {
  it('cannot check anything before a file is chosen', () => {
    const wrapper = mount(CatalogImport)

    expect(buttonBy(wrapper, 'Проверить файл').attributes('disabled')).toBeDefined()
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
  })

  it('checks the file as a dry run and offers to apply only afterwards', async () => {
    const fetchMock = stub([{ body: DRY_RUN }])
    const wrapper = mount(CatalogImport)

    await choose(wrapper, 'катало́г.xlsx')
    expect(wrapper.text()).toContain('катало́г.xlsx')
    // Choosing a file writes nothing by itself: the operator asks for the check.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()

    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/admin/catalog-import')
    expect(options.method).toBe('POST')
    expect(options.body.get('dryRun')).toBe('true')
    expect(options.body.get('catalogFile').name).toBe('катало́г.xlsx')

    // The counts the API answered, rendered for approval — and the rows it refused.
    expect(wrapper.text()).toContain('создать 3')
    expect(wrapper.text()).toContain('обновить 2')
    expect(wrapper.text()).toContain('строка 4')
    expect(wrapper.text()).toContain('номер места повторяется — строка пропущена')
    expect(wrapper.text()).toContain('в номере места нет цифр')
    expect(buttonBy(wrapper, 'Применить')).toBeDefined()
  })

  it('applies with dryRun=false and reloads the day', async () => {
    const fetchMock = stub([{ body: DRY_RUN }, { body: APPLIED }, { body: { status: 'ok' } }])
    const wrapper = mount(CatalogImport)

    await choose(wrapper)
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    await buttonBy(wrapper, 'Применить').trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls[1][1].body.get('dryRun')).toBe('false')
    expect(state.notice.type).toBe('success')
    expect(state.notice.text).toContain('создано 3')
    // The day is reloaded, so the Места tab shows the catalog that was just written.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes('/api/admin/places'))).toBe(true)

    // Nothing is left armed: the preview and the file are gone after a successful apply.
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
    expect(buttonBy(wrapper, 'Проверить файл').attributes('disabled')).toBeDefined()
  })

  it('drops the approved preview when another file is chosen', async () => {
    stub([{ body: DRY_RUN }])
    const wrapper = mount(CatalogImport)

    await choose(wrapper)
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()
    expect(buttonBy(wrapper, 'Применить')).toBeDefined()

    await choose(wrapper, 'other.xlsx')

    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
    expect(wrapper.text()).not.toContain('создать 3')
  })

  it('shows the refused rows when the API rejects the workbook', async () => {
    stub([
      {
        status: 400,
        body: {
          status: 'error',
          error: 'No parking places were understood in this workbook',
          problems: [{ row: 3, reason: 'missing_required_cells', code: null, floor: '', place: '', status: '' }]
        }
      }
    ])
    const wrapper = mount(CatalogImport)

    await choose(wrapper, 'wrong.xlsx')
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    expect(state.notice.type).toBe('error')
    expect(state.notice.text).toContain('No parking places were understood')
    expect(wrapper.text()).toContain('не заполнены уровень, место или статус')
    // A refusal never arms the apply button.
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
  })

  it('says how many refused rows were left out of the list', async () => {
    // The API caps the list it answers with; without the count the operator reads 200 refusals
    // and concludes the rest of the file was fine.
    stub([
      {
        status: 400,
        body: {
          status: 'error',
          error: 'No parking places were understood in this workbook',
          problems: [{ row: 3, reason: 'place_without_digits', code: null, floor: 'G4', place: 'итого', status: 'Закреплено' }],
          problemsTotal: 1201
        }
      }
    ])
    const wrapper = mount(CatalogImport)

    await choose(wrapper, 'wrong.xlsx')
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('и ещё 1200')
    expect(wrapper.text()).toContain('показаны первые 1')
  })

  it('reports a network failure instead of leaving the button spinning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const wrapper = mount(CatalogImport)

    await choose(wrapper)
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    expect(state.notice.type).toBe('error')
    expect(state.notice.text).toContain('сеть недоступна')
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
    // The spinner is cleared, so the operator can retry.
    expect(buttonBy(wrapper, 'Проверить файл').attributes('disabled')).toBeUndefined()
  })

  it('refuses an ok answer that carries no import at all', async () => {
    // A proxy or gateway answering 200 with HTML. Dereferencing `payload.import` here used to
    // throw inside the handler, which cleared the spinner and showed nothing.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    ))
    const wrapper = mount(CatalogImport)

    await choose(wrapper)
    await buttonBy(wrapper, 'Проверить файл').trigger('click')
    await flushPromises()

    expect(state.notice.type).toBe('error')
    expect(buttonBy(wrapper, 'Применить')).toBeUndefined()
  })
})
