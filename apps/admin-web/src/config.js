'use strict';

// Process configuration and the static floor-plan catalog.
//
// Everything here is read once at require time; nothing below this file reads
// process.env, so a renderer cannot quietly depend on the environment.

const port = Number(process.env.PORT || 3100);
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';
const mapStoragePath = process.env.MAP_STORAGE_PATH || '/app/storage/maps';
const appTimezone = process.env.APP_TIMEZONE || 'Europe/Moscow';

// Static reference plans only: the floor plan is a plain <img>, and the element list
// under it is the source of truth for what exists.
const parkingMaps = [
  {
    id: 'g3',
    title: 'G3',
    description: 'Underground parking level G3',
    filename: 'parking-g3.png'
  },
  {
    id: 'g4',
    title: 'G4',
    description: 'Underground parking level G4',
    filename: 'parking-g4.png'
  },
  {
    id: 'g5',
    title: 'G5',
    description: 'Underground parking level G5',
    filename: 'parking-g5.png'
  }
];

/**
 * Map codes are floor plan identifiers (g4); parking_places.floor_label is the bare digit
 * (4). This is the one place that conversion lives.
 */
function mapCodeToFloorLabel(mapCode) {
  return String(mapCode || '').replace(/^g/, '');
}

const allowedMapExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

function contentTypeForMap(filename) {
  if (filename.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (filename.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filename.endsWith('.png')) {
    return 'image/png';
  }
  return 'image/jpeg';
}

module.exports = {
  allowedMapExtensions,
  apiBaseUrl,
  appTimezone,
  contentTypeForMap,
  mapCodeToFloorLabel,
  mapStoragePath,
  parkingMaps,
  port
};
