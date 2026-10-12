'use strict';

const zlib = require('node:zlib');

const xlsx = require('xlsx');

const {
  CATALOG_COLUMNS,
  mapCatalogRows,
  missingCatalogColumns
} = require('../../../../../packages/domain/catalog-rows');
const { withTransaction } = require('../../repositories/db');
const { AbortTransaction } = require('../../support/transaction');
const { auditActor } = require('../../support/actor');
const auditRepository = require('../audit/repository');
const repository = require('./repository');

// The parking catalog, imported from an Excel workbook.
//
// Two callers, one implementation: `POST /admin/catalog-import` hands over the bytes a browser
// uploaded, and `scripts/import/parking-catalog.js` hands over a file it read from the imports
// mount. Everything after "here is a workbook" is this module — the sheet it reads, the rows it
// refuses, the transaction it writes in and the audit row it leaves — because the one way for an
// upload feature to go wrong is to decide a row differently from the CLI that has been importing
// the real file all along.
//
// The sheet the catalog actually lives on. The CLI reads it from CATALOG_XLSX_SHEET and has
// always defaulted to this, so it stays the default here; a workbook saved with a renamed sheet
// is named explicitly instead.
const DEFAULT_SHEET = 'Лист1';

// How many rows of one sheet the import will read. The real catalog is a few hundred places,
// and the limit is three orders of magnitude of headroom — but an .xlsx is a zip, so a sheet of
// repeated junk rows stays well under the upload limit at two hundred thousand rows, and each
// row read becomes an `INSERT` into the staging table inside the open transaction.
//
// Enforced twice, because the two places bound different work. `sheetRows` in
// `readCatalogBuffer` stops the parser materializing cells past this many sheet rows, and the
// clamped range in `readRows` stops `sheet_to_json` *walking* past them. What the operator is
// refused by is still the rows that came back — a declared `<dimension>` is not evidence a
// sheet carries anything, and refusing the real catalog by its declaration is the defect the
// bound replaced.
const MAX_SHEET_ROWS = 5000;

// The last sheet row the reader looks at, 1-based: row 1 is the workbook's title, row 2 the
// header, and then the limit's worth of data rows plus one row of slack — the slack is what lets
// a sheet over the limit come back over the limit and be refused for it, rather than arrive
// truncated to exactly the limit and be imported as if it were the whole catalog.
//
// One row for all three bounds on purpose: the parser's cutoff (`sheetRows`), the range handed to
// `sheet_to_json` and the populated-row check in `readCatalogBuffer` all stop here, so "the
// reader saw the whole sheet" is a single fact rather than three that can disagree.
const LAST_SHEET_ROW = MAX_SHEET_ROWS + 3;

// How many columns of one sheet the import will walk. The catalog has six, and a header row
// Excel padded with formatting has a few more; sixty-four is headroom for that and nothing like
// a sheet's full 16384.
//
// This is not cosmetic. `sheet_to_json` iterates the sheet's *declared* range — the
// `<dimension ref>` tag, which whoever saved the file controls and which `xlsx` only recomputes
// from real cells when the tag is absent. A 16 KB workbook holding two cells can declare
// `A1:ZZ100000` and cost 36 seconds of synchronous cell lookups, during which this single-process
// API answers nothing; declaring the sheet maximum is two orders of magnitude worse again. The
// row and column bounds together cap that walk at a few hundred thousand lookups, so the file
// size the controller limits is once more proportional to the work the parse does.
const MAX_SHEET_COLUMNS = 64;

/** A workbook this module cannot read: not a spreadsheet, or no such sheet in it. */
class CatalogWorkbookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogWorkbookError';
  }
}

/**
 * The cells of one sheet, as row objects keyed by its header row.
 *
 * `range` is handed over as an object rather than as the row number 1 so the sheet's declared
 * extent can be clamped on the way in: the start row is pinned past the workbook's title row —
 * row 2 is the header and row 3 the first place, which is the numbering `mapCatalogRows` quotes
 * back in a problem — and the end is cut to `MAX_SHEET_ROWS` by `MAX_SHEET_COLUMNS`, which is
 * the bound a declared range of a million rows would otherwise have no reason to respect.
 * `defval: ''` keeps an empty cell as an empty string so a row with gaps is still refused by the
 * mapping rather than by a property lookup on `undefined`.
 *
 * The row end is `LAST_SHEET_ROW`, which keeps one data row of slack over `MAX_SHEET_ROWS` on
 * purpose: a sheet that really does carry more rows than the import reads has to come back over
 * the limit to be refused for it, rather than arrive silently truncated to exactly the limit and
 * imported as if it were the whole catalog. That slack only answers for a sheet whose rows are
 * *dense*, though — the limit counts rows that carry something and this cut is an absolute sheet
 * row, so a sheet with blank stretches can hold places past the cut and still come back under
 * the limit. The populated-row check in `readCatalogBuffer` is what closes that gap.
 */
