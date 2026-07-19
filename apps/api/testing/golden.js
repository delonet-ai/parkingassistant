'use strict';

// Golden-response harness: records `(status, payload)` per endpoint and compares it to
// a stored snapshot under apps/api/test/golden/.
//
// These snapshots are the behavior contract the Phase 3 decomposition (Tasks 15-18) must
// preserve. A refactor that moves SQL into a repository, rules into the domain, or
// handlers into controllers must leave every snapshot byte-identical; a diff means the
// refactor changed behavior, whether or not that was intended.
//
// See docs/TECHNICAL_README.md -> "Golden HTTP snapshots" for the regeneration workflow.
//
// Note the directory: the snapshots live in apps/api/test/golden/ as *.json. The runner
// itself must NOT live there — `node --test` picks up every .js file under a directory
// named `test/` regardless of its name, which would drag a Postgres-backed suite into the
// `npm test` gate. JSON files are invisible to that discovery, which is why only data
// lives there.

const fs = require('node:fs');
const path = require('node:path');

const GOLDEN_DIR = path.join(__dirname, '..', 'test', 'golden');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Fields whose value is volatile but whose *presence* is the contract.
const OPAQUE_NUMBER_KEYS = new Set(['uptimeSeconds', 'durationMs', 'elapsedMs']);
const OPAQUE_STRING_KEYS = new Set(['database', 'schema', 'searchPath']);

// How far from "today" a date is still expressed as an offset. The demo dataset anchors
// every date on the run date (permanent assignments start ~90 days back), so the window
// has to be wide enough to cover it — a date that fell outside would be recorded as the
// opaque `<date>` and stop asserting anything.
const DATE_OFFSET_WINDOW_DAYS = 400;

// A date column read back over JSON arrives as midnight UTC. Recording that as
// `<timestamp>` would throw away the day, which for requestDate/dateFrom IS the contract.
const MIDNIGHT_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/;

function updateRequested() {
  const flag = process.env.GOLDEN_UPDATE;
  return flag === '1' || flag === 'true';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function currentDateInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function daysBetween(fromIsoDate, toIsoDate) {
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

/**
 * Dates are anchored on the run date so a snapshot recorded today still matches tomorrow.
 * `<today>`, `<today+1>`, `<today-3>`; anything outside the window is just `<date>`.
 */
function normalizeDate(value, today) {
  const offset = daysBetween(today, value);

  if (!Number.isFinite(offset) || Math.abs(offset) > DATE_OFFSET_WINDOW_DAYS) {
    return '<date>';
  }
  if (offset === 0) {
    return '<today>';
  }

  return `<today${offset > 0 ? '+' : '-'}${Math.abs(offset)}>`;
}

/**
 * Create a normalizer bound to one recording run.
 *
 * Identifiers are replaced by first-seen order (`<id:1>`, `<id:2>`, ...) rather than by a
 * blanket `<uuid>`, so the snapshot still proves that the id a list returned is the same
 * id the detail endpoint returned. That only works because the registry is shared across
 * every request in the run — which is why this is a factory, not a free function.
 */
function createNormalizer({ timeZone = 'Europe/Moscow' } = {}) {
  const today = currentDateInZone(timeZone);
  const identifiers = new Map();

  function identifierToken(value) {
    const known = identifiers.get(value);
    if (known) {
      return known;
    }

    const token = `<id:${identifiers.size + 1}>`;
    identifiers.set(value, token);
    return token;
  }

  function normalizeString(value) {
    if (UUID_PATTERN.test(value)) {
      return identifierToken(value);
    }

    const midnight = value.match(MIDNIGHT_TIMESTAMP_PATTERN);
    if (midnight) {
      return `${normalizeDate(midnight[1], today)}T00:00:00.000Z`;
    }

    if (TIMESTAMP_PATTERN.test(value)) {
      return '<timestamp>';
    }
    if (ISO_DATE_PATTERN.test(value)) {
      return normalizeDate(value, today);
    }

    // Ids and dates also travel inside free text — audit summaries, error messages and
    // the daterange literals Postgres returns. Rewrite them in place so the surrounding
    // wording, which IS the contract, stays visible.
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (match) =>
        identifierToken(match)
      )
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g, '<timestamp>')
      .replace(/\d{4}-\d{2}-\d{2}/g, (match) => normalizeDate(match, today));
  }

  function normalize(value, key = null, options = {}) {
    if (typeof value === 'string') {
      if (OPAQUE_STRING_KEYS.has(key)) {
        return `<${key}>`;
      }
      if (options.opaqueIds) {
        // Identity is dropped rather than numbered — see recordRequest's `unordered`.
        return normalizeString(value).replace(/<id:\d+>/g, '<uuid>');
      }
      return normalizeString(value);
    }

    if (typeof value === 'number') {
      return OPAQUE_NUMBER_KEYS.has(key) ? `<${key}>` : value;
    }

    if (Array.isArray(value)) {
      // Array order is preserved: ordering IS the contract for the queue, line positions
      // and display_order.
      return value.map((item) => normalize(item, key, options));
    }

    if (isPlainObject(value)) {
      // Object keys are sorted so the snapshot is canonical. Key order carries no meaning
      // over HTTP, and leaving it in would turn a harmless reordering during the split
      // into a false failure.
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((childKey) => [childKey, normalize(value[childKey], childKey, options)])
      );
    }

    return value;
  }

  return { normalize, today, identifiers };
}

