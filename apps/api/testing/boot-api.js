'use strict';

// Boots apps/api/src/server.js as a child process against a given DATABASE_URL.
// The API entrypoint self-starts its listener on require, so an out-of-process
// boot is the only way to exercise the handler layer without restructuring it.

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'server.js');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
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
  const port = await findFreePort();
  const chunks = [];

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: options.databaseUrl,
      APP_TIMEZONE: process.env.APP_TIMEZONE || 'Europe/Moscow',
      ...(options.env || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => chunks.push(chunk.toString()));

  const output = () => chunks.join('');
  const baseUrl = `http://127.0.0.1:${port}`;

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

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- api output ---\n${output()}`);
  }

  return { baseUrl, port, stop, output };
}

module.exports = { findFreePort, startApi, waitForHealth };
