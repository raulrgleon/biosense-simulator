"use strict";

function listScenarios(config) {
  return config.scenarios.map((item) => ({
    id: item.id,
    name: item.label,
    description: config.scenarioCopy[item.id] || "",
    continuous: item.id === "rising" || item.id === "falling" || item.id === "meal"
  }));
}

module.exports = { listScenarios };
