'use strict';

const {
  MultipartFormatError,
  PayloadTooLargeError,
  parseMultipartFormData,
  readRawBody
} = require('../../../../../packages/shared/multipart');
const { requestActor } = require('../../support/actor');
const { internalError } = require('../../support/http-errors');
const { CatalogWorkbookError, readCatalogBuffer } = require('./service');

// The catalog upload: the only endpoint in the API that takes a file.
//
// `multipart/form-data`, because that is what a browser sends a file as, and the admin UI's
// server proxies `/api/*` byte for byte, boundary included. Fields:
//
//   catalogFile — the .xlsx workbook (required)
//   dryRun      — anything but the exact string "false" means dry run
//   sheet       — the sheet to read, default "Лист1" (the CLI's default too)
//
// `dryRun` defaults to a dry run on purpose: a caller that forgets the flag gets a report,
// not a rewritten catalog. The UI always sends it, and sends `false` only on the second,
// explicit step.
const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const FILE_FIELD = 'catalogFile';

// How much of the uploaded filename is kept. It is the client's string, and it is stamped into
// `metadata.sourceFile` of every staged place — so its length is paid once per row, and a
// megabyte-long name on a many-row sheet multiplies into a jsonb nobody asked for. The path is
// dropped with it: a browser sends a bare name, and anything else is not one.
const SOURCE_FILE_MAX_LENGTH = 200;

function sourceFileLabel(filename) {
  const name = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .slice(0, SOURCE_FILE_MAX_LENGTH)
    .trim();

  return name || null;
}

function badRequest(error, extra = {}) {
  return {
    statusCode: 400,
    payload: {
      status: 'error',
      service: 'api',
      error,
      ...extra
    }
  };
}

function createCatalogImportController({ services }) {
  const service = services.catalogImport;

  async function handleAdminCatalogImport(context) {
    let form;

    try {
      const body = await readRawBody(context.req, UPLOAD_LIMIT_BYTES);
      form = parseMultipartFormData(context.req.headers['content-type'] || '', body);
    } catch (error) {
      // Two failures are the request's fault and both quote nothing but their own message:
      // a body over the limit, or a content type that is not multipart. Told apart by type —
      // on the message, rewording the shared parser would turn a 413 into "malformed". A third
      // failure here is the socket, not the form (a body that stopped mid-upload), and calling
      // that a client format error would hide it from the log instead of reporting it.
      if (error instanceof PayloadTooLargeError || error instanceof MultipartFormatError) {
        return {
          statusCode: error instanceof PayloadTooLargeError ? 413 : 400,
          payload: {
            status: 'error',
            service: 'api',
            error: error.message
          }
        };
      }

      return internalError(error, 'handleAdminCatalogImport');
    }

    const file = form.files.get(FILE_FIELD);
    const sourceFile = sourceFileLabel(file && file.filename);
    const dryRun = String(form.fields.get('dryRun') ?? 'true').trim().toLowerCase() !== 'false';
    const sheetName = (form.fields.get('sheet') || '').trim() || undefined;

    if (!file || !file.buffer.length) {
      return badRequest(`${FILE_FIELD} must be an uploaded .xlsx workbook`);
    }

    let sheet;

    try {
      sheet = readCatalogBuffer(file.buffer, { sheetName, sourceFile });
    } catch (error) {
      if (error instanceof CatalogWorkbookError) {
        return badRequest(error.message);
      }

      return internalError(error, 'handleAdminCatalogImport');
    }

    // A workbook whose sheet maps to no place at all is the wrong file, not an import of
    // nothing: answering 200 would let the operator apply it and see the catalog unchanged
    // with no explanation. The problems say which rows were read and why none counted.
    if (sheet.places.length === 0) {
      return badRequest('No parking places were understood in this workbook', {
        sheet: sheet.sheetName,
        rowsRead: sheet.rowsRead,
        problems: sheet.problems,
        // `problems` is the first few hundred, `problemsTotal` is how many there were: a
        // wrong file can refuse more rows than anyone can read, and the count is the part of
        // that answer the operator actually needs.
        problemsTotal: sheet.problemsTotal
      });
    }

    try {
      const summary = await service.importCatalog({
        actor: requestActor(context),
        dryRun,
        sheet
      });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          import: {
            ...summary,
            sheet: sheet.sheetName,
            sourceFile,
            rowsRead: sheet.rowsRead
          },
          problems: sheet.problems,
          problemsTotal: sheet.problemsTotal
        }
      };
    } catch (error) {
      return internalError(error, 'handleAdminCatalogImport');
    }
  }

  return {
    name: 'catalog-import',
    routes: [
      {
        method: 'POST',
        path: '/admin/catalog-import',
        // Not advertised in the index at `GET /`: that list is a golden snapshot, and this
        // task does not regenerate it (same reason `/admin/reservations/move` is absent).
        handler: (context) => handleAdminCatalogImport(context)
      }
    ]
  };
}

module.exports = {
  createCatalogImportController
};