function readRows(sheet) {
  const declared = sheet['!ref'];

  // A sheet with no cells has no declared range, and `decode_range(undefined)` would throw.
  if (!declared) {
    return [];
  }

  const range = xlsx.utils.decode_range(declared);

  // Pinned to row 2, not raised to it: the header's place is fixed, and the sheet's declared
  // start is the workbook's to say. A sheet declared from row 3 would otherwise move the header
  // down a row while `sheetRows` in `readCatalogBuffer` still cuts at an absolute row — so the
  // slack row would fall past the cut, and a sheet one row over the limit would be imported
  // truncated to exactly the limit. Pinned, a header anywhere else is refused as missing.
  range.s.r = 1;

  // Only a title row: there is no header to key the rows by, and an inverted range is not one
  // `sheet_to_json` is promised to read as empty.
  if (range.e.r < range.s.r) {
    return [];
  }

  range.e.r = Math.min(range.e.r, LAST_SHEET_ROW - 1);
  range.e.c = Math.min(range.e.c, range.s.c + MAX_SHEET_COLUMNS - 1);

  return xlsx.utils.sheet_to_json(sheet, { range, defval: '' });
}

/**
 * The rows of one catalog sheet, mapped to places and problems.
 */
function readSheet(workbook, { sheetName, sourceFile = null } = {}) {
  const resolved = sheetName || DEFAULT_SHEET;

  // Asked of `SheetNames`, not of `Sheets[resolved]`: the sheet name is a client-supplied
  // string, and `sheet=__proto__` (or `constructor`, or `toString`) finds a truthy *inherited*
  // property on the map of sheets, skipping this refusal to fail later and less clearly.
  if (!workbook.SheetNames.includes(resolved)) {
    throw new CatalogWorkbookError(
      `Sheet not found: ${resolved} (workbook has ${workbook.SheetNames.join(', ') || 'no sheets'})`
    );
  }

  const sheet = workbook.Sheets[resolved];
  const rows = readRows(sheet);

  // Blank rows are not in `rows` — `sheet_to_json` drops them unless asked for — so this is
  // the count of rows that carry something, which is also the count that would be staged.
  //
  // Said as "more than", without a total: `readRows` stops one row past the limit, so a sheet
  // of fifty thousand rows and one of five thousand and one are the same length here, and
  // quoting that length as the sheet's row count would be quoting the bound back.
  if (rows.length > MAX_SHEET_ROWS) {
    throw new CatalogWorkbookError(
      `Sheet ${resolved} carries more than the ${MAX_SHEET_ROWS} rows this import reads:` +
        ' this is not the parking catalog'
    );
  }

  // Before the rows: a sheet whose header is missing maps every row to empty cells, which the
  // mapping reads as blank separator lines and skips silently — so the refusal below would be
  // "nothing was understood" with nothing said about why.
  const missingColumns = rows.length > 0 ? missingCatalogColumns(rows) : [];

  if (missingColumns.length > 0) {
    throw new CatalogWorkbookError(
      `Sheet ${resolved} has no header row with ${missingColumns.join(', ')}:` +
        ` the header belongs in row 2, with the columns ${CATALOG_COLUMNS.join(', ')}`
    );
  }

  const { places, problems, problemsTotal } = mapCatalogRows(rows, {
    sourceFile,
    sourceSheet: resolved
  });

  return {
    sheetName: resolved,
    sourceFile,
    rowsRead: rows.length,
    places,
    problems,
    problemsTotal
  };
}

/**
 * One part of the workbook's zip as bytes, or `null` if the parse did not keep it.
 *
 * `bookFiles` hands back the entries `xlsx` already inflated — the zip parser inflates every
 * entry while reading the archive, whatever `sheets` and `sheetRows` then skip — so reaching for
 * them costs a lookup, not a second decompression. The view is built without copying: these
 * parts are the whole worksheet, and a catalog that is a megabyte of XML should not become two.
 */
function partBytes(workbook, path) {
  const entry = ((workbook && workbook.files) || {})[path];

  if (!entry || !entry.content) {
    return null;
  }

  const bytes = entry.content;

  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }

  return bytes.buffer
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
    : Buffer.from(bytes);
}

/**
 * The value of a start tag's attribute, by name, or `null` if the tag does not carry it.
 *
 * `namePattern` is a regex fragment for the attribute's name, so a caller can ask for `Id` or
 * for "`id` under any namespace prefix". The quoting is the writer's choice the same way the
 * prefix is: XML spells a value in single quotes as readily as in double ones and allows space
 * around the `=`, every form means the same attribute, and `xlsx` parses all of them — so
 * matching only `="…"` answers `null` for a file the parser read fine, which is a silent pass
 * through the row check in `readCatalogBuffer`.
 */