function snapshotPath(group) {
  return path.join(GOLDEN_DIR, `${group}.json`);
}

function readSnapshot(group) {
  const file = snapshotPath(group);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSnapshot(group, entries) {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(group), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/**
 * Execute one scenario request against a running API and return the recorded entry.
 *
 * `resolve(refs)` lets a request depend on an id an earlier request produced (archive the
 * line we just created); `capture(payload, refs)` is how that id gets there.
 */
async function recordRequest({ baseUrl, request, refs, normalize }) {
  const resolved = request.resolve ? request.resolve(refs) : {};
  const pathname = resolved.path || request.path;
  const body = 'body' in resolved ? resolved.body : request.body;
  const method = request.method || 'GET';

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    payload = { unparsedBody: text };
  }

  if (request.capture) {
    request.capture(payload, refs);
  }

  // `unordered` names the payload arrays whose SQL ordering has ties, and is the whole
  // answer to a flaky golden suite.
  //
  // `/admin/audit-logs` orders by `occurred_at desc` with no tiebreaker while every row
  // one transaction wrote shares a timestamp, so Postgres may return them in any order.
  // Sorting them is not enough on its own: identifier tokens are handed out in first-seen
  // order, so a reshuffle renumbers every id in the run. Inside these lists identity is
  // therefore made opaque (`<uuid>`) and the rows are sorted by their normalized content
  // — which makes the recording independent of the order Postgres chose.
  //
  // What is asserted is the SET of journal rows and their content. Which uuid a journal
  // row carries is not part of the HTTP contract, and the entity-level linkage is already
  // covered by reservations.itest.js / jobs.itest.js.
  const unordered = new Set(request.unordered || []);

  const normalizePayload = (value, key = null) => {
    if (Array.isArray(value) && unordered.has(key)) {
      return value
        .map((item) => normalize(item, key, { opaqueIds: true }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }

    if (Array.isArray(value)) {
      return value.map((item) => normalizePayload(item, key));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((childKey) => [childKey, normalizePayload(value[childKey], childKey)])
      );
    }

    return normalize(value, key);
  };

  return {
    name: request.name,
    method,
    // The path is normalized too — it carries ids for the /:id/history endpoints.
    path: normalize(pathname),
    status: response.status,
    payload: unordered.size ? normalizePayload(payload) : normalize(payload)
  };
}

module.exports = {
  DATE_OFFSET_WINDOW_DAYS,
  GOLDEN_DIR,
  createNormalizer,
  currentDateInZone,
  normalizeDate,
  readSnapshot,
  recordRequest,
  snapshotPath,
  updateRequested,
  writeSnapshot
};
