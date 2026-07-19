'use strict';

// Unit tests for the golden harness's normalizer.
//
// The normalizer is what makes a snapshot comparable across runs, so it has to be
// correct on its own terms: too aggressive and the snapshot stops asserting anything,
// too timid and the suite fails at random. These run inside `npm test` — no database.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createNormalizer, currentDateInZone, normalizeDate } = require('./golden');
const { buildScenarios } = require('./golden-scenarios');

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('golden normalizer', () => {
  it('replaces uuids with stable first-seen tokens', () => {
    const { normalize } = createNormalizer();

    assert.deepEqual(normalize({ id: UUID_A, other: UUID_B, again: UUID_A }), {
      again: '<id:1>',
      id: '<id:1>',
      other: '<id:2>'
    });
  });

  it('keeps one identity across separate normalize calls, which is what links POST to GET', () => {
    const { normalize } = createNormalizer();

    const created = normalize({ id: UUID_A });
    const listed = normalize({ items: [{ placeId: UUID_A }] });

    assert.equal(created.id, '<id:1>');
    assert.equal(listed.items[0].placeId, '<id:1>');
  });

  it('anchors dates on today in the configured timezone', () => {
    const today = currentDateInZone('Europe/Moscow');
    const { normalize } = createNormalizer({ timeZone: 'Europe/Moscow' });

    assert.equal(normalize({ date: today }).date, '<today>');
    assert.equal(normalizeDate(today, today), '<today>');
  });

  it('expresses nearby dates as an offset and distant ones as opaque', () => {
    assert.equal(normalizeDate('2026-07-21', '2026-07-20'), '<today+1>');
    assert.equal(normalizeDate('2026-04-21', '2026-07-20'), '<today-90>');
    assert.equal(normalizeDate('2019-01-01', '2026-07-20'), '<date>');
  });

  it('keeps the day of a date column returned as midnight UTC', () => {
    const { normalize } = createNormalizer({ timeZone: 'Europe/Moscow' });
    const today = currentDateInZone('Europe/Moscow');

    // requestDate/dateFrom arrive as timestamps; recording them as <timestamp> would
    // throw away the day, which is the part that matters.
    assert.equal(normalize({ requestDate: `${today}T00:00:00.000Z` }).requestDate, '<today>T00:00:00.000Z');
  });

  it('collapses a genuine event timestamp', () => {
    const { normalize } = createNormalizer();

    assert.equal(normalize({ createdAt: '2026-07-19T21:19:13.079Z' }).createdAt, '<timestamp>');
  });

  it('rewrites ids and dates embedded in free text but keeps the wording', () => {
    const { normalize } = createNormalizer({ timeZone: 'Europe/Moscow' });
    const today = currentDateInZone('Europe/Moscow');

    assert.equal(
      normalize({ error: `Place ${UUID_A} is busy on ${today}` }).error,
      'Place <id:1> is busy on <today>'
    );
  });

  it('makes volatile-by-nature fields opaque', () => {
    const { normalize } = createNormalizer();

    assert.deepEqual(normalize({ uptimeSeconds: 12, database: 'whatever', count: 3 }), {
      count: 3,
      database: '<database>',
      uptimeSeconds: '<uptimeSeconds>'
    });
  });

  it('sorts object keys but preserves array order', () => {
    const { normalize } = createNormalizer();

    const result = normalize({ b: 1, a: 2, list: ['z', 'a'] });

    assert.deepEqual(Object.keys(result), ['a', 'b', 'list']);
    assert.deepEqual(result.list, ['z', 'a']);
  });

  it('leaves booleans, nulls and numbers alone', () => {
    const { normalize } = createNormalizer();

    assert.deepEqual(normalize({ ok: true, missing: null, n: 0 }), { missing: null, n: 0, ok: true });
  });
});

describe('golden scenarios', () => {
  const scenarios = buildScenarios();

  it('names every group uniquely — a group is one snapshot file', () => {
    const groups = scenarios.map((scenario) => scenario.group);

    assert.deepEqual(groups, [...new Set(groups)]);
  });

  it('names every request within a group uniquely, since the snapshot is matched by order and name', () => {
    for (const scenario of scenarios) {
      const names = scenario.requests.map((request) => request.name);

      assert.deepEqual(names, [...new Set(names)], `duplicate request name in group ${scenario.group}`);
    }
  });

  it('gives every request a path or a resolver', () => {
    for (const scenario of scenarios) {
      for (const request of scenario.requests) {
        assert.ok(
          request.path || request.resolve,
          `${scenario.group}/${request.name} has neither path nor resolve()`
        );
      }
    }
  });

  it('runs every read group before the first write group', () => {
    const firstWrite = scenarios.findIndex((scenario) => scenario.group.endsWith('-writes'));
    const readsAfterWrites = scenarios
      .slice(firstWrite)
      .filter((scenario) => scenario.requests.every((request) => !request.method || request.method === 'GET'));

    assert.ok(firstWrite > 0, 'expected at least one read group before the writes');
    assert.deepEqual(readsAfterWrites, [], 'a read-only group runs after the writes have mutated the data');
  });

  it('runs the jobs group last — every job mutates releases, plans and the queue', () => {
    assert.equal(scenarios[scenarios.length - 1].group, 'jobs');
  });
});
