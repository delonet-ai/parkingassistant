'use strict';

// Golden/characterization suite: the HTTP behavior contract.
//
// Every endpoint group in apps/api/testing/golden-scenarios.js is replayed against a
// scratch Postgres schema loaded with the demo dataset, and the recorded
// `(status, payload)` is compared to the snapshot stored under apps/api/test/golden/.
//
// This is the lock the Phase 3 decomposition works behind. Tasks 15-18 move SQL into
// repositories, rules into the domain and handlers into controllers; none of that may
// change a single byte of these snapshots. A diff is either a bug the refactor
// introduced, or an intended change that has to be regenerated deliberately and reviewed
// in the commit.
//
// Regenerate:
//
//   GOLDEN_UPDATE=1 npm run test:golden       # rewrites apps/api/test/golden/*.json
//   git diff apps/api/test/golden             # review EVERY line before committing
//
// See docs/TECHNICAL_README.md -> "Golden HTTP snapshots".

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');
const { loadDemoData } = require('../../../packages/db/seed-demo');
const {
  createNormalizer,
  readSnapshot,
  recordRequest,
  snapshotPath,
  updateRequested,
  writeSnapshot
} = require('../testing/golden');
const { TIMEZONE, buildScenarios } = require('../testing/golden-scenarios');

const scenarios = buildScenarios();

describe('golden HTTP snapshots (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  // group -> recorded entries, filled by the single sequential replay in before().
  const recorded = new Map();
  let replayError = null;

  before(async () => {
    db = await createTestDatabase();

    const client = await db.pool.connect();
    try {
      await loadDemoData({ client });
    } finally {
      client.release();
    }

    api = await startApi({
      databaseUrl: db.connectionString,
      env: { APP_TIMEZONE: TIMEZONE }
    });

    const { normalize } = createNormalizer({ timeZone: TIMEZONE });

    // One shared ref bag and one shared identifier registry across every group: that is
    // what makes "the id POST returned is the id GET returns" assertable.
    const refs = {
      employeeByNo: new Map(),
      placeByCode: new Map(),
      lineByCode: new Map()
    };

    try {
      for (const scenario of scenarios) {
        const entries = [];

        // Sequential on purpose. The write groups depend on the state the groups before
        // them left behind, and concurrent requests would make that state a race.
        for (const request of scenario.requests) {
          entries.push(await recordRequest({ baseUrl: api.baseUrl, request, refs, normalize }));
        }

        recorded.set(scenario.group, entries);
      }
    } catch (error) {
      // A throw here would leave every `it` reporting the same opaque hook failure;
      // stashing it lets the suite name the group that broke.
      replayError = error;
    }

    if (!replayError && updateRequested()) {
      for (const scenario of scenarios) {
        writeSnapshot(scenario.group, recorded.get(scenario.group));
      }
    }
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  it('replayed every scenario group without a transport error', () => {
    assert.equal(replayError, null, replayError && replayError.stack);
    assert.equal(recorded.size, scenarios.length);
  });

  for (const scenario of scenarios) {
    describe(`${scenario.group} — ${scenario.description}`, () => {
      it('has a stored snapshot', () => {
        assert.ok(
          readSnapshot(scenario.group),
          `missing snapshot ${snapshotPath(scenario.group)} — record it with GOLDEN_UPDATE=1 npm run test:golden`
        );
      });

      it('records exactly the requests the snapshot holds, in order', () => {
        const stored = readSnapshot(scenario.group) || [];
        const entries = recorded.get(scenario.group) || [];

        assert.deepEqual(
          entries.map((entry) => `${entry.method} ${entry.name}`),
          stored.map((entry) => `${entry.method} ${entry.name}`)
        );
      });

      for (const [index, request] of scenario.requests.entries()) {
        it(`${request.name} returns the recorded status and payload`, () => {
          const stored = readSnapshot(scenario.group) || [];
          const entries = recorded.get(scenario.group) || [];
          const actual = entries[index];
          const expected = stored[index];

          assert.ok(actual, `request ${request.name} was not replayed`);
          assert.ok(expected, `request ${request.name} has no stored snapshot`);

          assert.equal(
            actual.status,
            expected.status,
            `${request.name}: status ${actual.status} != recorded ${expected.status}`
          );
          assert.deepEqual(actual.payload, expected.payload);
          assert.equal(actual.path, expected.path);
        });
      }
    });
  }
});
