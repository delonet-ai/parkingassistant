'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { filterDayLines, renderDayMap } = require('./day-map');

const MAPS = [
  { id: 'g3', title: 'G3', filename: 'parking-g3.png' },
  { id: 'g4', title: 'G4', filename: 'parking-g4.png' },
  { id: 'g5', title: 'G5', filename: 'parking-g5.png' }
];

function slot(overrides = {}) {
  return {
    placeId: 'place-1',
    code: '101',
    title: 'Место 101',
    placeType: 'single',
    position: 1,
    placeRole: 'regular',
    guestPriorityRank: null,
    status: 'free',
    userDisplayName: null,
    ...overrides
  };
}

function line(overrides = {}) {
  return {
    lineId: 'line-1',
    code: 'G4-101',
    capacity: 1,
    floorLabel: '4',
    slots: [slot()],
    ...overrides
  };
}

function render(overrides = {}) {
  return renderDayMap({
    maps: MAPS,
    selectedMapCode: 'g4',
    selectedFloorLabel: '4',
    selectedDate: '2026-07-19',
    placeCardHtml: '<aside class="place-drawer card"><h3>Место не выбрано</h3></aside>',
    lines: [line()],
    ...overrides
  });
}

describe('filterDayLines', () => {
  it('keeps only the selected floor', () => {
    const lines = [line(), line({ lineId: 'line-2', floorLabel: '5' })];

    assert.deepEqual(
      filterDayLines(lines, { floorLabel: '4' }).map((item) => item.lineId),
      ['line-1']
    );
  });

  it('filters by place type through the line capacity', () => {
    const lines = [
      line(),
      line({ lineId: 'line-2', capacity: 3, slots: [slot({ placeId: 'p2', placeType: 'triple' })] })
    ];

    assert.deepEqual(
      filterDayLines(lines, { type: 'triple' }).map((item) => item.lineId),
      ['line-2']
    );
    assert.deepEqual(
      filterDayLines(lines, { type: 'single' }).map((item) => item.lineId),
      ['line-1']
    );
  });

  it('keeps a line when at least one slot matches the status filter', () => {
    const mixed = line({
      lineId: 'line-2',
      capacity: 2,
      slots: [slot({ placeId: 'p2', status: 'occupied' }), slot({ placeId: 'p3', status: 'free' })]
    });
    const busy = line({
      lineId: 'line-3',
      capacity: 2,
      slots: [slot({ placeId: 'p4', status: 'occupied' }), slot({ placeId: 'p5', status: 'occupied' })]
    });

    assert.deepEqual(
      filterDayLines([mixed, busy], { status: 'free' }).map((item) => item.lineId),
      ['line-2']
    );
  });

  it('treats an unknown status as free, matching the renderer', () => {
    const odd = line({ slots: [slot({ status: 'sideways' })] });

    assert.equal(filterDayLines([odd], { status: 'free' }).length, 1);
    assert.equal(filterDayLines([odd], { status: 'blocked' }).length, 0);
  });

  it('combines filters and tolerates a missing line list', () => {
    const lines = [
      line(),
      line({ lineId: 'line-2', capacity: 2, slots: [slot({ placeId: 'p2', status: 'guest' })] })
    ];

    assert.equal(filterDayLines(lines, { floorLabel: '4', type: 'double', status: 'guest' }).length, 1);
    assert.equal(filterDayLines(lines, { floorLabel: '4', type: 'double', status: 'free' }).length, 0);
    assert.deepEqual(filterDayLines(undefined, {}), []);
  });
});