function attributeValue(tag, namePattern) {
  const match = new RegExp(`\\s${namePattern}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);

  if (!match) {
    return null;
  }

  return match[1] !== undefined ? match[1] : match[2];
}

/**
 * Where in the zip a named sheet's XML lives, or `null` if this workbook does not say.
 *
 * `xl/workbook.xml` lists the sheets in the order `SheetNames` reports them and gives each a
 * relationship id; `xl/_rels/workbook.xml.rels` turns that id into a part name. Read by matching
 * tags rather than with an XML parser: it is two tags deep, the alternative is a dependency, and
 * a name that does not resolve is answered with `null` rather than with a guess.
 *
 * Comments are *not* masked out here, the way they are before the row scan, and that is the
 * whole difference between the two readers: this one has to land on the part `xlsx` read, and
 * `xlsx` counts a commented-out `<sheet>` tag as a sheet — `SheetNames` comes back
 * `['Лист0', 'Лист1']` for one. Reading the list the same comment-blind way keeps the index this
 * looks the relationship id up by aligned with the one `SheetNames` gave; masking here would
 * shift the two apart and answer `null` for a file the parser resolved fine. The row scan has no
 * such partner to agree with — it answers about rows the parse never materialized — so there a
 * comment is nothing but bytes dressed as markup.
 */
function worksheetPath(workbook, sheetName) {
  const index = workbook.SheetNames.indexOf(sheetName);
  // Through `asciiMarkup` for the same reason the row scan is: these tags are matched as text,
  // and a UTF-16 `xl/workbook.xml` — which `xlsx` lists the sheets of without complaint — spells
  // `<sheet>` with a NUL between every letter, so the sheet's part would not be located at all.
  const book = asciiMarkup(partBytes(workbook, 'xl/workbook.xml'));
  const rels = asciiMarkup(partBytes(workbook, 'xl/_rels/workbook.xml.rels'));

  if (index < 0 || !book || !rels) {
    return null;
  }

  // Namespace-prefixed tags all the way down: SpreadsheetML and the relationships part may be
  // written as `<x:sheet>` and `<rel:Relationship>` as readily as unprefixed, the prefix is the
  // writer's choice, and `xlsx` parses either. Matching the literal tag would answer `null` here
  // for a file the parser read fine, which is a silent pass through the row check below.
  const sheetTags = book.toString('utf8').match(/<(?:[\w.-]+:)?sheet\b[^>]*>/g) || [];
  // `r:id` is the sheet's relationship id, and the prefix is whatever this file bound the
  // relationships namespace to. It is always prefixed — an unprefixed attribute is in no
  // namespace — so requiring one is also what keeps `sheetId` from being read as it.
  const relationshipId = attributeValue(sheetTags[index] || '', '[\\w.-]+:id');

  if (relationshipId === null) {
    return null;
  }

  // Every relationship, then the one whose `Id` matches. Comparing the parsed attribute rather
  // than building a pattern around the id keeps a value out of a `RegExp` — the id comes from an
  // uploaded file, and a `(` in it would otherwise make the constructor throw past every
  // `CatalogWorkbookError` this reader answers with — and reads either quoting on both sides.
  const relationships = rels.toString('utf8').match(/<(?:[\w.-]+:)?Relationship\b[^>]*>/g) || [];
  const relationship = relationships.find((tag) => attributeValue(tag, 'Id') === relationshipId);
  const target = relationship ? attributeValue(relationship, 'Target') : null;

  if (!target) {
    return null;
  }

  // Targets are written relative to `xl/`, and Excel sometimes writes them absolute
  // (`/xl/worksheets/sheet1.xml`); both name the same part.
  return `xl/${target.replace(/^\//, '').replace(/^xl\//, '')}`;
}

const LT = 0x3c; // `<`
const GT = 0x3e; // `>`
const SLASH = 0x2f; // `/`
const COLON = 0x3a; // `:`
const BANG = 0x21; // `!`
const QUESTION = 0x3f; // `?`
const SPACE = 0x20;

function isSpaceByte(byte) {
  return byte === SPACE || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * `bytes` in an encoding whose markup is single-byte ASCII — decoded if it is UTF-16, returned
 * as they are if they already are — or `null` if this scan cannot tell what they spell.
 *
 * Every scan below matches tag names as single bytes, which silently answers "nothing here" for
 * a part that spells them otherwise. A UTF-16 worksheet is the real case: `xlsx` decodes one and
 * parses its cells, while `<sheetData>`, `<row>` and `<v>` are written with a NUL between every
 * letter, so the row scan found no value at all and answered row 0 — a sheet whose places run
 * past the parser's cut imported as `rowsRead: 1`, the truncation this whole check exists to
 * stop, reached by a fifth door.
 *
 * Decoded rather than refused, because a workbook `xlsx` reads in full is one this import should
 * read in full. The decoded copy is only ever scanned, never handed back: the indices into it
 * are not indices into the part, and what leaves here is a row number.
 *
 * Anything else that cannot be scanned byte-wise is a "don't know", and the callers turn that
 * into a refusal: UTF-32, which Node does not decode, and any encoding whose document does not
 * even begin with a `<` — EBCDIC being the one that exists. An encoding that merely spells
 * *text* differently (UTF-8, any of the single-byte code pages) needs nothing: XML's own
 * characters are ASCII in all of them, and cell text is never read here.
 */
function asciiMarkup(bytes) {
  if (!bytes) {
    return null;
  }

  // UTF-32, by either byte order mark. Checked before UTF-16: a UTF-32LE mark starts with the
  // UTF-16LE one.
  const utf32 =
    bytes.length >= 4 &&
    ((bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) ||
      (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0));

  if (utf32) {
    return null;
  }

  // UTF-16 by its byte order mark, or — XML requires the mark, writers do not always — by the
  // NUL the leading `<` is padded with in either byte order.
  const little = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === LT && bytes[1] === 0));
  const big = bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === LT));

  if (little || big) {
    // An odd number of bytes is not UTF-16 at all, so what the parse read cannot be told.
    if (bytes.length % 2 !== 0) {
      return null;
    }

    // `swap16` works in place, and these bytes are the workbook's own part.
    const ordered = big ? Buffer.from(bytes).swap16() : bytes;

    return Buffer.from(ordered.toString('utf16le'), 'utf8');
  }

  let at = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

  while (at < bytes.length && isSpaceByte(bytes[at])) {
    at += 1;
  }

  return bytes[at] === LT ? bytes : null;
}

/**
 * A copy of `bytes` with everything that is not markup — comments, CDATA sections, processing
 * instructions — blanked out, or `null` if one of them is never closed.
 *
 * Every scan below reads tags out of raw bytes, and a comment is bytes that look exactly like
 * tags while meaning nothing to a parser: `<!-- <row r="3"><v>x</v></row> -->` written after the
 * real rows made the row scan answer "row 3" for a sheet whose places run past the cut, and the
 * truncated import this check exists to stop went through with `rowsRead: 1`.
 *
 * Blanked in place rather than removed, so every index this returns is still an index into the
 * part as the parser sees it — and blanked over the `<!--` and `-->` too, so nothing inside a
 * comment can be framed as a tag by what follows it.
 *
 * An unterminated construct is answered with `null` instead of a guess: the bytes are then not
 * XML, this scan cannot say what the parse left out, and the callers turn "don't know" into a
 * refusal. CDATA goes the same way as a comment because cell text is character data either way,
 * and masking it keeps a `<v>` spelled inside it from being read as a cell value.
 */
function maskNonMarkup(bytes) {
  let masked = null;
  let at = bytes.indexOf('<');

  while (at >= 0) {
    const next = bytes[at + 1];
    let end = -1;

    if (next === BANG) {
      if (bytes.slice(at, at + 4).toString('latin1') === '<!--') {
        const close = bytes.indexOf('-->', at + 4);

        end = close < 0 ? -1 : close + 3;
      } else if (bytes.slice(at, at + 9).toString('latin1') === '<![CDATA[') {
        const close = bytes.indexOf(']]>', at + 9);

        end = close < 0 ? -1 : close + 3;
      } else {
        // A declaration — a `<!DOCTYPE …>` with an internal subset of its own. A worksheet
        // carries none, and skipping one correctly means parsing it, so this is a "don't know".
        return null;
      }
    } else if (next === QUESTION) {
      const close = bytes.indexOf('?>', at + 2);

      end = close < 0 ? -1 : close + 2;
    } else {
      at = bytes.indexOf('<', at + 1);
      continue;
    }

    if (end < 0) {
      return null;
    }

    // Copied only once something has to be blanked: the common case is one XML declaration at
    // the top of the part, and a worksheet of several megabytes is not copied for nothing.
    masked = masked || Buffer.from(bytes);
    masked.fill(SPACE, at, end);
    at = bytes.indexOf('<', end);
  }

  return masked || bytes;
}

function isNameByte(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f || // `_`
    byte === 0x2d || // `-`
    byte === 0x2e // `.`
  );
}

