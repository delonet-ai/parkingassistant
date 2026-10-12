'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const xlsx = require('xlsx');

const { CATALOG_COLUMNS } = require('../../../../../packages/domain/catalog-rows');
const {
  CatalogWorkbookError,
  LAST_SHEET_ROW,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  lastPopulatedSheetRow,
  readCatalogBuffer,
  readSheet
} = require('./service');

// What the reader does with a sheet whose *declared* extent disagrees with its cells.
//
// `sheet_to_json` walks the range from the worksheet's `<dimension ref>` tag, cell by cell, and
// that tag is written by whoever saved the file. Before the bounds below, a 16 KB workbook
// holding three real rows could declare `A1:ZZ100000` and cost ~36 seconds of synchronous cell
// lookups inside the API process — a signed-in operator could stall every route with one small
// upload, and the file was *accepted*, because the row limit counted the rows that came back
// (three) rather than the rows that were walked.
//
// No database here on purpose: this is the parse, and it is the half of the import that runs
// before a transaction is opened.

const TITLE_ROW = ['Парковочный каталог', '', '', '', ''];

function placeRow(index) {
  return ['G4', String(100 + index), 'Закреплено', 'ИТ', 'Иванов'];
}

function catalogRows(dataRows) {
  const rows = [TITLE_ROW, CATALOG_COLUMNS.slice()];

  for (let index = 0; index < dataRows; index += 1) {
    rows.push(placeRow(index));
  }

  return rows;
}

function workbookBuffer(rows) {
  const workbook = xlsx.utils.book_new();

  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), 'Лист1');

  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * A parsed workbook with a `<dimension>` wider and taller than its cells — the shape `xlsx.read`
 * hands back for a file saved from a formatted template. Assembled rather than written and read
 * back: `xlsx.write` walks the declared range as well, so a million-row declaration would cost
 * the test the very minutes the reader no longer costs the API.
 */
function workbookWithDeclaredRef(rows, declaredRef) {
  const sheet = xlsx.utils.aoa_to_sheet(rows);

  sheet['!fullref'] = sheet['!ref'];
  sheet['!ref'] = declaredRef;

  return { SheetNames: ['Лист1'], Sheets: { 'Лист1': sheet } };
}

function catalogBuffer(dataRows) {
  return workbookBuffer(catalogRows(dataRows));
}


/** A catalog with no title row and its header on row 3, under two blank rows. */
function shiftedRows(dataRows) {
  return [[], [], ...catalogRows(dataRows).slice(1)];
}

test('reads a sheet whose declared range is orders of magnitude larger than its cells', () => {
  // Excel declares `<dimension>` over every row it has ever formatted, so refusing the file for
  // this would refuse the real catalog: the three rows must still be read.
  const workbook = workbookWithDeclaredRef(catalogRows(3), 'A1:ZZ100000');

  const startedAt = process.hrtime.bigint();
  const sheet = readSheet(workbook, { sheetName: 'Лист1', sourceFile: 'inflated.xlsx' });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.equal(sheet.rowsRead, 3);
  assert.equal(sheet.places.length, 3);
  assert.equal(sheet.problemsTotal, 0);

  // Deliberately loose — a regression bound on the *walk*, not a benchmark. The defect it pins
  // took ~36 seconds on this very sheet, so two orders of magnitude of slack still fails it and
  // leaves a slow machine alone.
  //
  // `A1:ZZ100000` and not the sheet maximum the real template declares, even though that is the
  // worse case: the walk is synchronous, so a regression has to be able to *finish* and fail
  // this assertion. A million rows by 16384 columns would hang the suite instead of failing it.
  assert.ok(elapsedMs < 2000, `reading a bloated declared range took ${elapsedMs.toFixed(0)}ms`);
});


