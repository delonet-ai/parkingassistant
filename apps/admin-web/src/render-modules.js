'use strict';

function createRenderModules(renderers) {
  return {
    audit: {
      render: renderers.renderAuditTab
    },
    catalog: {
      render: renderers.renderCatalogTab
    },
    day: {
      render: renderers.renderDayPage
    },
    lines: {
      render: renderers.renderLinesTab
    },
    maps: {
      render: renderers.renderMapEditorTab
    },
    requests: {
      render: renderers.renderRequestsTab
    }
  };
}

function renderActiveTab(renderModules, activeView, model) {
  const module = renderModules[activeView] || renderModules.day;
  return module.render(model);
}

module.exports = {
  createRenderModules,
  renderActiveTab
};