function isTagNameEnd(byte) {
  return byte === GT || byte === SLASH || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/**
 * The byte before the tag name starting at `at`, skipping an XML namespace prefix — so for both
 * `<row` and `<x:row` this is the index of the `<`, and for `</row` the index of the `/`.
 * `-1` when a name cannot start there at all.
 */
function beforeTagName(bytes, at) {
  let index = at - 1;

  if (index >= 0 && bytes[index] === COLON) {
    const prefixEnd = index - 1;

    index = prefixEnd;

    while (index >= 0 && isNameByte(bytes[index])) {
      index -= 1;
    }

    if (index === prefixEnd) {
      return -1; // A `:` with no prefix in front of it is not a qualified name.
    }
  }

  return index;
}

/**
 * The index of the `<` of the last `<name …>` or `<prefix:name …>` start tag beginning at or
 * before `end`, or `-1`. Searching the local name and checking what frames it is what makes the
 * scan namespace-aware: the prefix is the writer's choice, `<x:row>` is the same element as
 * `<row>`, and only this check tells either of them from `<rowBreaks>` or `</row>`.
 */
function lastStartTagIndex(bytes, name, end) {
  let at = bytes.lastIndexOf(name, end);

  while (at >= 0) {
    const before = beforeTagName(bytes, at);

    if (before >= 0 && bytes[before] === LT && isTagNameEnd(bytes[at + name.length])) {
      return before;
    }

    if (at === 0) {
      return -1;
    }

    at = bytes.lastIndexOf(name, at - 1);
  }

  return -1;
}

/**
 * The index of the `<` of the last `</name>` or `</prefix:name>` end tag beginning at or before
 * `end`, or `-1`.
 */
function lastEndTagIndex(bytes, name, end) {
  let at = bytes.lastIndexOf(name, end);

  while (at >= 0) {
    const before = beforeTagName(bytes, at);
    const closes = bytes[at + name.length] === GT;

    if (before >= 1 && bytes[before] === SLASH && bytes[before - 1] === LT && closes) {
      return before - 1;
    }

    if (at === 0) {
      return -1;
    }

    at = bytes.lastIndexOf(name, at - 1);
  }

  return -1;
}

/**
 * The 1-based number of the last sheet row carrying a cell with a value, or `null` if this
 * worksheet cannot be read this way.
 *
 * This is the question the row limit cannot answer on its own. `sheetRows` cuts the parse at an
 * absolute sheet row while the limit counts rows that carry something, so a sheet with blank
 * stretches — a valid header, a place on row 3, blank rows for the next six thousand, one more
 * place after them — came back as a one-row catalog with nothing said about the place past the
 * cut, and applying that preview imported half a catalog. Answering it needs a look at the rows
 * the parser deliberately did not materialize, which is why this reads the part's bytes.
 *
 * Bytes, and from the back: `Buffer#lastIndexOf` walks native memory, so this costs a scan of a
 * part that is already in memory and no cell objects at all — orders of magnitude less than the
 * parse it is checking. Cells are in document order, so the last `<v>` or `<is>` in the part is
 * in the last row that holds a value, and the `<row>` tag before it names that row.
 *
 * A value element, not a cell: Excel writes `<row>` tags and `<c>` cells for rows it has only
 * *formatted*, and refusing the real catalog for the formatting its template carries is the
 * defect this file has already been through once.
 *
 * Elements by local name, because the prefix is the writer's: a worksheet may be written
 * `<x:sheetData><x:row><x:c><x:v>` with `x` bound to the spreadsheet namespace, `xlsx` reads it
 * as readily as the unprefixed form, and a scan for the literal tags answered "nothing past the
 * cut" for such a file — the truncated import this check exists to stop, by a different door.
 */
function lastPopulatedSheetRow(part) {
  // The encoding first: a part whose markup is not single-byte ASCII is one no scan below can
  // read, and `asciiMarkup` either hands back bytes they can or says it cannot tell.
  const markup = asciiMarkup(part);

  if (markup === null) {
    return null;
  }

  // Then comments and CDATA: they carry bytes shaped like tags that mean nothing to a parser,
  // and reading one as a cell value is a sheet reported whole that is not.
  const bytes = maskNonMarkup(markup);

  if (bytes === null) {
    return null;
  }

  // Only the rows, not what a worksheet writes after them. `<extLst>` carries vendor extensions
  // whose own elements this scan knows nothing about, and the real catalog's template does write
  // `<row>` tags for rows it has merely formatted — so a stray `<v>` past the rows, read as a
  // cell value, would point at one of those and refuse the real file. Cell text is XML-escaped,
  // so no place name can put a `<v>` here either.
  const rowsEnd = lastEndTagIndex(bytes, 'sheetData', bytes.length);
  const end = rowsEnd < 0 ? bytes.length : rowsEnd;
  const valueAt = Math.max(
    lastStartTagIndex(bytes, 'v', end),
    lastStartTagIndex(bytes, 'is', end)
  );

  if (valueAt < 0) {
    return 0;
  }

  const rowAt = lastStartTagIndex(bytes, 'row', valueAt);

  if (rowAt < 0) {
    return null;
  }

  const tagEnd = bytes.indexOf('>', rowAt);
  const tag = bytes.slice(rowAt, tagEnd < 0 ? bytes.length : tagEnd).toString('latin1');
  const number = attributeValue(tag, 'r');

  if (number !== null) {
    // A row that states its number but not as a number is one this scan cannot place, and the
    // positional count below would then be an answer about a sheet this is not.
    return /^\d+$/.test(number) ? Number(number) : null;
  }

  // A `<row>` without `r` is numbered by its position, so every row before it has a tag of its
  // own — including the blank ones, which is what makes counting them an answer and not a guess.
  let count = 0;
  let at = bytes.indexOf('row', 0);

  while (at >= 0) {
    const before = beforeTagName(bytes, at);
    // `<rowBreaks>` and `</row>` are a `row` too; only a start tag whose name ends here is a row.
    const isRow = before >= 0 && bytes[before] === LT && isTagNameEnd(bytes[at + 3]);

    if (isRow && before > rowAt) {
      break;
    }

    if (isRow) {
      count += 1;
    }

    at = bytes.indexOf('row', at + 3);
  }

  return count;
}

// How much the archive may unpack to, summed over its entries.
//
// Every other bound in this module bounds the *cell walk*, and all of them get their say too
// late: `xlsx.read` inflates every entry of the zip while reading the archive — the comment on
// `bookFiles` below says so — and only then is there a sheet to clamp a range on or rows to
// count. Deflate reaches about a thousand to one on repetitive bytes, so the ten megabytes the
// endpoint accepts is some ten gigabytes of inflation and tens of seconds of synchronous work
// in a single-process API, from one upload by one operator. The file does not even have to look
// like a catalog: it is refused after the parse, not before it.
//
// So the sizes are read where they cost a scan of the tail rather than a decompression: a zip's
// central directory states the uncompressed length of every entry, and it sits at the end of
// the archive. A sheet of `MAX_SHEET_ROWS` by `MAX_SHEET_COLUMNS` is a few megabytes of XML, so
// this leaves an order of magnitude over the real catalog and still bounds what one request can
// allocate.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_ENTRY_SIZE = 46;
// The field value a zip writes when the real one lives in a zip64 record instead.
const ZIP64_ESCAPE = 0xffffffff;

/** The offset of the end-of-central-directory record, which the archive's comment follows. */
function endOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - EOCD_SIZE - 0xffff);

  for (let at = buffer.length - EOCD_SIZE; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      return at;
    }
  }

  return null;
}