test('stops reading columns past the limit', () => {
  // The row bound alone would not be enough: the limit's worth of rows across a sheet's full
  // 16384 columns is the same order of work as the defect above, so the column span is clamped
  // too. Asserted by putting a column the catalog needs out past the clamp and watching the
  // header refusal fire — the clamp has no other observable effect on a well-formed sheet, and
  // a declared-only span of 16384 columns costs minutes to *write* in a test.
  // `Уровень` — the first column, and one of the two the header refusal is keyed on; the
  // trailing ones are optional, so moving those out of reach would prove nothing.
  const far = MAX_SHEET_COLUMNS + 6;
  const header = CATALOG_COLUMNS.slice();
  const row = placeRow(0);
  const moved = header.shift();

  header[far] = moved;
  row[far] = row.shift();

  assert.throws(
    () => readCatalogBuffer(workbookBuffer([TITLE_ROW, header, row])),
    (error) => error instanceof CatalogWorkbookError && error.message.includes(moved)
  );
  assert.ok(MAX_SHEET_COLUMNS < 16384, 'the column clamp has to be below a sheet maximum to bound anything');
});

test('reads a sheet of exactly the row limit', () => {
  const sheet = readCatalogBuffer(catalogBuffer(MAX_SHEET_ROWS));

  assert.equal(sheet.rowsRead, MAX_SHEET_ROWS);
  assert.equal(sheet.places.length, MAX_SHEET_ROWS);
});

test('refuses a sheet one row past the limit rather than importing a truncated catalog', () => {
  // The bound on the walk stops one data row past the limit precisely so this refusal can still
  // fire: clamping to exactly the limit would have imported the first 5000 rows of a bigger
  // sheet and reported success.
  assert.throws(
    () => readCatalogBuffer(catalogBuffer(MAX_SHEET_ROWS + 1)),
    (error) => error instanceof CatalogWorkbookError && /more than the 5000 rows/.test(error.message)
  );
});

test('refuses a header shifted down a row instead of reading past the parse bound', () => {
  // A sheet declared from row 3 — two blank rows, then the header — holding one row past the
  // limit. `sheetRows` in `readCatalogBuffer` cuts the parse at an absolute row, so what reaches
  // the reader is the header and *exactly* the limit: the slack row is already gone. A reader
  // that followed the declared start down to row 3 imported that as the whole catalog.
  const cut = workbookWithDeclaredRef(shiftedRows(MAX_SHEET_ROWS), `A3:E${MAX_SHEET_ROWS + 3}`);

  // Read from row 2, the header itself becomes a data row and the sheet comes back over the
  // limit; either refusal is right — what must not happen is an import.
  assert.throws(
    () => readSheet(cut, { sheetName: 'Лист1' }),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /more than the 5000 rows|header belongs in row 2/.test(error.message)
  );

  // And the shift alone is refused for where the header is, however few rows follow it.
  const small = workbookWithDeclaredRef(shiftedRows(3), 'A3:E6');

  assert.throws(
    () => readSheet(small, { sheetName: 'Лист1' }),
    (error) => error instanceof CatalogWorkbookError && /header belongs in row 2/.test(error.message)
  );
});

test('refuses a file that is not a workbook before handing it to the parser', () => {
  assert.throws(
    () => readCatalogBuffer(Buffer.from('Уровень;Место;Статус\n')),
    (error) => error instanceof CatalogWorkbookError && /not an \.xlsx workbook/.test(error.message)
  );
});

/**
 * A catalog with blank rows between its places: one place on row 3, then nothing until the row
 * asked for. The shape the row limit alone cannot judge — the limit counts rows that carry
 * something, and the parse stops at an absolute sheet row.
 */
function sparseCatalogBuffer(lastRow) {
  const rows = catalogRows(1);

  while (rows.length < lastRow - 1) {
    rows.push([]);
  }

  rows.push(placeRow(1));

  return workbookBuffer(rows);
}

test('refuses a sheet whose places continue past the row the parse stops at', () => {
  // The slack row answers for a dense sheet only. Here the parse cuts at `LAST_SHEET_ROW`, two
  // rows carry places and one of them sits past the cut, so counting what came back said "one
  // row read, no problems" and the operator applied an incomplete catalog without being told.
  assert.throws(
    () => readCatalogBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000)),
    (error) =>
      error instanceof CatalogWorkbookError && /more than the 5000 rows this import reads/.test(error.message)
  );
});

