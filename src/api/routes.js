"use strict";

const engine = require("../engine");
const {
  validateSimulationBody,
  validateSweepBody,
  validateCompareBody
} = require("../engine/validation");
const {
  DISCLAIMER,
  mergeDefaults,
  presentSession,
  runConfigured,
  sweepRow,
  applySweepValue,
  countSamples,
  createSeededRng
} = require("./mapper");

function sendError(res, requestId, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: {
      code: error.code || (status === 400 ? "INVALID_CONFIGURATION" : "INTERNAL_ERROR"),
      message: error.message || "Request failed",
      field: error.field || null,
      request_id: requestId
    }
  });
}

function scenarioIds() {
  return engine.CONFIG.scenarios.map((item) => item.id);
}

function validationOptions(limits) {
  return {
    scenarioIds: scenarioIds(),
    adcBits: engine.CONFIG.adcBits,
    limits: limits
  };
}

function createRouter(express, apiConfig) {
  const router = express.Router();
  const options = validationOptions(apiConfig.limits);

  router.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "biosense-simulator-api",
      version: engine.CONFIG.version,
      api_version: "v1"
    });
  });

  router.get("/info", (req, res) => {
    res.json({
      simulator_version: engine.CONFIG.version,
      api_version: "v1",
      engine_version: engine.CONFIG.version,
      disclaimer: DISCLAIMER,
      oxygen_units: "sim",
      glucose_model: "PROVISIONAL",
      supported_adc_bits: engine.CONFIG.adcBits,
      supported_scenarios: scenarioIds(),
      supported_units: {
        glucose: "mg/dL",
        oxygen: "sim",
        current: "nA",
        resistance: "ohm",
        capacitance: "F",
        voltage: "V",
        drift: "nA/min"
      }
    });
  });

  router.get("/defaults", (req, res) => {
    res.json(engine.jsonSafe(engine.getDefaults()));
  });

  router.get("/scenarios", (req, res) => {
    res.json({ scenarios: engine.listScenarios() });
  });

  router.post("/simulate", (req, res, next) => {
    try {
      const parsed = validateSimulationBody(req.body, options);
      const cfg = mergeDefaults(parsed, engine);
      const session = runConfigured(engine, cfg);
      req.biosense = { simulationId: session.id };
      res.json(presentSession(session, cfg, engine, parsed.include_samples !== false));
    } catch (error) {
      next(error);
    }
  });

  router.post("/sweep", (req, res, next) => {
    try {
      const parsed = validateSweepBody(req.body, options);
      const seed = Number.isInteger(parsed.random_seed) ? parsed.random_seed : (parsed.base.random_seed || undefined);
      const firstCfg = mergeDefaults(applySweepValue(parsed.base, parsed.parameter, parsed.values[0]), engine);
      if (Number.isInteger(seed)) firstCfg.random_seed = seed;
      const count = countSamples(firstCfg);
      const rng = createSeededRng(Number.isInteger(seed) ? seed : 1);
      const unitTracks = engine.generateUnitNoiseTracks(rng, count);
      const results = parsed.values.map((value) => {
        const cfg = mergeDefaults(applySweepValue(parsed.base, parsed.parameter, value), engine);
        if (Number.isInteger(seed)) cfg.random_seed = seed;
        const session = runConfigured(engine, cfg, { unitNoiseTracks: unitTracks, randomSeed: seed });
        const row = sweepRow(session, value, engine, cfg);
        if (parsed.include_samples) row.samples = engine.jsonSafe(session.samples);
        return row;
      });
      req.biosense = { simulationId: "sweep" };
      res.json(engine.jsonSafe({
        parameter: parsed.parameter,
        random_seed: Number.isInteger(seed) ? seed : results[0] && results[0].random_seed || null,
        results: results
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/compare", (req, res, next) => {
    try {
      const parsed = validateCompareBody(req.body, options);
      const first = mergeDefaults(parsed.runs[0].configuration, engine);
      const seed = Number.isInteger(parsed.random_seed) ? parsed.random_seed : first.random_seed;
      const count = countSamples(first);
      const rng = createSeededRng(Number.isInteger(seed) ? seed : 1);
      const unitTracks = engine.generateUnitNoiseTracks(rng, count);
      const runs = parsed.runs.map((run) => {
        const cfg = mergeDefaults(run.configuration, engine);
        if (Number.isInteger(seed)) cfg.random_seed = seed;
        const session = runConfigured(engine, cfg, { unitNoiseTracks: unitTracks, randomSeed: seed });
        const payload = {
          name: run.name,
          metrics: session.metrics,
          signal_quality: session.quality,
          transient_analysis: session.transientAnalysis,
          tracking_analysis: session.trackingAnalysis,
          summary: presentSession(session, cfg, engine, false).summary
        };
        if (parsed.include_samples) payload.samples = engine.jsonSafe(session.samples);
        return engine.jsonSafe(payload);
      });
      req.biosense = { simulationId: "compare" };
      res.json({ random_seed: Number.isInteger(seed) ? seed : null, runs: runs });
    } catch (error) {
      next(error);
    }
  });

  return { router, sendError };
}

module.exports = { createRouter, sendError: null };