/**
 * What this archive unpacks to, summed over its directory, or `null` when the directory is not
 * one this scan can read — a truncated tail, or the zip64 records it deliberately does not
 * follow. `null` is a refusal at the call site rather than a pass: an archive whose declared
 * sizes cannot be read is exactly the archive whose inflation must not be attempted.
 */
function inflatedSize(buffer) {
  const eocd = endOfCentralDirectory(buffer);

  if (eocd === null) {
    return null;
  }

  const entries = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);

  if (at === ZIP64_ESCAPE || entries === 0xffff) {
    return null;
  }

  let total = 0;

  for (let entry = 0; entry < entries; entry += 1) {
    if (at < 0 || at + CENTRAL_ENTRY_SIZE > buffer.length) {
      return null;
    }

    if (buffer.readUInt32LE(at) !== CENTRAL_ENTRY_SIGNATURE) {
      return null;
    }

    const uncompressed = buffer.readUInt32LE(at + 24);

    if (uncompressed === ZIP64_ESCAPE) {
      return null;
    }

    total += uncompressed;
    at +=
      CENTRAL_ENTRY_SIZE +
      buffer.readUInt16LE(at + 28) +
      buffer.readUInt16LE(at + 30) +
      buffer.readUInt16LE(at + 32);
  }

  return total;
}

