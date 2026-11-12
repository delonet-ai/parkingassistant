import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import UsersPage from './UsersPage.vue'
import { state } from '../store'

// The Доступ screen. Everything here asserts the *rendered* result and the *posted body* —
// the API owns every rule, so what this screen can get wrong is the shape of what it sends.

const USERS = [
  {
    id: 'au1',
    login: 'sysadmin',
    displayName: 'Системный администратор',
    authStatus: 'active',
    lastLoginAt: '2026-10-09T08:30:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    roles: [{ code: 'system_admin', name: 'Системный администратор' }]
  },
  {
    id: 'au2',
    login: 'operator',
    displayName: 'Оператор парковки',
    authStatus: 'disabled',
    lastLoginAt: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    roles: [{ code: 'parking_admin', name: 'Администратор парковки' }]
  }
]

/** Every request this screen makes, with the bodies it sent, so a spec can read them back. */
let sent = []

function stubApi({ users = USERS, write = { status: 'ok' }, writeStatus = 200 } = {}) {
  sent = []

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const path = new URL(url, 'http://local').pathname.replace(/^\/api/, '')
    sent.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })

    if (path === '/admin/users' && (options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', users }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(write), {
      status: writeStatus,
      headers: { 'content-type': 'application/json' }
    })
  }))
}

async function render(options) {
  stubApi(options)
  const wrapper = mount(UsersPage)
  await flushPromises()

  return wrapper
}

function buttonNamed(wrapper, label) {
  return wrapper.findAll('button').find((button) => button.text() === label)
}

/** The writes the screen made, which is what the spec is really about. */
function writes() {
  return sent.filter((request) => request.method === 'POST')
}

