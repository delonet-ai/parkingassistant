'use strict';

// Task 9 — the Excel catalog, imported over HTTP.
//
// The CLI has imported the real workbook since the first stand deployment and
// `e2e-day.itest.js` still runs it; this suite is about the endpoint the operator
// uses instead, and about the two properties a UI import adds to it: a dry run that
// reports what would change and writes nothing, and an apply that is idempotent on
// a re-upload of the same file.
//
// The cases are ORDERED and share one scratch schema: the dry run has to meet an
// empty catalog, the apply has to meet the catalog the dry run did not write, and the
// re-apply has to meet what the apply wrote. node:test runs the cases in a file
// sequentially, which is what makes that legal — the same arrangement as the
// end-to-end day.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const xlsx = require('xlsx');

const { startApi } = require('../testing/boot-api');
const { getJson, postForm, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');
const { PROBLEM_REPORT_LIMIT } = require('../../../packages/domain/catalog-rows');

// The sheet the real file uses, including the title row the importer skips and the
// header spelling with its trailing spaces. 101/102/103 are one triple line, 110 is a
// single and 120 is the guest pool — the same shape as CATALOG_ROWS in e2e-day.itest.js,
// plus two rows that must be refused and reported.
const HEADER = [
  ['Парковочный каталог', '', '', '', ''],
  ['Уровень', 'Место ', 'Статус', 'Дирекция ', 'Кем']
];

const PLACE_ROWS = [
  ['G4', '101 передний', 'Закреплено', 'ИТ', 'Иванов'],
  ['G4', '102 средний', 'Закреплено', 'ИТ', 'Петров'],
  ['G4', '103 задний', 'Закреплено', 'ИТ', 'Сидоров'],
  ['G4', '110', 'Закреплено', 'Финансы', 'Кузнецов'],
  ['G4', '120', 'Гостевое', 'Финансы', '']
];

const PROBLEM_ROWS = [
  // A section heading: a place cell with no digit in it.
  ['G4', 'Резерв дирекции', 'Закреплено', 'ИТ', ''],
  // The same place twice: the first row wins and this one is reported.
  ['G4', '110', 'Закреплено', 'Финансы', 'Кузнецов']
];

function workbookBuffer(rows, sheetName = 'Лист1') {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), sheetName);

  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** What the browser sends: the workbook as a file part plus the flag. */
function catalogForm(buffer, { dryRun, filename = 'parking-catalog.xlsx', sheet } = {}) {
  const form = new FormData();

  form.append(
    'catalogFile',
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    filename
  );

  if (dryRun !== undefined) {
    form.append('dryRun', String(dryRun));
  }

  if (sheet !== undefined) {
    form.append('sheet', sheet);
  }

  return form;
}

