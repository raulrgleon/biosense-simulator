"use strict";

const engine = require("../../app.js");
const { listScenarios } = require("./scenarios");
const { createSeededRng, generateSeed, driftNaFromRatePerMin, normalizeSeed } = require("./rng");
const { createRunner } = require("./runner");

const runner = createRunner(engine);

function getDefaults() {
  const params = engine.sessionControlParams({
    scenario: "stable",
    sensitivity: engine.CONFIG.sensitivity.default,
    baseline: engine.CONFIG.baseline.default,
    drift: engine.CONFIG.drift.default,
    noiseRms: engine.CONFIG.noise.default,
    tempC: engine.CONFIG.temperature.default,
    tempCoeff: engine.CONFIG.tempCoeff.default,
    vref: engine.CONFIG.vref.default,
    rf: 1e6,
    cf: 100e-9,
    vcc: engine.CONFIG.vcc,
    adcBits: engine.CONFIG.adcBitsDefault,
    adcVref: engine.CONFIG.adcVref.default,
    oxygenLevel: engine.CONFIG.oxygen.default,
    oxygenSensitivity: engine.CONFIG.oxygen.sensitivity.default,
    oxygenBaseline: 0,
    oxygenDrift: 0,
    oxygenNoiseRms: 0,
    oxygenVref: engine.CONFIG.vref.default,
    oxygenRf: 1e6,
    oxygenCf: 100e-9,
    oxygenInfluenceEnabled: false,
    oxygenInfluenceCoeff: 0,
    initialGlucose: engine.CONFIG.glucose.default
  });
  return engine.captureConfiguration(params);
}

module.exports = Object.assign({}, engine, runner, {
  listScenarios: () => listScenarios(engine.CONFIG),
  getDefaults,
  createSeededRng,
  generateSeed,
  driftNaFromRatePerMin,
  normalizeSeed
});