const LOCAL_ENTRY_SIGNATURE = 0x04034b50;
const LOCAL_ENTRY_SIZE = 30;
const DEFLATE = 8;

/**
 * Whether the archive's entries, actually inflated, stay within `budget` bytes.
 *
 * The directory's sizes are the archive's word, not a bound: `xlsx` inflates each deflated entry
 * from its local header to the end of the deflate stream, growing its buffer as far as the
 * stream goes, and compares the declared sizes only afterwards — and only with each other. An
 * archive that states ten bytes in both places and carries a gigabyte of zeros passes the
 * directory check and is unpacked in full. So every deflated entry is inflated here the way
 * `xlsx` will inflate it — from where its local header says the data starts, with nothing but
 * the stream to end it — under a ceiling zlib enforces while it writes, and the sum is judged.
 * The cost is bounded by `budget`, which is the point.
 */
function inflatesWithin(buffer, budget) {
  const eocd = endOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  let remaining = budget;

  for (let entry = 0; entry < entries; entry += 1) {
    const local = buffer.readUInt32LE(at + 42);

    if (local + LOCAL_ENTRY_SIZE > buffer.length || buffer.readUInt32LE(local) !== LOCAL_ENTRY_SIGNATURE) {
      return false;
    }

    if (buffer.readUInt16LE(local + 8) === DEFLATE) {
      const dataStart =
        local + LOCAL_ENTRY_SIZE + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      let inflated;

      try {
        inflated = zlib.inflateRawSync(buffer.subarray(dataStart), { maxOutputLength: remaining + 1 });
      } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') {
          return false;
        }

        // A stream zlib cannot read is one `xlsx` cannot read either; its parse says so better.
        inflated = Buffer.alloc(0);
      }

      if (inflated.length > remaining) {
        return false;
      }

      remaining -= inflated.length;
    }

    at +=
      CENTRAL_ENTRY_SIZE +
      buffer.readUInt16LE(at + 28) +
      buffer.readUInt16LE(at + 30) +
      buffer.readUInt16LE(at + 32);
  }

  return true;
}

