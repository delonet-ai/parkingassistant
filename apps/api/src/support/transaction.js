'use strict';

// `withTransaction` never inspects what the callback returns, so a service that wants to
// roll back and still answer with a normal payload throws this instead of returning it.
// The controller re-reads the payload off the error; every other error keeps its own mapping.
class AbortTransaction extends Error {
  constructor(result) {
    super('transaction aborted');
    this.name = 'AbortTransaction';
    this.result = result;
  }
}

function abortWith(statusCode, error, extra = {}) {
  return new AbortTransaction({
    statusCode,
    payload: {
      status: 'error',
      service: 'api',
      error,
      ...extra
    }
  });
}

module.exports = {
  AbortTransaction,
  abortWith
};