test('reads a place sitting on the last row the parse stops at', () => {
  // The other side of the same bound: the sheet is sparse, but nothing is past the cut, so both
  // places are read and nothing is refused. Pins the boundary the refusal above is keyed on —
  // off by one here and the real catalog's trailing rows are called "not the parking catalog".
  const sheet = readCatalogBuffer(sparseCatalogBuffer(LAST_SHEET_ROW));

  assert.equal(sheet.rowsRead, 2);
  assert.equal(sheet.places.length, 2);
  assert.equal(sheet.problemsTotal, 0);
});

test('finds the last populated row however the worksheet numbers its rows', () => {
  // The scan reads the `r` attribute of the `<row>` tag the last value sits in. `r` is optional
  // in the format — `xlsx`, Excel and LibreOffice all write it, but a worksheet that leaves it
  // out numbers its rows by position, blank ones included, so counting the tags is the row
  // number rather than a guess. Asserted on the part's bytes because no writer here produces
  // that shape: round-tripping it through a zip would mean writing one.
  const numbered =
    '<sheetData><row r="2"><c r="A2" t="s"><v>0</v></c></row>' +
    '<row r="7"><c r="A7" s="3"/></row>' +
    '<row r="9"><c r="A9" t="inlineStr"><is><t>G4</t></is></c></row></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(numbered)), 9);

  // The same three rows with the numbers left off, and the blank ones written out so the
  // positions still hold: nine tags, the ninth carrying the value.
  const positional =
    `<sheetData><row/><row><c t="s"><v>0</v></c></row>${'<row/>'.repeat(6)}` +
    '<row><c t="inlineStr"><is><t>G4</t></is></c></row></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(positional)), 9);

  // A sheet of nothing but formatting: `<row>` tags and `<c>` cells, no value anywhere. Refusing
  // this for its rows would refuse the real catalog, whose template carries formatted rows well
  // past its places.
  const formattingOnly = `<sheetData>${'<row r="1"><c r="A1" s="3"/></row>'.repeat(4)}</sheetData>`;

  assert.equal(lastPopulatedSheetRow(Buffer.from(formattingOnly)), 0);

  // And what a worksheet writes after its rows is not a row: the template's formatted rows run
  // far past its places, so a `<v>` belonging to some vendor extension would otherwise be read
  // as a cell value in the last of them and refuse the real catalog.
  const extended =
    '<sheetData><row r="3"><c r="A3" t="s"><v>0</v></c></row>' +
    '<row r="9000" s="2" customFormat="1"/></sheetData>' +
    '<extLst><ext uri="{x}"><v>1</v></ext></extLst>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(extended)), 3);
});

/**
 * The same workbook with its worksheet part rewritten into namespace-prefixed XML:
 * `<x:sheetData><x:row><x:c><x:v>`, with `x` bound to the spreadsheet namespace the unprefixed
 * form leaves as the default. The same document in XML's terms, written by neither Excel nor
 * `xlsx` but permitted by SpreadsheetML and parsed by `xlsx` without complaint.
 *
 * Rebuilt through `xlsx.CFB`, which reads and writes the zip `xlsx` already unpacks, so this
 * needs no zip of its own and no tool outside the process.
 */
function prefixedWorksheetBuffer(buffer, { sheetData } = {}) {
  const { CFB } = xlsx;
  const archive = CFB.read(buffer, { type: 'buffer' });
  const part = CFB.find(archive, '/xl/worksheets/sheet1.xml');
  const xml = Buffer.from(part.content).toString('utf8');
  const declaration = xml.slice(0, xml.indexOf('?>') + 2);
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  let body = xml.slice(declaration.length);

  if (sheetData) {
    body = body.replace(/<sheetData>[\s\S]*<\/sheetData>/, sheetData);
  }

  body = body
    .replace(/<(\/?)([A-Za-z][\w]*)/g, '<$1x:$2')
    .replace(`xmlns="${namespace}"`, `xmlns:x="${namespace}"`);

  CFB.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', Buffer.from(declaration + body, 'utf8'));

  return CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

test('refuses a sheet whose places continue past the cut however its tags are prefixed', () => {
  // The prefix is the writer's choice and `xlsx` parses either form, so a scan for the literal
  // `<sheetData>`, `<row>`, `<v>` and `<is>` answered "nothing past the cut" for a file whose
  // rows it simply could not see — the same truncated import, reached by a different door:
  // `rowsRead: 1`, the place on the last row dropped, and the operator told nothing.
  assert.throws(
    () => readCatalogBuffer(prefixedWorksheetBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000))),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /more than the 5000 rows this import reads/.test(error.message)
  );

  // And the other side of the bound, because a check that refuses everything prefixed would
  // pass the test above while refusing a workbook this import can read in full.
  const sheet = readCatalogBuffer(prefixedWorksheetBuffer(sparseCatalogBuffer(LAST_SHEET_ROW)));

  assert.equal(sheet.rowsRead, 2);
  assert.equal(sheet.places.length, 2);
});

