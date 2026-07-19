'use strict';

// Render smoke tests for every page renderer.
//
// Before the Task 19 split these could not exist: the renderers lived inside a 3 900-line
// `server.js` that self-starts an HTTP listener on require and exports nothing, so the only
// way to assert a tab's HTML was to spawn the process and drive it over HTTP (see
// `tabs.test.js`, which still does exactly that as an end-to-end check). A page is now a
// pure function of a model, so this file calls it directly.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  INJECTION,
  buildEmployeeHistory,
  buildPageModel,
  buildPlaceHistory,
  EMPLOYEE_ID,
  PLACE_ID
} = require('../../testing/page-model');

const { renderAuditTab } = require('./audit');
const { renderCatalogTab } = require('./catalog');
const { renderDayPage } = require('./day');
const { renderLinesTab } = require('./lines');
const { renderPlacesTab } = require('./places');
const { renderRequestsTab } = require('./requests');
const { renderPage } = require('./layout');

const PAGES = [
  { view: 'day', render: renderDayPage },
  { view: 'requests', render: renderRequestsTab },
  { view: 'lines', render: renderLinesTab },
  { view: 'catalog', render: renderCatalogTab },
  { view: 'audit', render: renderAuditTab },
  { view: 'places', render: renderPlacesTab }
];

/** The probe as it must appear once escaped; its raw form must never appear. */
const ESCAPED_INJECTION = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';

describe('page renderers', () => {
  for (const { view, render } of PAGES) {
    describe(`renderers/${view}`, () => {
      it('returns non-empty HTML for a populated model', () => {
        const html = render(buildPageModel({ activeView: view }));

        assert.equal(typeof html, 'string');
        assert.ok(html.trim().length > 200, `${view} rendered only ${html.trim().length} chars`);
        assert.match(html, /</, 'the page produced no markup at all');
      });

      it('escapes untrusted values instead of interpolating them raw', () => {
        const html = render(buildPageModel({ activeView: view }));

        assert.doesNotMatch(html, /<script>alert/, `${view} interpolated a value without escaping`);
      });

      it('leaks neither undefined nor [object Object]', () => {
        const html = render(buildPageModel({ activeView: view }));

        assert.doesNotMatch(html, /undefined/);
        assert.doesNotMatch(html, /\[object Object\]/);
      });

      it('renders a non-blank page when every list is empty', () => {
        // The empty state is the state a fresh stand comes up in, so it must not be a
        // blank panel with no explanation.
        const empty = buildPageModel({
          activeView: view,
          places: { ok: true, status: 200, data: { status: 'ok', places: [] } },
          employees: { ok: true, status: 200, data: { status: 'ok', employees: [] } },
          permanentAssignments: { ok: true, status: 200, data: { status: 'ok', permanentAssignments: [] } },
          employeeRequests: { ok: true, status: 200, data: { status: 'ok', requests: [] } },
          guestRequests: { ok: true, status: 200, data: { status: 'ok', requests: [] } },
          jobRuns: { ok: true, status: 200, data: { status: 'ok', runs: [] } },
          lineGroups: { ok: true, status: 200, data: { status: 'ok', lineGroups: [] } },
          lineOccupancy: { ok: true, status: 200, data: { status: 'ok', occupancy: [] } },
          departurePlans: { ok: true, status: 200, data: { status: 'ok', plans: [] } },
          conflicts: { ok: true, status: 200, data: { status: 'ok', conflicts: [] } },
          auditLogs: { ok: true, status: 200, data: { status: 'ok', auditLogs: [] } },
          contactAccessLogs: { ok: true, status: 200, data: { status: 'ok', contactAccessLogs: [] } },
          placeLines: { ok: true, status: 200, data: { status: 'ok', lines: [] } }
        });
        const html = render(empty);

        assert.ok(html.trim().length > 200);
        assert.doesNotMatch(html, /undefined/);
      });

      it('survives a model whose envelopes carry no data at all', () => {
        // An API that is down answers `{ ok: false, data: null }`; a tab must still render.
        const failed = { ok: false, status: 502, data: null };
        const html = render(
          buildPageModel({
            activeView: view,
            places: failed,
            employees: failed,
            permanentAssignments: failed,
            dashboard: failed,
            employeeRequests: failed,
            guestRequests: failed,
            jobRuns: failed,
            lineGroups: failed,
            lineOccupancy: failed,
            departurePlans: failed,
            conflicts: failed,
            auditLogs: failed,
            contactAccessLogs: failed,
            mapDiagnostics: failed,
            placeLines: failed
          })
        );

        assert.ok(html.trim().length > 100);
        assert.doesNotMatch(html, /undefined/);
      });
    });
  }

  it('the escaping probe would actually be visible if a renderer failed to escape', () => {
    // A guard on the guard: if the fixture ever stopped carrying the probe, every
    // escaping assertion above would pass vacuously.
    const html = renderCatalogTab(buildPageModel({ activeView: 'catalog' }));

    assert.ok(INJECTION.includes('<script>'), 'the fixture no longer carries a probe');
    assert.match(html, new RegExp(ESCAPED_INJECTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('the catalog page renders the place history card when one is loaded', () => {
    const html = renderCatalogTab(
      buildPageModel({ activeView: 'catalog', selectedPlaceId: PLACE_ID, placeHistory: buildPlaceHistory() })
    );

    assert.match(html, /G4-118/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it('the catalog page renders the employee history card when one is loaded', () => {
    const html = renderCatalogTab(
      buildPageModel({ activeView: 'catalog', employeeHistory: buildEmployeeHistory(), selectedEmployeeId: EMPLOYEE_ID })
    );

    assert.ok(html.includes('ivanov@example.com') || html.length > 200);
    assert.doesNotMatch(html, /<script>alert/);
  });
});

describe('the page shell', () => {
  it('wraps each tab in a complete document', () => {
    for (const { view } of PAGES) {
      const html = renderPage(buildPageModel({ activeView: view }));

      assert.match(html, /^<!doctype html>/);
      assert.match(html, /<\/html>\s*$/);
      assert.doesNotMatch(html, /undefined/);
      assert.doesNotMatch(html, /<script>alert/);
    }
  });

  it('dispatches to the requested tab and falls back to День for an unknown one', () => {
    // The whitelist lives in the page route, so the shell only ever sees a valid view in
    // production; this is the second half of the "no ?view=maps alias" rule, asserted at
    // the shell so a future renderer registry cannot quietly re-add the retired key.
    //
    // Only the *content* falls back. The tab strip renders no highlight for an unknown
    // view, which is why this compares the body rather than the whole document.
    const body = (view) => renderPage(buildPageModel({ activeView: view })).split('</nav>')[1];

    assert.notEqual(body('places'), body('day'), 'the Места tab rendered the same HTML as День');
    assert.equal(body('maps'), body('day'), 'an unknown view must fall back to День, not alias to a tab');
    assert.equal(body('nonsense'), body('day'));
  });

  it('renders a notice when the redirect flags produced one', () => {
    const html = renderPage(
      buildPageModel({ notice: { type: 'error', text: `Ошибка ${INJECTION}` } })
    );

    assert.match(html, /notice-error/);
    assert.doesNotMatch(html, /<script>alert/, 'the notice text is operator-controlled and must be escaped');
  });
});
