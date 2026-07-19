'use strict';

// The Task 12 tab walk, as a committed test rather than a one-off manual check.
//
// Every admin tab is rendered against a canned API (no database) and asserted. Each
// `it` here corresponds to a defect the Task 12 sweep found, so the sweep's findings
// cannot silently come back.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const {
  BLOCKED_PLACE_ID,
  DISABLED_EMPLOYEE_ID,
  PLACE_ID,
  RELEASE_ID,
  getHtml,
  startAdminWeb,
  startStubApi
} = require('../testing/stub-api');

const DATE = '2026-07-19';

describe('admin tabs render against a stubbed API', () => {
  let api = null;
  let admin = null;

  before(async () => {
    api = await startStubApi();
    admin = await startAdminWeb({ apiBaseUrl: api.baseUrl });
  });

  after(async () => {
    if (admin) {
      await admin.stop();
    }
    if (api) {
      await api.stop();
    }
  });

  describe('every tab renders', () => {
    for (const view of ['day', 'requests', 'lines', 'catalog', 'audit', 'places']) {
      it(`?view=${view} returns a complete page`, async () => {
        const { status, html } = await getHtml(admin.baseUrl, `/?view=${view}&date=${DATE}`);

        assert.equal(status, 200);
        assert.match(html, /<\/html>/, 'the page is not truncated');
        assert.doesNotMatch(html, /undefined/, 'no undefined leaked into the markup');
        assert.doesNotMatch(html, /\[object Object\]/);
      });
    }

    it('an unknown view falls back to the Day tab instead of aliasing', async () => {
      // `?view=maps` was the retired tab key and `?view=dashboard` a retired alias.
      // Neither may resolve to anything but the whitelist fallback.
      for (const view of ['maps', 'dashboard', 'nonsense']) {
        const { status, html } = await getHtml(admin.baseUrl, `/?view=${view}&date=${DATE}`);

        assert.equal(status, 200);
        assert.match(html, /class="active" href="\/\?view=day/, `${view} must fall back to day`);
      }
    });
  });

  describe('the retired zone editor left nothing behind', () => {
    it('renders no SVG canvas, no zone markup and no calls to deleted endpoints', async () => {
      for (const view of ['day', 'places']) {
        const { html } = await getHtml(admin.baseUrl, `/?view=${view}&date=${DATE}`);

        assert.doesNotMatch(html, /viewBox/, `${view} still renders an SVG viewBox`);
        assert.doesNotMatch(html, /map-zone/, `${view} still renders zone markup`);
        assert.doesNotMatch(html, /\/admin\/map-zones/, `${view} still calls the deleted zone API`);
        assert.doesNotMatch(html, /\/admin\/places\/disable/, `${view} still calls the deleted disable API`);
        assert.doesNotMatch(html, /view=maps/, `${view} still links to the retired tab`);
      }
    });

    it('renders the floor plan as a static image', async () => {
      const { html } = await getHtml(admin.baseUrl, `/?view=day&date=${DATE}&mapCode=g4`);

      assert.match(html, /<img[^>]+class="[^"]*floor-plan/i);
    });
  });

  describe('the Линии / Места boundary', () => {
    it('Линии offers no control over what places exist', async () => {
      const { html } = await getHtml(admin.baseUrl, `/?view=lines&date=${DATE}`);

      assert.doesNotMatch(html, /\/admin\/place-lines/, 'inventory writes belong to Места');
      assert.doesNotMatch(html, /Одинарное|Двойное|Тройное/, 'add-element controls belong to Места');
      assert.doesNotMatch(html, /Удалить линию/, 'archiving belongs to Места');
    });

    it('Линии no longer prints the line inventory table', async () => {
      // The panel used to list every line with its capacity and member codes — the
      // Места question rendered on the occupancy tab.
      const { html } = await getHtml(admin.baseUrl, `/?view=lines&date=${DATE}`);

      assert.doesNotMatch(html, /<th>Мест<\/th>/);
      assert.match(html, /Фактические позиции в линиях/);
    });

    it('the position select is built from the chosen line, not hardcoded 1/2/3', async () => {
      // Rendering all places against a fixed 1/2/3 let the operator submit combinations
      // the API can only reject.
      const { html } = await getHtml(admin.baseUrl, `/?view=lines&date=${DATE}`);

      assert.match(html, /data-capacity="2"/, 'the line select carries its capacity');
      assert.match(html, /data-capacity="3"/);
      assert.match(html, /data-line-id=/, 'place options are tagged with their line');
      assert.doesNotMatch(html, /<option value="3">3 · третий<\/option>/, 'positions are no longer hardcoded');
    });

    it('Места shows slot status but not who is parked there today', async () => {
      // The stub's occupied slot carries an occupant name; the Day tab prints it and
      // the inventory editor must not.
      const day = await getHtml(admin.baseUrl, `/?view=day&date=${DATE}&mapCode=g4`);
      const places = await getHtml(admin.baseUrl, `/?view=places&date=${DATE}&mapCode=g4`);

      assert.match(day.html, /Сидоров Сидор/, 'the Day tab names the occupant');
      assert.match(places.html, /занято/, 'the editor still shows the slot is taken');
      assert.doesNotMatch(places.html, /Сидоров Сидор/, 'the editor must not name the occupant');
    });
  });

  describe('places are added and removed in exactly one way', () => {
    it('Справочники no longer offers a second place-create form', async () => {
      // It posted `lineGroupId: ''` while line_group_id has been NOT NULL since 005,
      // so it 500'd — and it was a second add path outside /admin/place-lines.
      const { html } = await getHtml(admin.baseUrl, `/?view=catalog&date=${DATE}`);

      assert.doesNotMatch(html, /action="\/admin\/places"/);
      assert.match(html, /Места создаются только на вкладке/);
    });

    it('the Места tab is the one that adds and archives elements', async () => {
      const { html } = await getHtml(admin.baseUrl, `/?view=places&date=${DATE}&mapCode=g4`);

      assert.match(html, /Одинарное/);
      assert.match(html, /Двойное/);
      assert.match(html, /Тройное/);
      assert.match(html, /Удалить линию/);
    });
  });

  describe('the place drawer', () => {
    it('reports the same status the slot does', async () => {
      // The drawer used to derive status from `isActive` and ignore place_role, so a
      // blocked slot reading «недоступно» opened a card reading «свободно».
      const { html } = await getHtml(
        admin.baseUrl,
        `/?view=day&date=${DATE}&mapCode=g4&placeId=${BLOCKED_PLACE_ID}`
      );

      assert.match(html, /place-status-blocked">недоступно</);
      assert.doesNotMatch(html, /place-status-free">свободно</);
    });

    it('prints the status word, not the raw English token', async () => {
      const { html } = await getHtml(
        admin.baseUrl,
        `/?view=day&date=${DATE}&mapCode=g4&placeId=${PLACE_ID}`
      );

      assert.match(html, /place-status-occupied">занято</);
    });

    it('offers both undo paths for a released and assigned place', async () => {
      // With reservation-cancel broken there was no way to undo an assignment at all.
      // Both exits now exist in the UI, and taking the release back is disabled until
      // the reservation on top of it is cancelled.
      const { html } = await getHtml(
        admin.baseUrl,
        `/?view=day&date=${DATE}&mapCode=g4&placeId=${PLACE_ID}`
      );

      assert.match(html, /action="\/admin\/reservations\/cancel"/);
      assert.match(html, /action="\/admin\/place-releases\/cancel"/);
      assert.match(html, new RegExp(`name="releaseId" value="${RELEASE_ID}"`));
      assert.match(html, /Вернуть место владельцу<\/button>/);
      assert.match(html, /disabled>Вернуть место владельцу/, 'blocked while a reservation stands');
    });
  });

  describe('the Журнал tab', () => {
    it('can run all five scheduled jobs manually', async () => {
      // Task 7 added unlock-employee-pool and rebuild-conflicts; the panel wired only three.
      const { html } = await getHtml(admin.baseUrl, `/?view=audit&date=${DATE}`);

      for (const job of [
        'lock-departure-plans',
        'process-queue',
        'rebuild-conflicts',
        'freeze-next-day',
        'unlock-employee-pool'
      ]) {
        assert.match(html, new RegExp(`action="/admin/jobs/${job}"`), `no control for ${job}`);
      }
    });
  });

  describe('the Справочники tab', () => {
    it('preselects the employee\'s real Активен value', async () => {
      // Neither option carried `selected`, so the form always rendered "Да" and every
      // save silently reactivated a disabled employee.
      const { html } = await getHtml(
        admin.baseUrl,
        `/?view=catalog&date=${DATE}&employeeId=${DISABLED_EMPLOYEE_ID}`
      );

      assert.match(html, /<option value="false" selected>Нет<\/option>/);
      assert.doesNotMatch(html, /<option value="true" selected>Да<\/option>/);
    });

    it('does not offer «Без линии», which line_group_id NOT NULL makes impossible', async () => {
      const { html } = await getHtml(
        admin.baseUrl,
        `/?view=catalog&date=${DATE}&placeId=${PLACE_ID}`
      );

      assert.doesNotMatch(html, /Без линии/);
    });
  });

  describe('no page fetches data nothing renders', () => {
    it('does not request /admin/place-releases on every render', async () => {
      // It was fetched on every page load, destructured, passed into renderPage and read
      // by no renderer.
      const before = api.requestedPaths.length;
      await getHtml(admin.baseUrl, `/?view=day&date=${DATE}`);
      const during = api.requestedPaths.slice(before);

      assert.ok(during.length > 0, 'the page did fetch something');
      assert.ok(
        !during.includes('/admin/place-releases'),
        'the unused release list is no longer fetched'
      );
    });
  });
});
