'use strict';

// Post-deploy smoke check for the test stand: run it from the dev container after Portainer has
// redeployed the stack. It only reads — no writes, no restarts — so it is safe against prod too.
//
//   npm run smoke:stand
//   SMOKE_STAND_HOST=192.168.0.100 npm run smoke:stand

const DEFAULT_HOST = '192.168.0.100';
const DEFAULT_API_PORT = 3330;
const DEFAULT_ADMIN_PORT = 3340;
const DEFAULT_TIMEOUT_MS = 10_000;

function isOkJson(payload, service) {
  return Boolean(payload) && typeof payload === 'object' && payload.status === 'ok' && payload.service === service;
}

// Pure: given the stand's coordinates, produce the ordered list of checks to run. Kept separate
// from the network calls so the check list itself is unit-testable.
function buildChecks({ host = DEFAULT_HOST, apiPort = DEFAULT_API_PORT, adminPort = DEFAULT_ADMIN_PORT } = {}) {
  const apiBase = `http://${host}:${apiPort}`;
  const adminBase = `http://${host}:${adminPort}`;

  return [
    {
      name: 'api health',
      url: `${apiBase}/health`,
      expectedStatus: 200,
      verify: (payload) => isOkJson(payload, 'api')
    },
    {
      name: 'api database health',
      url: `${apiBase}/health/db`,
      expectedStatus: 200,
      verify: (payload) => Boolean(payload) && typeof payload === 'object' && payload.status === 'ok'
    },
    {
      name: 'admin-web health',
      url: `${adminBase}/health`,
      expectedStatus: 200,
      verify: (payload) => isOkJson(payload, 'admin-web')
    },
    {
      name: 'admin-web day view renders',
      url: `${adminBase}/?view=day`,
      expectedStatus: 200,
      verify: (payload) => typeof payload === 'string' && payload.includes('Parking Assistant')
    }
  ];
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Pure: decide the verdict for one check from what came back over the wire.
function evaluate(check, { status, body }) {
  if (status !== check.expectedStatus) {
    return { name: check.name, url: check.url, ok: false, reason: `expected ${check.expectedStatus}, got ${status}` };
  }

  if (!check.verify(parseBody(body))) {
    return { name: check.name, url: check.url, ok: false, reason: `unexpected payload: ${String(body).slice(0, 200)}` };
  }

  return { name: check.name, url: check.url, ok: true };
}

async function runCheck(check, timeoutMs) {
  try {
    const response = await fetch(check.url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return evaluate(check, { status: response.status, body });
  } catch (error) {
    return { name: check.name, url: check.url, ok: false, reason: error.message };
  }
}

async function main() {
  const options = {
    host: process.env.SMOKE_STAND_HOST || DEFAULT_HOST,
    apiPort: Number(process.env.SMOKE_STAND_API_PORT || DEFAULT_API_PORT),
    adminPort: Number(process.env.SMOKE_STAND_ADMIN_PORT || DEFAULT_ADMIN_PORT)
  };
  const timeoutMs = Number(process.env.SMOKE_STAND_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  console.log(`Smoke-checking stand ${options.host} (api ${options.apiPort}, admin ${options.adminPort})`);

  const results = [];
  for (const check of buildChecks(options)) {
    const result = await runCheck(check, timeoutMs);
    results.push(result);
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} — ${result.url}${result.ok ? '' : `\n     ${result.reason}`}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} stand checks failed`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${results.length} stand checks passed`);
}

module.exports = { buildChecks, evaluate, DEFAULT_HOST, DEFAULT_API_PORT, DEFAULT_ADMIN_PORT };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