describe('catalog import over HTTP (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  const catalog = workbookBuffer([...HEADER, ...PLACE_ROWS, ...PROBLEM_ROWS]);

  before(async () => {
    db = await createTestDatabase();
    api = await startApi({ databaseUrl: db.connectionString });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  async function placeCodes() {
    const { status, payload } = await getJson(api.baseUrl, '/admin/places');
    assert.equal(status, 200);

    return payload.places.map((place) => place.code).sort();
  }

  async function countRows(table) {
    const result = await db.query(`select count(*)::integer as total from ${table}`);

    return result.rows[0].total;
  }

  /** Only the import's own rows: signing the harness in writes an audit row of its own. */
  async function importAuditRows() {
    const result = await db.query(
      `select action, actor_service, actor_auth_user_id, metadata
       from audit_logs
       where action = 'parking_catalog_imported'`
    );

    return result.rows;
  }

  it('starts from a catalog with no places and no lines', async () => {
    assert.deepEqual(await placeCodes(), []);
    assert.equal(await countRows('line_groups'), 0);
  });

  it('answers a dry run with the counts and the problems, and writes nothing', async () => {
    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: true })
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.import.dryRun, true);
    assert.equal(payload.import.sheet, 'Лист1');
    assert.equal(payload.import.sourceFile, 'parking-catalog.xlsx');
    // Seven data rows read, five of them places: 101/102/103 are one triple line, 110 and
    // 120 are singles, so three lines would be created with them.
    assert.equal(payload.import.rowsRead, 7);
    assert.equal(payload.import.placesStaged, 5);
    assert.equal(payload.import.placesCreated, 5);
    assert.equal(payload.import.placesUpdated, 0);
    assert.equal(payload.import.linesCreated, 3);
    assert.equal(payload.import.linesUpdated, 0);

    assert.deepEqual(payload.problems, [
      {
        row: 8,
        reason: 'place_without_digits',
        code: null,
        floor: 'G4',
        place: 'Резерв дирекции',
        status: 'Закреплено'
      },
      {
        row: 9,
        reason: 'duplicate_code',
        code: '110',
        floor: 'G4',
        place: '110',
        status: 'Закреплено'
      }
    ]);

    // The whole point: the transaction rolled back, so the catalog is still empty — and so
    // is the audit trail, which the import writes inside the same transaction.
    assert.deepEqual(await placeCodes(), []);
    assert.equal(await countRows('line_groups'), 0);
    assert.deepEqual(await importAuditRows(), []);
  });

  it('applies the same workbook and writes the places, the lines and one audit row', async () => {
    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: false })
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.import.dryRun, false);
    // The counts the dry run predicted, unchanged.
    assert.equal(payload.import.placesCreated, 5);
    assert.equal(payload.import.placesUpdated, 0);
    assert.equal(payload.import.linesCreated, 3);

    assert.deepEqual(await placeCodes(), ['101', '102', '103', '110', '120']);
    assert.equal(await countRows('line_groups'), 3);

    const rows = await importAuditRows();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'parking_catalog_imported');
    // Task 6's rule: an operator's import names the operator, not just the application.
    assert.equal(rows[0].actor_service, 'admin-ui');
    assert.equal(rows[0].actor_auth_user_id, api.operator.user.id);
    assert.deepEqual(rows[0].metadata, {
      sourceFile: 'parking-catalog.xlsx',
      sourceSheet: 'Лист1',
      importedPlaces: 5
    });
  });

  it('derives the triple line and the guest pool from the same rows the CLI would', async () => {
    const { status, payload } = await getJson(api.baseUrl, '/admin/place-lines?floor=4');

    assert.equal(status, 200);

    const byCapacity = payload.lines.reduce((counts, line) => {
      counts[line.capacity] = (counts[line.capacity] || 0) + 1;
      return counts;
    }, {});

    // 101/102/103 are one triple; 110 and 120 are singles of their own.
    assert.deepEqual(byCapacity, { 1: 2, 3: 1 });

    const guest = (await getJson(api.baseUrl, '/admin/places')).payload.places.find(
      (place) => place.code === '120'
    );

    assert.equal(guest.placeRole, 'rotatable');
    assert.equal(guest.guestPriorityRank, 1);
  });

  it('is idempotent: re-uploading the same file updates and creates nothing', async () => {
    const before = await db.query('select id, code, title, line_group_id from parking_places order by code');

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: false })
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.import.placesCreated, 0);
    assert.equal(payload.import.placesUpdated, 5);
    assert.equal(payload.import.linesCreated, 0);
    assert.equal(payload.import.linesUpdated, 3);

    const after = await db.query('select id, code, title, line_group_id from parking_places order by code');

    // Not just "the same count": the same rows. A re-import that deleted and recreated a
    // place would lose every reservation, release and assignment that points at its id.
    assert.deepEqual(after.rows, before.rows);
    assert.equal(await countRows('line_groups'), 3);
  });

  it('refuses a workbook whose rows are not places at all, and says which rows', async () => {
    const empty = workbookBuffer([...HEADER, ...PROBLEM_ROWS.slice(0, 1)]);

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(empty, { dryRun: true })
    );

    assert.equal(status, 400);
    assert.match(payload.error, /No parking places were understood/);
    assert.equal(payload.problems.length, 1);
    assert.equal(payload.problems[0].reason, 'place_without_digits');
  });

  it('refuses a file that is not a workbook', async () => {
    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(Buffer.from('this is not a spreadsheet at all'), {
        dryRun: true,
        filename: 'notes.xlsx'
      })
    );

    assert.equal(status, 400);
    assert.match(payload.error, /Workbook could not be read/);
    // The refusal came before any write: the catalog is the one the apply left.
    assert.deepEqual(await placeCodes(), ['101', '102', '103', '110', '120']);
  });

  // A real zip that is not a workbook gets past the `PK` signature check, so it is `xlsx.read`
  // itself that has to refuse it. Without the try/catch around that call this is a 500 quoting
  // the library, and the suite's "not a workbook" case above would not notice: it stops at the
  // signature check, and both refusals start with the same sentence.
  it('refuses a zip that is not a workbook, without leaking the parser’s error as a 500', async () => {
    const zipButNotAWorkbook = Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.alloc(512, 7)]);

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(zipButNotAWorkbook, { dryRun: true, filename: 'archive.xlsx' })
    );

    assert.equal(status, 400);
    assert.match(payload.error, /Workbook could not be read/);
    assert.deepEqual(await placeCodes(), ['101', '102', '103', '110', '120']);
  });

  // 413 and 400 are different answers to different mistakes, and the controller tells them
  // apart by the type the shared parser throws. An operator told "malformed" about a file that
  // is merely too big goes looking for the wrong problem.
  it('answers 413 for a body past the upload limit, not 400', async () => {
    // Deliberately not a FormData: `readRawBody` refuses this before the parser ever sees it,
    // which is the branch under test. The session travels the same way.
    const oversized = new Uint8Array(11 * 1024 * 1024);

    const { status, payload } = await postForm(api.baseUrl, '/admin/catalog-import', oversized);

    assert.equal(status, 413);
    assert.match(payload.error, /too large/i);
  });

  it('answers 400 for a body that is not a multipart form at all', async () => {
    const { status, payload } = await postForm(api.baseUrl, '/admin/catalog-import', new Uint8Array([1, 2, 3]));

    assert.equal(status, 400);
    assert.match(payload.error, /boundary is missing/);
  });

  it('refuses a workbook that has no sheet by that name', async () => {
    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: true, sheet: 'Места' })
    );

    assert.equal(status, 400);
    assert.match(payload.error, /Sheet not found: Места/);
  });

  it('refuses a request with no file part', async () => {
    const form = new FormData();
    form.append('dryRun', 'true');

    const { status, payload } = await postForm(api.baseUrl, '/admin/catalog-import', form);

    assert.equal(status, 400);
    assert.match(payload.error, /catalogFile/);
  });

  it('treats a missing dryRun flag as a dry run rather than as an apply', async () => {
    const added = workbookBuffer([...HEADER, ...PLACE_ROWS, ['G4', '130', 'Закреплено', 'ИТ', 'Новиков']]);

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(added)
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.import.dryRun, true);
    assert.equal(payload.import.placesCreated, 1);

    // 130 would have been created had this been an apply. It was not.
    assert.deepEqual(await placeCodes(), ['101', '102', '103', '110', '120']);
  });

  // A blank line is how the sheet groups places, not a row the operator forgot to fill in.
  // Reporting them made the warning block one entry per separator and buried the two
  // refusals that matter.
  it('says nothing about the blank separator lines in the sheet', async () => {
    const spaced = workbookBuffer([
      ...HEADER,
      ['G4', '101 передний', 'Закреплено', 'ИТ', 'Иванов'],
      ['', '', '', '', ''],
      ['G4', '110', 'Закреплено', 'Финансы', 'Кузнецов']
    ]);

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(spaced, { dryRun: true })
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.deepEqual(payload.problems, []);
    assert.equal(payload.problemsTotal, 0);
    assert.equal(payload.import.placesStaged, 2);
  });

  // An .xlsx is a zip, so a sheet of junk rows well under the 10 MB upload limit can refuse
  // more rows than any answer should carry. The list is cut, the count is not.
  it('caps the refused rows it answers with and still reports how many there were', async () => {
    const junk = [];

    for (let index = 0; index < PROBLEM_REPORT_LIMIT + 1; index += 1) {
      junk.push(['G4', 'итого', 'Закреплено', 'ИТ', '']);
    }

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(workbookBuffer([...HEADER, ...junk]), { dryRun: true })
    );

    assert.equal(status, 400);
    assert.equal(payload.problems.length, PROBLEM_REPORT_LIMIT);
    assert.equal(payload.problemsTotal, PROBLEM_REPORT_LIMIT + 1);
  });

  // Archiving a slot clears `is_active` *and* sets `deleted_at`, and the unique index the
  // import conflicts on is on `code` alone — so a re-import matched the archived row. It used
  // to clear only `deleted_at`, leaving a place that `/admin/places`, releases and
  // reservations could see while the Места grid (which filters `is_active`) could not, with
  // `assign_place_lines()` counting it into a capacity the same grid then called broken.
  it('revives an archived place whole, not half', async () => {
    const lines = await getJson(api.baseUrl, '/admin/place-lines?floor=4');
    const single = lines.payload.lines.find((line) => line.slots.some((slot) => slot.code === '110'));

    assert.ok(single, JSON.stringify(lines.payload));

    const archived = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: single.lineId });

    assert.equal(archived.status, 200, JSON.stringify(archived.payload));
    assert.deepEqual(
      archived.payload.archivedPlaces.map((place) => place.code),
      ['110']
    );

    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: false })
    );

    assert.equal(status, 200, JSON.stringify(payload));

    const revived = await db.query('select is_active, deleted_at from parking_places where code = $1', ['110']);

    assert.equal(revived.rows[0].is_active, true);
    assert.equal(revived.rows[0].deleted_at, null);

    // Both halves of the system agree the place is back: the grid lists it again...
    const after = await getJson(api.baseUrl, '/admin/place-lines?floor=4');

    assert.ok(after.payload.lines.some((line) => line.slots.some((slot) => slot.code === '110')));

    // ...and the line it stands in is not reported as a capacity mismatch.
    const diagnostics = await getJson(api.baseUrl, '/admin/map-diagnostics');

    assert.equal(diagnostics.status, 200);
    assert.deepEqual(
      diagnostics.payload.diagnostics.lineCapacityMismatch.filter((row) => row.code === single.code),
      []
    );
  });

  it('refuses the import to a caller with no session', async () => {
    const { status, payload } = await postForm(
      api.baseUrl,
      '/admin/catalog-import',
      catalogForm(catalog, { dryRun: true }),
      { cookie: null }
    );

    assert.equal(status, 401);
    assert.equal(payload.code, 'unauthorized');
  });
});
