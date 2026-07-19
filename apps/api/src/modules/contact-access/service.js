'use strict';

const repository = require('./repository');

function createContactAccessService({ dbRepository }) {
  async function listContactAccessLogs({ date, limit }) {
    return repository.listContactAccessLogs(dbRepository, { date, limit });
  }

  // The two write paths belong to this context even though the only caller today is the
  // line-occupancy controller: `contact_access_logs` is the audit trail of who was allowed
  // to see whose phone number, and only this module is allowed to append to it.
  async function recordNoBlockers(entry) {
    return repository.insertNoBlockersLog(dbRepository, entry);
  }

  async function recordContactAccess(entry) {
    return repository.insertContactAccessLog(dbRepository, entry);
  }

  return {
    listContactAccessLogs,
    recordContactAccess,
    recordNoBlockers
  };
}

module.exports = {
  createContactAccessService
};
