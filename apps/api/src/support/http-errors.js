'use strict';

// The terminal branch of a controller's catch, after it has inspected `error.code` and found
// nothing it knows how to report. What is left is a driver or programming error, and its
// message quotes the input that produced it — constraint names, column types, the offending
// value. That belongs in the log, not in the response.
//
// Deliberately NOT used by the `jobs` and `system` controllers: a job outcome and the
// `/health/db` probe exist to tell the operator what went wrong, so their message is the
// payload rather than an accidental leak.
function internalError(error, context) {
  console.error(`unhandled error in ${context}`, error);

  return {
    statusCode: 500,
    payload: {
      status: 'error',
      service: 'api',
      error: 'Internal server error'
    }
  };
}

module.exports = {
  internalError
};