test('refuses a worksheet whose last populated row cannot be told', () => {
  // A value the scan cannot place in a row: it does not know what the parse left out, and the
  // one thing that must not follow from "don't know" is an import of half a catalog. The
  // forgiving answer stays for a workbook whose sheet part is not XML at all — an .xlsb, whose
  // rows are binary records — and that is the case this reader never locates a part for.
  const loose = prefixedWorksheetBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000), {
    sheetData: '<sheetData><v>7</v></sheetData>'
  });

  assert.throws(
    () => readCatalogBuffer(loose),
    (error) =>
      error instanceof CatalogWorkbookError && /are not laid out the way a worksheet is/.test(error.message)
  );
});

test('finds the last populated row through namespace prefixes', () => {
  // The byte scan matches elements by local name and checks what frames it, which is what tells
  // `<x:row>` from `<x:rowBreaks>` and from `</x:row>` without an XML parser. Asserted on the
  // part's bytes for the same reason the numbering above is: no writer here produces this shape.
  const numbered =
    '<x:sheetData><x:row r="2"><x:c r="A2" t="s"><x:v>0</x:v></x:c></x:row>' +
    '<x:row r="7"><x:c r="A7" s="3"/></x:row>' +
    '<x:row r="9"><x:c r="A9" t="inlineStr"><x:is><x:t>G4</x:t></x:is></x:c></x:row>' +
    '</x:sheetData><x:rowBreaks count="1"><x:brk id="9"/></x:rowBreaks>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(numbered)), 9);

  // The positional numbering with prefixes, where counting tags has to skip `</x:row>` and the
  // `<x:rowBreaks>` past the rows as surely as it counts the blank `<x:row/>` ones.
  const positional =
    `<x:sheetData><x:row/><x:row><x:c t="s"><x:v>0</x:v></x:c></x:row>${'<x:row/>'.repeat(6)}` +
    '<x:row><x:c t="inlineStr"><x:is><x:t>G4</x:t></x:is></x:c></x:row></x:sheetData>' +
    '<x:rowBreaks count="1"><x:brk id="9"/></x:rowBreaks>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(positional)), 9);

  // Formatting only, and a prefixed `<x:extLst>` whose own `<x:v>` is not a cell value: both
  // answers are the ones the unprefixed sheets give, which is the whole point.
  const formattingOnly = `<x:sheetData>${'<x:row r="1"><x:c r="A1" s="3"/></x:row>'.repeat(4)}</x:sheetData>`;

  assert.equal(lastPopulatedSheetRow(Buffer.from(formattingOnly)), 0);

  const extended =
    '<x:sheetData><x:row r="3"><x:c r="A3" t="s"><x:v>0</x:v></x:c></x:row>' +
    '<x:row r="9000" s="2" customFormat="1"/></x:sheetData>' +
    '<x:extLst><x:ext uri="{x}"><x:v>1</x:v></x:ext></x:extLst>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(extended)), 3);

  // A `:` is not a prefix on its own, and a value loose in `<sheetData>` is the one shape the
  // scan refuses to answer for.
  assert.equal(lastPopulatedSheetRow(Buffer.from('<sheetData><v>1</v></sheetData>')), null);
});

/** The XML parts of a workbook `worksheetPath` and the row scan read. */
const XML_PARTS = ['/xl/workbook.xml', '/xl/_rels/workbook.xml.rels', '/xl/worksheets/sheet1.xml'];

