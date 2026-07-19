'use strict';

// The page registry: one renderer per tab, keyed by the ?view= value.
//
// Kept separate from layout.js so the shell can dispatch into a page without any page
// having to know the shell exists.

const { createRenderModules } = require('./registry');
const { renderAuditTab } = require('./audit');
const { renderCatalogTab } = require('./catalog');
const { renderDayPage } = require('./day');
const { renderLinesTab } = require('./lines');
const { renderPlacesTab } = require('./places');
const { renderRequestsTab } = require('./requests');

const renderModules = createRenderModules({
  renderAuditTab,
  renderCatalogTab,
  renderDayPage,
  renderLinesTab,
  renderPlacesTab,
  renderRequestsTab
});

module.exports = {
  renderModules
};