/**
 * A catalog sheet, read from the bytes of a workbook. The only reader: the CLI reads the file
 * from the imports mount and the endpoint takes an upload, and both hand over a buffer, so
 * neither can be refused for a reason the other would not be.
 *
 * The signature check is not belt-and-braces: `xlsx.read` is deliberately forgiving and parses
 * arbitrary text as a one-sheet workbook called `Sheet1`, so a renamed .txt would otherwise be
 * refused with "Sheet not found: Лист1" — an answer that sends the operator looking for the
 * wrong mistake. An .xlsx is a zip archive, and every zip starts with `PK`.
 */
function readCatalogBuffer(buffer, options = {}) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new CatalogWorkbookError('Workbook could not be read: the file is not an .xlsx workbook');
  }

  const inflated = inflatedSize(buffer);

  if (inflated === null) {
    throw new CatalogWorkbookError(
      'Workbook could not be read: the file does not carry the directory an .xlsx workbook ends' +
        ' with, so what unpacking it would cost cannot be told'
    );
  }

  if (inflated > MAX_INFLATED_BYTES) {
    throw new CatalogWorkbookError(
      `Workbook could not be read: the file unpacks to ${Math.round(inflated / (1024 * 1024))} MB,` +
        ` more than the ${MAX_INFLATED_BYTES / (1024 * 1024)} MB this import reads: this is not` +
        ' the parking catalog'
    );
  }

  if (!inflatesWithin(buffer, MAX_INFLATED_BYTES)) {
    throw new CatalogWorkbookError(
      `Workbook could not be read: the file unpacks to more than the ${MAX_INFLATED_BYTES / (1024 * 1024)} MB` +
        ' this import reads, whatever its directory says: this is not the parking catalog'
    );
  }

  const sheetName = options.sheetName || DEFAULT_SHEET;
  let workbook;

  try {
    // Only the sheet the import reads is materialized; `SheetNames` is still the whole list, so
    // "Sheet not found" can still say what the workbook does have. A catalog file carries one
    // sheet, but a workbook with a megabyte of unrelated sheets would otherwise be parsed in
    // full to read one of them.
    // `sheetRows` bounds the parse the way the clamped range in `readRows` bounds the walk:
    // without it a ten-megabyte sheet of junk rows is materialized into cells in full before
    // anything gets to count them. It stops at `LAST_SHEET_ROW`, the same row both of them do.
    //
    // `bookFiles` keeps the zip's parts so the check below can look at the rows this cutoff
    // skipped. It makes the parse no more expensive — the entries are inflated while the archive
    // is read either way — it only stops them being thrown away.
    workbook = xlsx.read(buffer, {
      type: 'buffer',
      sheets: [sheetName],
      sheetRows: LAST_SHEET_ROW,
      bookFiles: true
    });
  } catch (error) {
    throw new CatalogWorkbookError(`Workbook could not be read: ${error.message}`);
  }

  // What the parse could not see. A sheet is only wholly read if nothing populated sits past the
  // row the parser stopped at, and the refusal has to come from the sheet's own rows: a declared
  // `<dimension>` spans every row Excel has ever formatted, so refusing by it would refuse the
  // real catalog — the defect this bound replaced.
  //
  // A workbook whose parts are not XML at all is the one case left unchecked: an .xlsb keeps its
  // sheets as binary records (`xl/workbook.bin`) that this scan cannot read, and for those the
  // reader stays exactly as forgiving as it has always been rather than refusing a file that
  // works. An .xlsx is a different matter — it says where its sheets are, every writer of one
  // does, and a part that cannot be located in a workbook that *is* XML means the check does not
  // know what the parse left out. That answer is a refusal, for the same reason an unplaceable
  // value is: silently skipping the check is how half a catalog gets imported.
  const sheetPath = worksheetPath(workbook, sheetName);
  const sheetBytes = sheetPath ? partBytes(workbook, sheetPath) : null;

  // The sheet has to be one this workbook has, or the refusal belongs to `readSheet`: "sheet not
  // found" names the operator's actual mistake and lists what the file does hold.
  const sheetMissing = workbook.SheetNames.indexOf(sheetName) < 0;

  if (!sheetBytes && !sheetMissing && partBytes(workbook, 'xl/workbook.xml')) {
    throw new CatalogWorkbookError(
      `Workbook could not be read: the workbook does not say where the rows of sheet ${sheetName}` +
        ' are kept, so what this import would leave out cannot be told'
    );
  }

  if (sheetBytes) {
    const lastRow = lastPopulatedSheetRow(sheetBytes);

    // Once the worksheet's own bytes are in hand the check either answers or refuses — a value
    // the scan cannot place in a row means it does not know what the parse missed, and the one
    // thing that must not follow from "don't know" is an import of half a catalog.
    if (lastRow === null) {
      throw new CatalogWorkbookError(
        `Workbook could not be read: the rows of sheet ${sheetName} are not laid out the way a` +
          ' worksheet is, so what this import would leave out cannot be told'
      );
    }

    if (lastRow > LAST_SHEET_ROW) {
      throw new CatalogWorkbookError(
        `Sheet ${sheetName} carries rows past row ${LAST_SHEET_ROW}, which is more than the` +
          ` ${MAX_SHEET_ROWS} rows this import reads: this is not the parking catalog`
      );
    }
  }

  return readSheet(workbook, { ...options, sheetName });
}