/**
 * The same workbook with every attribute in those parts respelled in single quotes:
 * `<row r='6003'>`, `<sheet r:id='rId1'/>`, `<Relationship Id='rId1' Target='…'/>`. XML's two
 * quotings are the same document, `xlsx` parses either, and the quoting is as much the writer's
 * choice as the namespace prefix is — so this is the prefix hole from a third door.
 */
function singleQuotedAttributesBuffer(buffer) {
  const { CFB } = xlsx;
  const archive = CFB.read(buffer, { type: 'buffer' });

  for (const path of XML_PARTS) {
    const part = CFB.find(archive, path);
    // Values carrying no apostrophe of their own, which is every attribute these parts write.
    const xml = Buffer.from(part.content)
      .toString('utf8')
      .replace(/([\w.:-]+)="([^"']*)"/g, "$1='$2'");

    CFB.utils.cfb_add(archive, path, Buffer.from(xml, 'utf8'));
  }

  return CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

test('refuses a sheet whose places continue past the cut however its attributes are quoted', () => {
  // Reading only `="…"` left the same truncation reachable a third way: with `r='6003'` the row
  // scan fell through to counting tags and answered row 4, and with `r:id='rId1'` the sheet's
  // part was not located at all — either way `rowsRead: 1`, the place past the cut dropped, and
  // the operator told nothing.
  assert.throws(
    () => readCatalogBuffer(singleQuotedAttributesBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000))),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /more than the 5000 rows this import reads/.test(error.message)
  );

  // And the other side of the bound, for the same reason the prefixed pair has one.
  const sheet = readCatalogBuffer(singleQuotedAttributesBuffer(sparseCatalogBuffer(LAST_SHEET_ROW)));

  assert.equal(sheet.rowsRead, 2);
  assert.equal(sheet.places.length, 2);
});

test('refuses an XML workbook that does not say where its sheet is kept', () => {
  // The forgiving branch was written for a workbook whose parts are not XML — an .xlsb, whose
  // rows are binary records. An .xlsx that the scan cannot resolve a sheet part in is a
  // different answer: the check does not know what the parse left out, so it refuses rather
  // than pass. Here the relationship the sheet names is renamed, which `xlsx` reads past.
  const { CFB } = xlsx;
  const archive = CFB.read(sparseCatalogBuffer(LAST_SHEET_ROW + 1000), { type: 'buffer' });
  const rels = Buffer.from(CFB.find(archive, '/xl/_rels/workbook.xml.rels').content)
    .toString('utf8')
    .replace('Id="rId1"', 'Id="rIdX"');

  CFB.utils.cfb_add(archive, '/xl/_rels/workbook.xml.rels', Buffer.from(rels, 'utf8'));

  assert.throws(
    () => readCatalogBuffer(CFB.write(archive, { type: 'buffer', fileType: 'zip' })),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /does not say where the rows of sheet Лист1 are kept/.test(error.message)
  );
});

test('reads a row number written the ways XML allows', () => {
  // The quoting and the space around `=` are the writer's, the same way the prefix is. Asserted
  // on the part's bytes because no writer here produces either shape.
  assert.equal(
    lastPopulatedSheetRow(Buffer.from("<sheetData><row r='9'><c r='A9' t='s'><v>0</v></c></row></sheetData>")),
    9
  );
  assert.equal(
    lastPopulatedSheetRow(Buffer.from('<sheetData><row r = "9"><c><v>0</v></c></row></sheetData>')),
    9
  );

  // A row that states a number that is not one: counting tags would answer about a different
  // sheet, so this is the "cannot tell" the reader refuses on rather than a guess.
  assert.equal(
    lastPopulatedSheetRow(Buffer.from('<sheetData><row r="x"><c><v>0</v></c></row></sheetData>')),
    null
  );
});

/**
 * The same workbook with a comment written into its worksheet after the real rows, and
 * optionally one into `xl/workbook.xml` before the sheet list. Bytes shaped exactly like markup
 * that mean nothing to a parser — which is what makes them a door into a scan that reads tags
 * out of raw bytes.
 */