describe('renderDayMap', () => {
  it('renders the floor plan as a static image, not an SVG zone canvas', () => {
    const html = render();

    assert.match(html, /<img\s+class="place-floor-plan"/);
    assert.match(html, /src="\/maps\/parking-g4\.png"/);
    assert.doesNotMatch(html, /<svg/);
    assert.doesNotMatch(html, /viewBox/);
    assert.doesNotMatch(html, /map-zone/);
    assert.doesNotMatch(html, /\/admin\/map-zones/);
  });

  it('renders the element grid with slot buttons instead of zones', () => {
    const html = render();

    assert.match(html, /<article\s+class="place-line"/);
    assert.match(html, /class="place-slot place-slot--free"/);
    assert.match(html, /data-place-id="place-1"/);
    assert.match(html, /aria-pressed="false"/);
  });

  it('marks the selected slot with aria-pressed and the selected class', () => {
    const html = render({ selectedPlaceId: 'place-1' });

    assert.match(html, /place-slot--selected/);
    assert.equal(html.match(/aria-pressed="true"/g).length, 1);
  });

  it('keeps the drawer markup it is handed verbatim', () => {
    const html = render({ placeCardHtml: '<aside class="place-drawer card">DRAWER</aside>' });

    assert.match(html, /<aside class="place-drawer card">DRAWER<\/aside>/);
  });

  it('wires selection to the place-card endpoint, pushState and popstate', () => {
    const html = render();

    assert.match(html, /\/admin\/operational-place-card/);
    assert.match(html, /window\.history\.pushState/);
    assert.match(html, /addEventListener\('popstate'/);
    assert.match(html, /document\.querySelectorAll\('\.place-slot'\)/);
    assert.match(html, /querySelector\('\.place-drawer'\)/);
  });

  it('keeps the floor, status and type filters with the current values selected', () => {
    const html = render({ statusFilter: 'guest', typeFilter: 'double' });

    assert.match(html, /<select name="mapCode"/);
    assert.match(html, /<option value="g4" selected>G4<\/option>/);
    assert.match(html, /<option value="guest" selected>guest · гостевое<\/option>/);
    assert.match(html, /<option value="double" selected>double · двойное<\/option>/);
  });

  it('carries the active filters into the pushed day URL', () => {
    const html = render({ statusFilter: 'free', typeFilter: 'single' });

    assert.match(html, /params\.set\('status', statusFilter\)/);
    assert.match(html, /params\.set\('type', typeFilter\)/);
    assert.match(html, /const statusFilter = "free"/);
    assert.match(html, /const typeFilter = "single"/);
  });

  it('keeps the six-status legend with a word next to every colour token', () => {
    const html = render();

    for (const status of ['free', 'released', 'occupied', 'guest', 'rotatable', 'blocked']) {
      assert.match(html, new RegExp(`class="tag place-status-${status}"`));
    }
    assert.match(html, /free · свободно/);
    assert.match(html, /blocked · недоступно/);
  });

  it('applies the filters to what it renders, not just to the controls', () => {
    const lines = [
      line(),
      line({ lineId: 'line-2', capacity: 3, floorLabel: '4', slots: [slot({ placeId: 'p2', code: '201', placeType: 'triple' })] })
    ];
    const html = render({ lines, typeFilter: 'triple' });

    assert.match(html, /data-line-id="line-2"/);
    assert.doesNotMatch(html, /data-line-id="line-1"/);
  });

  it('hides other floors', () => {
    const html = render({ lines: [line(), line({ lineId: 'line-2', floorLabel: '5' })] });

    assert.match(html, /data-line-id="line-1"/);
    assert.doesNotMatch(html, /data-line-id="line-2"/);
  });

  it('renders the operational mode only — no editor controls on the Day tab', () => {
    const html = render();

    assert.doesNotMatch(html, /place-slot-role/);
    assert.doesNotMatch(html, /place-line-archive/);
    assert.doesNotMatch(html, /\/admin\/place-lines/);
  });

  it('escapes model values', () => {
    const html = render({
      lines: [line({ code: '<script>x</script>', slots: [slot({ code: '"><b>', userDisplayName: '<i>' })] })]
    });

    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /<i>/);
  });

  it('stays renderable with no lines at all', () => {
    const html = render({ lines: [] });

    assert.match(html, /class="empty"/);
    assert.doesNotMatch(html, /undefined/);
  });

  it('never emits undefined for a fully populated model', () => {
    const html = render({ selectedPlaceId: 'place-1', statusFilter: 'free', typeFilter: 'single' });

    assert.doesNotMatch(html, /undefined/);
  });
});
