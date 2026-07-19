'use strict';

// The business rules, with zero I/O dependencies (ADR 003). Services fetch data
// through repositories and hand it to these functions; nothing here knows about
// Postgres, HTTP, or HTML.

module.exports = {
  ...require('./conflicts'),
  ...require('./guest-reserve'),
  ...require('./line-inventory'),
  ...require('./line-ordering'),
  ...require('./queue'),
  ...require('./scheduling')
};
