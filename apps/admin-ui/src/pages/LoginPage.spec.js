import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import LoginPage from './LoginPage.vue'
import { state } from '../store'

// The login screen is the one place the UI talks about credentials, so what it does with a
// refusal matters as much as what it does with a success: it repeats the API's message and
// invents nothing about why the sign-in failed.

function stubFetch(answers) {
  const calls = []

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const path = new URL(url, 'http://local').pathname.replace(/^\/api/, '')

    calls.push({ path, body: options.body ? JSON.parse(options.body) : null })

    const answer = answers[path] || { status: 500, body: { status: 'error', error: `no stub for ${path}` } }

    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' }
    })
  }))

  return calls
}

function resetAuth(stage, bootstrapLogin = null) {
  Object.assign(state, {
    ready: false,
    authStage: stage,
    authUser: null,
    authRoles: [],
    bootstrapLogin,
    authError: null,
    authBusy: false
  })
}

/** The fields in render order: login, password, and on first run the confirmation. */
function fields(wrapper) {
  const inputs = wrapper.findAll('input')

  return { login: inputs[0], password: inputs[1], confirmation: inputs[2] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginPage', () => {
  it('posts the credentials to /auth/login', async () => {
    resetAuth('login')
    const calls = stubFetch({
      '/auth/login': { status: 200, body: { status: 'ok', user: { id: 'au1', login: 'sysadmin', roles: [] } } }
    })
    const wrapper = mount(LoginPage)
    const input = fields(wrapper)

    await input.login.setValue('  sysadmin  ')
    await input.password.setValue('correct horse battery')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(calls[0]).toEqual({
      path: '/auth/login',
      // Trimmed login, untouched password — a space in a password is part of it.
      body: { login: 'sysadmin', password: 'correct horse battery' }
    })
  })

  it('shows the API message on a refusal and says nothing more specific', async () => {
    resetAuth('login')
    stubFetch({
      '/auth/login': { status: 401, body: { status: 'error', error: 'Invalid login or password' } }
    })
    const wrapper = mount(LoginPage)
    const input = fields(wrapper)

    await input.login.setValue('sysadmin')
    await input.password.setValue('wrong')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const text = wrapper.text()

    expect(text).toContain('Invalid login or password')
    expect(text).not.toContain('нет такого пользователя')
    // The login survives the refusal, the password does not.
    expect(input.login.element.value).toBe('sysadmin')
    expect(input.password.element.value).toBe('')
  })

  it('renders the first-run form only in the bootstrap state, prefilled with its login', () => {
    resetAuth('login')
    expect(mount(LoginPage).text()).not.toContain('Первый вход')

    resetAuth('activate', 'sysadmin')
    const wrapper = mount(LoginPage)

    expect(wrapper.text()).toContain('Первый вход')
    expect(wrapper.findAll('input')).toHaveLength(3)
    expect(fields(wrapper).login.element.value).toBe('sysadmin')
  })

  it('refuses to submit the first run until both passwords agree', async () => {
    resetAuth('activate', 'sysadmin')
    const calls = stubFetch({})
    const wrapper = mount(LoginPage)
    const input = fields(wrapper)

    await input.password.setValue('first-password')
    await input.confirmation.setValue('second-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Пароли не совпадают')
    expect(calls).toHaveLength(0)
  })

  it('activates and then signs in with the password just chosen', async () => {
    resetAuth('activate', 'sysadmin')
    const calls = stubFetch({
      '/auth/activate': { status: 200, body: { status: 'ok', user: { id: 'au1', login: 'sysadmin' } } },
      '/auth/login': { status: 200, body: { status: 'ok', user: { id: 'au1', login: 'sysadmin', roles: ['system_admin'] } } }
    })
    const wrapper = mount(LoginPage)
    const input = fields(wrapper)

    await input.password.setValue('bootstrap-password')
    await input.confirmation.setValue('bootstrap-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(calls.map((call) => call.path).slice(0, 2)).toEqual(['/auth/activate', '/auth/login'])
    expect(calls[1].body).toEqual({ login: 'sysadmin', password: 'bootstrap-password' })
  })

  it('keeps the first-run form up and shows why when activation is refused', async () => {
    resetAuth('activate', 'sysadmin')
    const calls = stubFetch({
      '/auth/activate': { status: 400, body: { status: 'error', error: 'password must be at least 10 characters' } }
    })
    const wrapper = mount(LoginPage)
    const input = fields(wrapper)

    await input.password.setValue('short')
    await input.confirmation.setValue('short')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('password must be at least 10 characters')
    expect(calls.map((call) => call.path)).toEqual(['/auth/activate'])
    expect(state.authStage).toBe('activate')
  })
})
