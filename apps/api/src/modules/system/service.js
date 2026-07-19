'use strict';

const repository = require('./repository');

// Two reads that belong to no business context: the liveness probe and the auth bootstrap
// state. Task 15 gave them a `system` context because no SQL was allowed to stay in
// server.js and neither had anywhere else to go.
function createSystemService({ pool, dbRepository }) {
  function isDatabaseConfigured() {
    return Boolean(pool);
  }

  async function selectDatabaseIdentity() {
    return repository.selectDatabaseIdentity(dbRepository);
  }

  async function findBootstrapSysadmin() {
    return repository.findBootstrapSysadmin(dbRepository);
  }

  async function listAuthUsers() {
    return repository.listAuthUsers(dbRepository);
  }

  return {
    findBootstrapSysadmin,
    isDatabaseConfigured,
    listAuthUsers,
    selectDatabaseIdentity
  };
}

module.exports = {
  createSystemService
};
