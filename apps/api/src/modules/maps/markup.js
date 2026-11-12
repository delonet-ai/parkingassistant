'use strict';

// Shape rules for a floor-plan markup document (ADR 008). Pure: no database, no HTTP.
//
// The document is presentation only — where each place is drawn on one plan image — so the
// rules here are about geometry being usable, not about parking. Whether a place id exists
// and sits on this floor is the service's check, against the database.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_IMAGE_SIDE = 20000;
const MIN_POLYGON_POINTS = 3;
const MAX_POLYGON_POINTS = 64;
const MAX_PLACES = 2000;
const MAX_EDITOR_BYTES = 256 * 1024;
// A polygon may hang slightly over the image edge — a stall drawn against the plan's border —
// but one that lies far outside is a coordinate-system mistake, not a place.
const EDGE_TOLERANCE = 0.05;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readImageSide(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_SIDE) {
    return { error: `${name} must be an integer from 1 to ${MAX_IMAGE_SIDE}` };
  }

  return { value };
}

function normalizePolygon(raw, { width, height }) {
  if (!Array.isArray(raw) || raw.length < MIN_POLYGON_POINTS || raw.length > MAX_POLYGON_POINTS) {
    return { error: `polygon must have ${MIN_POLYGON_POINTS} to ${MAX_POLYGON_POINTS} points` };
  }

  const minX = -width * EDGE_TOLERANCE;
  const maxX = width * (1 + EDGE_TOLERANCE);
  const minY = -height * EDGE_TOLERANCE;
  const maxY = height * (1 + EDGE_TOLERANCE);
  const points = [];

  for (const point of raw) {
    if (!Array.isArray(point) || point.length !== 2) {
      return { error: 'every polygon point must be [x, y]' };
    }

    const [x, y] = point;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: 'polygon coordinates must be finite numbers' };
    }

    if (x < minX || x > maxX || y < minY || y > maxY) {
      return { error: 'polygon lies outside the plan image' };
    }

    // A tenth of an image pixel is far below what anyone can draw; rounding keeps the stored
    // document small and the round trip stable.
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }

  return { value: points };
}

/**
 * Validate and normalize a markup save request.
 *
 * Returns `{ value }` with `{ mapCode, imageWidth, imageHeight, places, editor, revision }`,
 * or `{ error, details }` naming what is wrong — for a bad place, its id.
 */
function readMarkupDocument(body) {
  if (!isPlainObject(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  const mapCode = typeof body.mapCode === 'string' ? body.mapCode.trim().toLowerCase() : '';

  if (!mapCode) {
    return { error: 'mapCode is required' };
  }

  const width = readImageSide(body.imageWidth, 'imageWidth');
  const height = readImageSide(body.imageHeight, 'imageHeight');
  const invalidSide = [width, height].find((side) => side.error);

  if (invalidSide) {
    return { error: invalidSide.error };
  }

  let revision = null;

  if (body.revision !== null && body.revision !== undefined) {
    if (!Number.isInteger(body.revision) || body.revision < 1) {
      return { error: 'revision must be a positive integer, or null for the first save' };
    }

    revision = body.revision;
  }

  if (!isPlainObject(body.places)) {
    return { error: 'places must be an object keyed by parking place id' };
  }

  const entries = Object.entries(body.places);

  if (entries.length > MAX_PLACES) {
    return { error: `markup may hold at most ${MAX_PLACES} places` };
  }

  const places = {};

  for (const [rawId, entry] of entries) {
    if (!UUID.test(rawId)) {
      return { error: 'every places key must be a parking place id', details: { placeId: rawId } };
    }

    const polygon = normalizePolygon(isPlainObject(entry) ? entry.polygon : null, {
      width: width.value,
      height: height.value
    });

    if (polygon.error) {
      return { error: polygon.error, details: { placeId: rawId } };
    }

    places[rawId.toLowerCase()] = { polygon: polygon.value };
  }

  const editor = body.editor === undefined || body.editor === null ? {} : body.editor;

  if (!isPlainObject(editor)) {
    return { error: 'editor must be an object' };
  }

  if (Buffer.byteLength(JSON.stringify(editor), 'utf8') > MAX_EDITOR_BYTES) {
    return { error: `editor state must be at most ${MAX_EDITOR_BYTES / 1024} KB` };
  }

  return {
    value: {
      mapCode,
      imageWidth: width.value,
      imageHeight: height.value,
      places,
      editor,
      revision
    }
  };
}

module.exports = {
  MAX_EDITOR_BYTES,
  MAX_POLYGON_POINTS,
  readMarkupDocument
};
