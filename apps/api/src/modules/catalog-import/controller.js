'use strict';

const {
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
      // Both failures are the request's fault and both quote nothing but their own message:
      // a body over the limit, or a content type that is not multipart. Told apart by type —
      // on the message, rewording the shared parser would turn a 413 into "malformed".
      return {
        statusCode: error instanceof PayloadTooLargeError ? 413 : 400,
        payload: {
          status: 'error',
          service: 'api',
          error: error.message
        }
      };
    }

    const file = form.files.get(FILE_FIELD);
    const dryRun = String(form.fields.get('dryRun') ?? 'true').trim().toLowerCase() !== 'false';
    const sheetName = (form.fields.get('sheet') || '').trim() || undefined;

    if (!file || !file.buffer.length) {
      return badRequest(`${FILE_FIELD} must be an uploaded .xlsx workbook`);
    }

    let sheet;

    try {
      sheet = readCatalogBuffer(file.buffer, { sheetName, sourceFile: file.filename });
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
        problems: sheet.problems
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
            sourceFile: file.filename,
            rowsRead: sheet.rowsRead
          },
          problems: sheet.problems
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