function commentedWorkbookBuffer(buffer, { sheetComment, bookComment } = {}) {
  const { CFB } = xlsx;
  const archive = CFB.read(buffer, { type: 'buffer' });

  if (sheetComment) {
    const xml = Buffer.from(CFB.find(archive, '/xl/worksheets/sheet1.xml').content)
      .toString('utf8')
      .replace('</sheetData>', `${sheetComment}</sheetData>`);

    CFB.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', Buffer.from(xml, 'utf8'));
  }

  if (bookComment) {
    const xml = Buffer.from(CFB.find(archive, '/xl/workbook.xml').content)
      .toString('utf8')
      .replace('<sheets>', `<sheets>${bookComment}`);

    CFB.utils.cfb_add(archive, '/xl/workbook.xml', Buffer.from(xml, 'utf8'));
  }

  return CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

test('refuses a sheet whose places continue past the cut however the part is commented', () => {
  // A comment holding a row of its own is the truncation from a fourth door: the scan read the
  // `<v>` inside `<!-- <row r="3"><v>fake</v></row> -->` as the last cell value and answered
  // "row 3" for a sheet whose second place sits a thousand rows past the cut — `rowsRead: 1`,
  // the place dropped, the operator told nothing.
  assert.throws(
    () =>
      readCatalogBuffer(
        commentedWorkbookBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000), {
          sheetComment: '<!-- <row r="3"><v>fake</v></row> -->'
        })
      ),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /more than the 5000 rows this import reads/.test(error.message)
  );

  // And the same bytes in the workbook part, where the answer comes the other way round:
  // `xlsx` counts a commented-out `<sheet>` as a sheet — `SheetNames` is `['Лист0', 'Лист1']`
  // here — so the sheet list is read as comment-blind as the parser reads it and the two indices
  // stay aligned. Masking this part instead would have shifted them apart and refused the file
  // for not saying where its rows are.
  assert.throws(
    () =>
      readCatalogBuffer(
        commentedWorkbookBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000), {
          bookComment: '<!-- <sheet name="Лист0" sheetId="9" r:id="rId9"/> -->'
        })
      ),
    (error) =>
      error instanceof CatalogWorkbookError &&
      /more than the 5000 rows this import reads/.test(error.message)
  );

  // The other side of the bound, because masking the comments must not start refusing a
  // workbook this import reads in full — a comment is legal XML, and a writer may put one in.
  const sheet = readCatalogBuffer(
    commentedWorkbookBuffer(sparseCatalogBuffer(LAST_SHEET_ROW), {
      sheetComment: '<!-- written by a generator -->',
      bookComment: '<!-- one sheet -->'
    })
  );

  assert.equal(sheet.rowsRead, 2);
  assert.equal(sheet.places.length, 2);
});

test('reads past the parts of a worksheet that are not markup', () => {
  // Comments, CDATA and processing instructions are masked before a tag is matched, so the row
  // the answer comes from is a row a parser sees. Asserted on the part's bytes: no writer here
  // produces any of these shapes.
  const commented =
    '<sheetData><row r="4"><c r="A4" t="s"><v>0</v></c></row>' +
    '<!-- <row r="2"><v>0</v></row> --></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(commented)), 4);

  // A comment between the value and its row tag must not be read as the row either: the row the
  // value sits in is still row 4, not the commented 2.
  const inside =
    '<sheetData><row r="4"><!-- <row r="2"> --><c r="A4" t="s"><v>0</v></c></row></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(inside)), 4);

  // Positional numbering, where a commented row tag must not be counted as one: three rows, the
  // third carrying the value.
  const positional =
    '<sheetData><row/><!-- <row/><row/> --><row/>' +
    '<row><c t="s"><v>0</v></c></row></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(positional)), 3);

  // Character data is character data however it is spelled: a `<v>` inside CDATA is text in a
  // cell, not a cell value, and a sheet of nothing else holds no value at all.
  const cdata = '<sheetData><row r="2"><c r="A2" t="inlineStr"><is><t><![CDATA[<v>7</v>]]></t></is>' +
    '</c></row></sheetData>';

  assert.equal(lastPopulatedSheetRow(Buffer.from(cdata)), 2);

  // Bytes that are not XML at all: an unterminated comment swallows the rest of the part, so
  // what the parse left out cannot be told — the answer the reader refuses on.
  assert.equal(
    lastPopulatedSheetRow(Buffer.from('<sheetData><row r="4"><c><v>0</v></c></row><!-- ')),
    null
  );
});

