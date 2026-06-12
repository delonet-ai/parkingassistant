'use strict';

const { spawn } = require('node:child_process');

const apiPort = Number(process.env.SMOKE_API_PORT || 3999);
const adminPort = Number(process.env.SMOKE_ADMIN_PORT || 4000);
const startupTimeoutMs = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS || 5000);

const children = [];

function startProcess(name, command, args, env) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      process.stderr.write(`[${name}] exited with code=${code} signal=${signal}\n`);
    }
  });

  return child;
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

async function waitForOk(url) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function assertResponse(url, expectedStatus, predicate) {
  const response = await fetch(url);
  const text = await response.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (response.status !== expectedStatus) {
    throw new Error(`${url} expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 200)}`);
  }

  if (predicate && !predicate(data, response)) {
    throw new Error(`${url} returned unexpected payload: ${text.slice(0, 200)}`);
  }

  return data;
}

async function run() {
  process.on('exit', stopChildren);
  process.on('SIGINT', () => {
    stopChildren();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopChildren();
    process.exit(143);
  });

  startProcess('api', 'node', ['apps/api/src/server.js'], {
    PORT: String(apiPort)
  });

  await waitForOk(`http://127.0.0.1:${apiPort}/health`);

  startProcess('admin-web', 'node', ['apps/admin-web/src/server.js'], {
    PORT: String(adminPort),
    API_BASE_URL: `http://127.0.0.1:${apiPort}`
  });

  await waitForOk(`http://127.0.0.1:${adminPort}/health`);

  await assertResponse(`http://127.0.0.1:${apiPort}/health`, 200, (data) => data.status === 'ok' && data.service === 'api');
  await assertResponse(`http://127.0.0.1:${apiPort}/`, 200, (data) => Array.isArray(data.endpoints));
  await assertResponse(
    `http://127.0.0.1:${apiPort}/health/db`,
    500,
    (data) => data.status === 'error' && data.code === 'internal_error' && Object.prototype.hasOwnProperty.call(data, 'details')
  );
  await assertResponse(`http://127.0.0.1:${apiPort}/missing`, 404, (data) => data.code === 'not_found');
  await assertResponse(`http://127.0.0.1:${adminPort}/health`, 200, (data) => data.status === 'ok' && data.service === 'admin-web');

  const adminResponse = await fetch(`http://127.0.0.1:${adminPort}/`);
  const adminHtml = await adminResponse.text();
  if (!adminResponse.ok || !adminHtml.includes('Parking Assistant')) {
    throw new Error(`admin-web / returned unexpected response: ${adminResponse.status}`);
  }

  console.log('M1 smoke checks passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    stopChildren();
  });