beforeEach(() => {
  Object.assign(state, { authUsers: [], authRoles: ['system_admin'], notice: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UsersPage', () => {
  it('loads the account list on mount and renders every account with its roles and status', async () => {
    const wrapper = await render()
    const text = wrapper.text()

    expect(sent[0]).toMatchObject({ path: '/admin/users', method: 'GET' })
    expect(text).toContain('sysadmin')
    expect(text).toContain('operator')
    expect(text).toContain('Системный администратор')
    expect(text).toContain('Администратор парковки')
    expect(text).toContain('активен')
    expect(text).toContain('отключён')
    expect(text).toContain('2026-10-09 08:30:00')
  })

  it('says why the screen is empty when the list cannot be read, instead of pretending there are none', async () => {
    stubApi()
    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'error', error: 'Your role does not allow this action' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    )

    const wrapper = mount(UsersPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Список не загружен')
    expect(wrapper.text()).toContain('Your role does not allow this action')
    expect(wrapper.text()).not.toContain('Учётных записей нет')
  })

  it('posts a creation with the login, the name, the password and the chosen roles', async () => {
    const wrapper = await render()
    const inputs = wrapper.findAll('input')

    await inputs[0].setValue('newoperator')
    await inputs[1].setValue('Новый оператор')
    await inputs[2].setValue('a-long-enough-password')
    await buttonNamed(wrapper, 'Создать').trigger('click')
    await flushPromises()

    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      path: '/admin/users',
      body: {
        login: 'newoperator',
        displayName: 'Новый оператор',
        password: 'a-long-enough-password',
        roles: ['parking_admin']
      }
    })
    // A successful write re-reads the list, so the table cannot drift from the backend.
    expect(sent[sent.length - 1]).toMatchObject({ path: '/admin/users', method: 'GET' })
  })

  it('will not post a creation the API would refuse: short password, no role, no login', async () => {
    const wrapper = await render()
    const inputs = wrapper.findAll('input')

    expect(buttonNamed(wrapper, 'Создать').attributes('disabled')).toBeDefined()

    await inputs[0].setValue('newoperator')
    await inputs[1].setValue('Новый оператор')
    await inputs[2].setValue('short')
    expect(buttonNamed(wrapper, 'Создать').attributes('disabled')).toBeDefined()

    await inputs[2].setValue('a-long-enough-password')
    expect(buttonNamed(wrapper, 'Создать').attributes('disabled')).toBeUndefined()

    // Unchecking the only role closes the button again: a user with no roles is refused.
    const roleBoxes = wrapper.findAll('input[type="checkbox"]')
    await roleBoxes[1].trigger('change')
    expect(buttonNamed(wrapper, 'Создать').attributes('disabled')).toBeDefined()
    expect(writes()).toHaveLength(0)
  })

  it('sends the full role set, not a delta, when roles are edited', async () => {
    const wrapper = await render()

    await buttonNamed(wrapper, 'Роли').trigger('click')
    await flushPromises()

    // ViModal teleports to the body, so the dialog is asserted on the document.
    expect(document.body.textContent).toContain('Роли · sysadmin')

    // The dialog opened on the first row — sysadmin, who holds system_admin only. Checking
    // the other role must post both codes.
    const boxes = [...document.body.querySelectorAll('input[type="checkbox"]')]
    const parkingAdmin = boxes.find((box) => box.value === 'parking_admin' && box.checked === false)
    parkingAdmin.dispatchEvent(new Event('change'))
    await flushPromises()

    const save = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Сохранить роли'
    )
    save.click()
    await flushPromises()

    expect(writes()).toHaveLength(1)
    expect(writes()[0].path).toBe('/admin/users/roles')
    expect(writes()[0].body.authUserId).toBe('au1')
    expect([...writes()[0].body.roles].sort()).toEqual(['parking_admin', 'system_admin'])
  })

  it('posts a new password for the account the dialog was opened on', async () => {
    const wrapper = await render()

    await buttonNamed(wrapper, 'Пароль').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('Новый пароль · sysadmin')

    const field = [...document.body.querySelectorAll('input[type="password"]')].pop()
    field.value = 'a-replacement-password'
    field.dispatchEvent(new Event('input'))
    await flushPromises()

    const save = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Задать пароль'
    )
    expect(save.disabled).toBe(false)
    save.click()
    await flushPromises()

    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      path: '/admin/users/password',
      body: { authUserId: 'au1', password: 'a-replacement-password' }
    })
  })

  it('renames the account the dialog was opened on, trimmed, and keeps Save off for an empty name', async () => {
    const wrapper = await render({
      write: { status: 'ok', user: { id: 'au1', login: 'sysadmin', displayName: 'Мария Иванова' } }
    })
    state.authUser = { id: 'au1', login: 'sysadmin', displayName: 'Системный администратор' }

    await buttonNamed(wrapper, 'Имя').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('Имя · sysadmin')

    const field = [...document.body.querySelectorAll('input')].pop()
    const save = () =>
      [...document.body.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Сохранить имя')

    field.value = '   '
    field.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(save().disabled).toBe(true)

    field.value = '  Мария Иванова  '
    field.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(save().disabled).toBe(false)
    save().click()
    await flushPromises()

    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({
      path: '/admin/users/display-name',
      body: { authUserId: 'au1', displayName: 'Мария Иванова' }
    })
    // Renaming yourself updates the header name without a reload.
    expect(state.authUser.displayName).toBe('Мария Иванова')
  })

  it('offers Отключить for an active account and Включить for a disabled one, and posts each', async () => {
    const wrapper = await render()

    await buttonNamed(wrapper, 'Отключить').trigger('click')
    await flushPromises()

    expect(writes()[0]).toMatchObject({ path: '/admin/users/disable', body: { authUserId: 'au1' } })

    await buttonNamed(wrapper, 'Включить').trigger('click')
    await flushPromises()

    expect(writes()[1]).toMatchObject({ path: '/admin/users/enable', body: { authUserId: 'au2' } })
  })

  it('shows the API’s refusal and keeps the dialog open so the operator can correct it', async () => {
    const wrapper = await render({
      writeStatus: 409,
      write: { status: 'error', error: 'You cannot disable your own account', code: 'conflict' }
    })

    await buttonNamed(wrapper, 'Отключить').trigger('click')
    await flushPromises()

    expect(state.notice).toEqual({ type: 'error', text: 'You cannot disable your own account' })
    // A refused write does not re-read the list: the only GET is the one from mount.
    expect(sent.filter((request) => request.method === 'GET')).toHaveLength(1)
  })

  it('states the two rules the screen cannot enforce, so a 409 is not a surprise', async () => {
    const text = (await render()).text()

    expect(text).toContain('Себя отключить нельзя')
    expect(text).toContain('роль системного администратора')
    expect(text).toContain('закрывает все активные сессии')
  })
})
