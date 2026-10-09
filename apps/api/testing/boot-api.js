'use strict';

// Boots apps/api/src/server.js as a child process against a given DATABASE_URL.
// The API entrypoint self-starts its listener on require, so an out-of-process
// boot is the only way to exercise the handler layer without restructuring it.

const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'server.js');

// Reads the port out of the child's startup line. Picking a free port here and handing
// it to the child loses the race: between closing the probe socket and the child binding,
// a parallel suite can take the same port, and the child dies with EADDRINUSE. Letting the
// OS assign it inside the process that keeps it is the only version without a window.
function readBoundPort(child, chunks, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`api did not report a port in ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    function onData() {
      const match = /listening on port (\d+)/.exec(chunks.join(''));
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`api exited before listening (code ${code}, signal ${signal})`));
    }

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitForHealth(baseUrl, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`/health responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`api did not become healthy in ${timeoutMs}ms: ${lastError && lastError.message}`);
}

/**
 * @param {{ databaseUrl: string, env?: Record<string, string> }} options
 * @returns {Promise<{ baseUrl: string, port: number, stop: () => Promise<void>, output: () => string }>}
 */
async function startApi(options) {
  const chunks = [];

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: '0',
      DATABASE_URL: options.databaseUrl,
      APP_TIMEZONE: process.env.APP_TIMEZONE || 'Europe/Moscow',
      ...(options.env || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => chunks.push(chunk.toString()));

  const output = () => chunks.join('');

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });

  let port = null;
  let baseUrl = null;

  try {
    port = await readBoundPort(child, chunks);
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- api output ---\n${output()}`);
  }

  return { baseUrl, port, stop, output };
}

module.exports = { startApi, waitForHealth };