function createCatalogImportService({ pool }) {
  /**
   * Writes the places a sheet mapped to, or reports what writing them would do.
   *
   * Takes the reader's whole result rather than its places plus the source labels again: the
   * labels stamped into every place's metadata and the ones on the audit row then cannot
   * disagree, which they could while each caller threaded them separately.
   *
   * Returns the same summary either way, so neither caller has to know which mode it asked
   * for to read the answer.
   */
  async function importCatalog({ actor, dryRun = false, sheet }) {
    const places = sheet.places;
    try {
      return await withTransaction(pool, async (repo) => {
        await repository.createStagingTable(repo);

        for (const place of places) {
          await repository.stagePlace(repo, place);
        }

        await repository.deriveLines(repo);

        // Before the upserts: afterwards every staged row exists and the question
        // "created or updated?" has no answer left.
        const lines = await repository.countLineChanges(repo);
        const placeCounts = await repository.countPlaceChanges(repo);

        await repository.upsertLineGroups(repo);
        await repository.upsertPlaces(repo);
        await repository.assignPlaceLines(repo);

        await auditRepository.insertAuditLog(repo, {
          entityType: 'parking_place',
          action: 'parking_catalog_imported',
          ...auditActor(actor),
          metadata: {
            sourceFile: sheet.sourceFile ?? null,
            sourceSheet: sheet.sheetName ?? null,
            importedPlaces: places.length
          }
        });

        const summary = {
          dryRun,
          placesStaged: places.length,
          placesCreated: placeCounts.created,
          placesUpdated: placeCounts.updated,
          linesCreated: lines.created,
          linesUpdated: lines.updated
        };

        // A dry run runs the *whole* import — staging, lines, places, `assign_place_lines()`,
        // the audit row — and then aborts, which `withTransaction` turns into a rollback. The
        // counts it reports are therefore measured against the real tables with the real
        // constraints in force; a second, write-free code path would be a different program
        // reporting on behalf of this one, and would pass its tests while the apply it
        // predicts fails. `AbortTransaction` is the repo's carrier for exactly this — roll
        // back and still answer with a payload — and nothing else in the block throws it.
        if (dryRun) {
          throw new AbortTransaction(summary);
        }

        return summary;
      });
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      throw error;
    }
  }

  return { importCatalog };
}

module.exports = {
  CatalogWorkbookError,
  LAST_SHEET_ROW,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  createCatalogImportService,
  // Exported for `service.test.js` only: the two row numberings a worksheet may use cannot both
  // be produced by a writer in this repo — `xlsx` always writes the `r` attribute — so the
  // positional one is asserted on the part's bytes instead of through a zip.
  lastPopulatedSheetRow,
  readCatalogBuffer,
  // Exported for `service.test.js` only: a workbook whose `<dimension>` declares a million rows
  // costs minutes to *write* with `xlsx` and nothing to read once bounded, so the test that
  // pins the bound hands the parsed workbook shape straight over instead of round-tripping a
  // file. Nothing in the application calls this — `readCatalogBuffer` is the one reader.
  readSheet
};
