'use strict';

// Adapter between the page model and the pure renderDayMap() component.

const { renderDayMap } = require('./day-map');
const { mapCodeToFloorLabel, parkingMaps } = require('../config');
const { configuredMaps } = require('./maps');
const { renderOperationalPlaceCard } = require('./place-card');
const { todayIsoDate } = require('./format');

function renderOperationalMap(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const selectedMapCode = model.selectedMapCode || parkingMaps[0]?.id || 'g4';

  return renderDayMap({
    maps: configuredMaps(model),
    selectedMapCode,
    // The floor selector speaks map codes (g4); parking_places.floor_label is the bare digit.
    selectedFloorLabel: mapCodeToFloorLabel(selectedMapCode),
    selectedDate,
    selectedPlaceId: model.selectedPlaceId || '',
    statusFilter: model.mapStatusFilter || '',
    typeFilter: model.mapTypeFilter || '',
    lines: model.placeLines?.data?.lines || [],
    placeCardHtml: renderOperationalPlaceCard(model)
  });
}

module.exports = {
  renderOperationalMap
};
