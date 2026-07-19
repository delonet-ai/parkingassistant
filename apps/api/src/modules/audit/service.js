'use strict';

const repository = require('./repository');

// Audit is cross-cutting: every other service records through `record` (pool-bound) or
// `recordIn` (client-bound, so the row commits or rolls back with the change it describes).
// Going through the service rather than importing this context's repository keeps the
// one-way dependency rule intact — no service reaches into another context's SQL.
function createAuditService({ dbRepository }) {
  async function record(entry) {
    return repository.insertAuditLog(dbRepository, entry);
  }

  async function recordIn(repo, entry) {
    return repository.insertAuditLog(repo, entry);
  }

  async function listAuditLogs(filters) {
    return repository.listAuditLogs(dbRepository, filters);
  }

  async function listAuditLogsForPlace(placeId) {
    return repository.listAuditLogsForPlace(dbRepository, placeId);
  }

  async function listAuditLogsForUser(userId) {
    return repository.listAuditLogsForUser(dbRepository, userId);
  }

  return {
    listAuditLogs,
    listAuditLogsForPlace,
    listAuditLogsForUser,
    record,
    recordIn
  };
}

module.exports = {
  createAuditService
};
