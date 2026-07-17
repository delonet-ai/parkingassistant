# Plan: ralphex trial — Task 1 only

## Overview

A single-task trial to validate the ralphex → claude → plan → commit pipeline end-to-end
without needing a database. This runs only the pure-unit-test task from the MVP plan.

## Validation Commands

- `npm run check`
- `npm run lint`
- `npm test`

## Phase 0 — Test safety net

### Task 1: Characterization tests for pure business logic
- [ ] Identify pure/near-pure logic in `apps/api/src/server.js` and `apps/api/src/services/availability.js` (19:00/07:00 cut-offs, 5-guest reserve math, conflict/early-departure calc, line-position ordering). Do not move code yet — just pin behavior.
- [ ] Add `node:test` unit tests covering `packages/shared/http.js` and `packages/shared/html.js` (escaping), which currently have no tests.
- [ ] Add `node:test` unit tests for at least one pure helper found in the api layer, asserting current behavior (happy path + boundary + invalid input).
- [ ] Run `npm run check && npm run lint && npm test`; all green.
- [ ] Mark completed.
