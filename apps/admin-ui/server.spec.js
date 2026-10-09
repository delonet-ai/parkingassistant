// @vitest-environment node
//
// A node environment, not happy-dom: this spec drives the real HTTP server over the loopback
// and happy-dom's fetch applies the browser's same-origin policy to it.
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The proxy is the only part of this app that is not a Vue component, and the session makes it
// load-bearing: the cookie has to cross it in both directions. A spec that stubbed `fetch`
// would prove nothing here, so this one runs the real server.js against a stub API.

const HERE = path.dirname(fileURLToPath(import.meta.url))

let api = null
let received = []
let child = null
let baseUrl = ''

function startStubApi() {
  return new Promise((resolve) => {
    api = http.createServer((req, res) => {
      received.push({ url: req.url, cookie: req.headers.cookie || null, contentType: req.headers['content-type'] || null })

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': ['pa_session=token-value; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200', 'extra=1; Path=/']
      })
      res.end(JSON.stringify({ status: 'ok', service: 'api' }))
    })

    api.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${api.address().port}`))
  })
}

function startUi(apiBaseUrl) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
      env: { ...process.env, PORT: '0', API_BASE_URL: apiBaseUrl },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => reject(new Error('admin-ui server did not announce a port')), 10000)

    child.stdout.on('data', (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk))

      if (match) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })
    child.on('error', reject)
  })
}

beforeAll(async () => {
  baseUrl = await startUi(await startStubApi())
}, 20000)

afterAll(async () => {
  if (child) {
    child.kill('SIGTERM')
  }
  if (api) {
    await new Promise((resolve) => api.close(resolve))
  }
})

describe('admin-ui proxy', () => {
  it('carries the session cookie upstream', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { cookie: 'pa_session=the-token' }
    })

    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].cookie).toBe('pa_session=the-token')
    expect(received[0].url).toBe('/admin/dashboard')
  })

  it('returns every set-cookie the API sent, unjoined', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'sysadmin', password: 'a-real-password' })
    })

    expect(response.status).toBe(200)
    // Without this the login answers 200, this process eats the cookie, and the next
    // request is anonymous.
    expect(response.headers.getSetCookie()).toEqual([
      'pa_session=token-value; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200',
      'extra=1; Path=/'
    ])
    expect(received[0].contentType).toBe('application/json')
  })
})
