'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  PLACE_ROLE_OPTIONS,
  PLACE_STATUSES,
  renderPlaceLines,
  statusLabel
} = require('./render-place-lines');

function line(overrides = {}) {
  return {
    lineId: 'line-1',
    code: 'G4-101',
    capacity: 1,
    floorLabel: '4',
    slots: [
      {
        placeId: 'place-1',
        code: '101',
        title: 'Место 101',
        placeType: 'single',
        position: 1,
        placeRole: 'regular',
        guestPriorityRank: null,
        status: 'free',
        userDisplayName: null
      }
    ],
    ...overrides
  };
}

function tripleLine() {
  return line({
    lineId: 'line-3',
    code: 'G4-118',
    capacity: 3,
    slots: [
      { placeId: 'p-118', code: '118', placeType: 'triple', position: 1, placeRole: 'regular', status: 'free' },
      { placeId: 'p-119', code: '119', placeType: 'triple', position: 2, placeRole: 'regular', status: 'occupied', userDisplayName: 'Иванов' },
      { placeId: 'p-120', code: '120', placeType: 'triple', position: 3, placeRole: 'rotatable', status: 'guest' }
    ]
  });
}

function countOf(html, needle) {
  return html.split(needle).length - 1;
}

describe('renderPlaceLines', () => {
  it('renders one slot button per slot for a single element', () => {
    const html = renderPlaceLines({ lines: [line()] });

    assert.equal(countOf(html, '<article'), 1);
    assert.equal(countOf(html, 'class="place-slot '), 1);
    assert.match(html, /data-capacity="1"/);
    assert.match(html, /data-place-id="place-1"/);
  });

  it('renders a double element with two slots and front/rear labels', () => {
    const double = line({
      lineId: 'line-2',
      capacity: 2,
      slots: [
        { placeId: 'p-a', code: '101', position: 1, status: 'free' },
        { placeId: 'p-b', code: '102', position: 2, status: 'released' }
      ]
    });
    const html = renderPlaceLines({ lines: [double] });

    assert.equal(countOf(html, 'class="place-slot '), 2);
    assert.match(html, /перёд/);
    assert.match(html, /зад/);
    assert.doesNotMatch(html, /середина/);
  });

  it('stacks a triple element front to rear in physical order', () => {
    const html = renderPlaceLines({ lines: [tripleLine()] });

    assert.equal(countOf(html, 'class="place-slot '), 3);
    assert.ok(html.indexOf('p-118') < html.indexOf('p-119'));
    assert.ok(html.indexOf('p-119') < html.indexOf('p-120'));
    assert.ok(html.indexOf('перёд') < html.indexOf('середина'));
    assert.ok(html.indexOf('середина') < html.indexOf('зад'));
  });

  it('omits the position label for a single-slot element', () => {
    const html = renderPlaceLines({ lines: [line()] });

    assert.doesNotMatch(html, /place-slot-position/);
  });

  it('carries a status class and the status word for every status', () => {
    const lines = PLACE_STATUSES.map((status, index) =>
      line({
        lineId: `line-${status}`,
        code: `G4-${index}`,
        slots: [{ placeId: `p-${status}`, code: `${index}`, position: 1, status }]
      })
    );
    const html = renderPlaceLines({ lines });

    for (const status of PLACE_STATUSES) {
      assert.ok(html.includes(`place-slot--${status}`), `missing class for ${status}`);
      assert.ok(html.includes(`>${statusLabel(status)}<`), `missing word for ${status}`);
      assert.notEqual(statusLabel(status), status);
    }
  });

  it('falls back to free for an unknown status instead of emitting it as a class', () => {
    const html = renderPlaceLines({
      lines: [line({ slots: [{ placeId: 'p-x', code: '1', position: 1, status: 'nonsense' }] })]
    });

    assert.match(html, /place-slot--free/);
    assert.doesNotMatch(html, /nonsense/);
  });

  it('marks only the selected slot with aria-pressed=true', () => {
    const html = renderPlaceLines({ lines: [tripleLine()], selectedPlaceId: 'p-119' });

    assert.equal(countOf(html, 'aria-pressed="true"'), 1);
    assert.equal(countOf(html, 'aria-pressed="false"'), 2);
    assert.equal(countOf(html, 'place-slot--selected'), 1);
  });

  it('leaves every slot unpressed when nothing is selected', () => {
    const html = renderPlaceLines({ lines: [tripleLine()] });

    assert.equal(countOf(html, 'aria-pressed="true"'), 0);
    assert.equal(countOf(html, 'aria-pressed="false"'), 3);
  });

  it('adds the role control and archive button only in editor mode', () => {
    const operational = renderPlaceLines({ lines: [tripleLine()] }, { mode: 'operational' });
    const editor = renderPlaceLines({ lines: [tripleLine()], selectedDate: '2026-07-19' }, { mode: 'editor' });

    assert.doesNotMatch(operational, /place-slot-role/);
    assert.doesNotMatch(operational, /place-line-archive/);
    assert.equal(countOf(editor, 'place-slot-role'), 3);
    assert.equal(countOf(editor, 'place-line-archive'), 1);

    for (const [value] of PLACE_ROLE_OPTIONS) {
      assert.ok(editor.includes(`value="${value}"`), `missing role option ${value}`);
    }
    assert.match(editor, /name="placeRole"/);
    assert.match(editor, /action="\/admin\/places\/update"/);
  });

  it('resends the slot values /admin/places/update overwrites rather than coalesces', () => {
    const guest = line({
      slots: [
        {
          placeId: 'p-g',
          code: '110',
          title: 'Место 110',
          placeType: 'single',
          position: 1,
          placeRole: 'rotatable',
          guestPriorityRank: 7,
          status: 'rotatable'
        }
      ]
    });
    const html = renderPlaceLines({ lines: [guest], selectedDate: '2026-07-19', mapCode: 'g4' }, { mode: 'editor' });

    assert.match(html, /name="linePositionHint" value="1"/);
    assert.match(html, /name="guestPriorityRank" value="7"/);
    assert.match(html, /name="placeType" value="single"/);
    assert.match(html, /name="floorLabel" value="4"/);
    assert.match(html, /name="mapCode" value="g4"/);
    assert.match(html, /value="rotatable" selected/);
  });

  it('groups lines into one section per floor', () => {
    const html = renderPlaceLines({
      lines: [line(), line({ lineId: 'line-g5', code: 'G5-301', floorLabel: '5', slots: [{ placeId: 'p-301', code: '301', position: 1, status: 'free' }] })]
    });

    assert.equal(countOf(html, '<section class="place-floor"'), 2);
    assert.match(html, /Этаж G4/);
    assert.match(html, /Этаж G5/);
  });

  it('escapes data that reaches the markup', () => {
    const html = renderPlaceLines({
      lines: [
        line({
          code: '<script>x</script>',
          slots: [{ placeId: 'p-e', code: '"&<>', position: 1, status: 'occupied', userDisplayName: '<b>Иванов</b>' }]
        })
      ]
    });

    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.doesNotMatch(html, /<b>Иванов<\/b>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;&amp;&lt;&gt;/);
  });

  it('returns a non-empty empty-state instead of blank markup', () => {
    assert.match(renderPlaceLines({ lines: [] }), /class="empty"/);
    assert.match(renderPlaceLines({}), /class="empty"/);
    assert.match(renderPlaceLines(), /class="empty"/);
  });
});
