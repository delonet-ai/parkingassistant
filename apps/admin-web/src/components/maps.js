'use strict';

// Floor plan metadata: the static plan list merged with whatever the API knows about
// the uploaded background.

const path = require('node:path');
const { parkingMaps } = require('../config');

function filenameFromMapFilePath(filePath, fallbackFilename) {
  if (!filePath) {
    return fallbackFilename;
  }

  return path.basename(String(filePath));
}

function configuredMaps(model = {}) {
  const mapsByCode = new Map((model.mapDiagnostics?.data?.maps || []).map((map) => [map.code, map]));

  return parkingMaps.map((fallback) => {
    const metadata = mapsByCode.get(fallback.id) || null;
    return {
      ...fallback,
      filename: filenameFromMapFilePath(metadata?.filePath, fallback.filename),
      metadata
    };
  });
}

module.exports = {
  configuredMaps,
  filenameFromMapFilePath
};