/**
 * The same workbook with its worksheet part re-encoded as UTF-16, declaration and byte order
 * mark included — the encoding XML names alongside UTF-8 as the one every parser must read, and
 * which `xlsx` does read: it decodes such a part and parses its cells like any other.
 *
 * `byteOrder` picks which of the two UTF-16 forms is written, because the mark is what tells
 * them apart and a scan that reads only one answers nothing for the other.
 */
function utf16WorksheetBuffer(buffer, { byteOrder = 'le' } = {}) {
  const { CFB } = xlsx;
  const archive = CFB.read(buffer, { type: 'buffer' });
  const xml = Buffer.from(CFB.find(archive, '/xl/worksheets/sheet1.xml').content)
    .toString('utf8')
    .replace(/encoding="[^"]*"/, 'encoding="UTF-16"');
  const part = Buffer.from(`\ufeff${xml}`, 'utf16le');

  CFB.utils.cfb_add(archive, '/xl/worksheets/sheet1.xml', byteOrder === 'be' ? part.swap16() : part);

  return CFB.write(archive, { type: 'buffer', fileType: 'zip' });
}

test('refuses a sheet whose places continue past the cut however the part is encoded', () => {
  // The truncation from a fifth door. `<row>` and `<v>` in a UTF-16 part are written with a NUL
  // between every letter, so a scan for single-byte tags found no value anywhere and answered
  // "row 0" — nothing past the cut — for a sheet whose second place sits a thousand rows past
  // it: `rowsRead: 1`, the place dropped, the operator told nothing.
  for (const byteOrder of ['le', 'be']) {
    assert.throws(
      () =>
        readCatalogBuffer(utf16WorksheetBuffer(sparseCatalogBuffer(LAST_SHEET_ROW + 1000), { byteOrder })),
      (error) =>
        error instanceof CatalogWorkbookError &&
        /more than the 5000 rows this import reads/.test(error.message),
      `byte order ${byteOrder}`
    );
  }

  // The other side of the bound, because decoding must not turn into refusing every workbook
  // that is not UTF-8: `xlsx` reads this one in full, so this import reads it in full too.
  const sheet = readCatalogBuffer(utf16WorksheetBuffer(sparseCatalogBuffer(LAST_SHEET_ROW)));

  assert.equal(sheet.rowsRead, 2);
  assert.equal(sheet.places.length, 2);
  assert.equal(sheet.problemsTotal, 0);
});

test('finds the last populated row in a worksheet that is not UTF-8', () => {
  // Asserted on the part's bytes, the way the prefixes and the quotings are: the row the answer
  // comes from has to be the row a parser sees, whichever of XML's two mandatory encodings the
  // writer chose. A byte order mark is what names the form; the NUL padding the leading `<`
  // carries says the same thing for a writer that left the mark out.
  const rows = '<sheetData><row r="2"><c r="A2" t="s"><v>0</v></c></row>' +
    '<row r="9"><c r="A9" t="inlineStr"><is><t>G4</t></is></c></row></sheetData>';
  const little = Buffer.from(`\ufeff${rows}`, 'utf16le');

  assert.equal(lastPopulatedSheetRow(little), 9);
  assert.equal(lastPopulatedSheetRow(Buffer.from(little).swap16()), 9);
  assert.equal(lastPopulatedSheetRow(Buffer.from(rows, 'utf16le')), 9);

  // And the encodings that cannot be scanned at all are the "cannot tell" the reader refuses
  // on, not a silent pass: UTF-32, which Node does not decode, and bytes that do not begin a
  // document in any ASCII-compatible encoding.
  assert.equal(lastPopulatedSheetRow(Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), little])), null);
  assert.equal(lastPopulatedSheetRow(Buffer.from([0x4c, 0x6f, 0xa7, 0x5a])), null);
  assert.equal(lastPopulatedSheetRow(Buffer.alloc(0)), null);

  // An odd byte count is no UTF-16 part either, however it starts.
  assert.equal(lastPopulatedSheetRow(Buffer.concat([little, Buffer.from([0x3c])])), null);
});
