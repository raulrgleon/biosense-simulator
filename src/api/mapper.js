"use strict";

const { createSeededRng, generateSeed } = require("../engine/rng");
const { getPath, setPath, cloneJson } = require("../engine/validation");

const DISCLAIMER = "SIMULATION ONLY - NOT FOR MEDICAL USE";

function mergeDefaults(body, engine) {
  const defaults = engine.getDefaults();
  return {
    scenario: body.scenario || "meal",
    duration_s: body.duration_s,
    sample_interval_s: body.sample_interval_s,
    random_seed: body.random_seed,
    include_samples: body.include_samples,
    glucose: Object.assign({
      initial_mgdl: defaults.glucose_sensor.initial_glucose_mgdl,
      sensitivity_na_per_mgdl: defaults.glucose_sensor.sensitivity_na_per_mgdl,
      baseline_na: defaults.glucose_sensor.baseline_na,
      noise_rms_na: defaults.glucose_sensor.noise_rms_na,
      drift_na_per_min: 0
    }, body.glucose || {}),
    oxygen: Object.assign({
      initial_sim: defaults.oxygen_sensor.initial_oxygen_sim,
      sensitivity_na_per_sim: defaults.oxygen_sensor.sensitivity_na_per_sim,
      baseline_na: defaults.oxygen_sensor.baseline_na,
      noise_rms_na: defaults.oxygen_sensor.noise_rms_na,
      drift_na_per_min: 0
    }, body.oxygen || {}),
    temperature: Object.assign({
      initial_c: defaults.temperature.initial_c,
      coefficient_percent_per_c: defaults.temperature.coefficient_percent_per_c
    }, body.temperature || {}),
    glucose_tia: Object.assign({
      vref_v: defaults.glucose_tia.vref,
      rf_ohm: defaults.glucose_tia.rf_ohm,
      cf_f: defaults.glucose_tia.cf_f
    }, body.glucose_tia || {}),
    oxygen_tia: Object.assign({
      vref_v: defaults.oxygen_tia.vref,
      rf_ohm: defaults.oxygen_tia.rf_ohm,
      cf_f: defaults.oxygen_tia.cf_f
    }, body.oxygen_tia || {}),
    adc: Object.assign({
      bits: defaults.adc.bits,
      vref_v: defaults.adc.vref,
      vcc_v: defaults.adc.vcc
    }, body.adc || {}),
    oxygen_glucose_influence: Object.assign({
      enabled: defaults.oxygen_glucose_influence.enabled,
      coefficient: defaults.oxygen_glucose_influence.coefficient
    }, body.oxygen_glucose_influence || {})
  };
}

function toEngineParams(cfg) {
  return {
    scenario: cfg.scenario,
    sensitivity: cfg.glucose.sensitivity_na_per_mgdl,
    baseline: cfg.glucose.baseline_na,
    drift: 0,
    noiseRms: cfg.glucose.noise_rms_na,
    tempC: cfg.temperature.initial_c,
    tempCoeff: cfg.temperature.coefficient_percent_per_c,
    vref: cfg.glucose_tia.vref_v,
    rf: cfg.glucose_tia.rf_ohm,
    cf: cfg.glucose_tia.cf_f,
    vcc: cfg.adc.vcc_v,
    adcBits: cfg.adc.bits,
    adcVref: cfg.adc.vref_v,
    oxygenLevel: cfg.oxygen.initial_sim,
    oxygenSensitivity: cfg.oxygen.sensitivity_na_per_sim,
    oxygenBaseline: cfg.oxygen.baseline_na,
    oxygenDrift: 0,
    oxygenNoiseRms: cfg.oxygen.noise_rms_na,
    oxygenVref: cfg.oxygen_tia.vref_v,
    oxygenRf: cfg.oxygen_tia.rf_ohm,
    oxygenCf: cfg.oxygen_tia.cf_f,
    oxygenInfluenceEnabled: !!cfg.oxygen_glucose_influence.enabled,
    oxygenInfluenceCoeff: cfg.oxygen_glucose_influence.coefficient,
    initialGlucose: cfg.glucose.initial_mgdl,
    glucose: cfg.glucose.initial_mgdl
  };
}

function apiConfiguration(cfg, engine) {
  const gCut = engine.calculateCutoffFrequency(cfg.glucose_tia.rf_ohm, cfg.glucose_tia.cf_f);
  const oCut = engine.calculateCutoffFrequency(cfg.oxygen_tia.rf_ohm, cfg.oxygen_tia.cf_f);
  return {
    scenario: cfg.scenario,
    duration_s: cfg.duration_s,
    sample_interval_s: cfg.sample_interval_s,
    adc: {
      bits: cfg.adc.bits,
      vref_v: cfg.adc.vref_v,
      vcc_v: cfg.adc.vcc_v
    },
    glucose: {
      initial_mgdl: cfg.glucose.initial_mgdl,
      sensitivity_na_per_mgdl: cfg.glucose.sensitivity_na_per_mgdl,
      baseline_na: cfg.glucose.baseline_na,
      noise_rms_na: cfg.glucose.noise_rms_na,
      drift_na_per_min: cfg.glucose.drift_na_per_min
    },
    oxygen: {
      initial_sim: cfg.oxygen.initial_sim,
      unit: "sim",
      sensitivity_na_per_sim: cfg.oxygen.sensitivity_na_per_sim,
      baseline_na: cfg.oxygen.baseline_na,
      noise_rms_na: cfg.oxygen.noise_rms_na,
      drift_na_per_min: cfg.oxygen.drift_na_per_min,
      model: "PROVISIONAL"
    },
    temperature: {
      initial_c: cfg.temperature.initial_c,
      coefficient_percent_per_c: cfg.temperature.coefficient_percent_per_c,
      compensation: "PROVISIONAL"
    },
    glucose_tia: {
      vref_v: cfg.glucose_tia.vref_v,
      rf_ohm: cfg.glucose_tia.rf_ohm,
      cf_f: cfg.glucose_tia.cf_f,
      rc_s: gCut.rc,
      fc_hz: gCut.fc
    },
    oxygen_tia: {
      vref_v: cfg.oxygen_tia.vref_v,
      rf_ohm: cfg.oxygen_tia.rf_ohm,
      cf_f: cfg.oxygen_tia.cf_f,
      rc_s: oCut.rc,
      fc_hz: oCut.fc
    },
    oxygen_glucose_influence: {
      enabled: !!cfg.oxygen_glucose_influence.enabled,
      coefficient: cfg.oxygen_glucose_influence.coefficient,
      model: "PROVISIONAL"
    }
  };
}

function compactSummary(session) {
  const glucose = session.metrics.glucose;
  const tracking = session.trackingAnalysis || {};
  return {
    mae_mgdl: glucose.mae_mgdl,
    rmse_mgdl: glucose.rmse_mgdl,
    max_abs_error_mgdl: glucose.max_abs_error_mgdl,
    mean_signed_error_mgdl: tracking.mean_signed_error_mgdl,
    best_fit_lag_s: tracking.best_fit_lag_s,
    lag_corrected_rmse_mgdl: tracking.lag_corrected_rmse_mgdl,
    signal_quality: session.quality.status,
    tia_saturation_count: glucose.tia_saturation_count,
    adc_clipping_count: glucose.adc_clipping_count
  };
}

function presentSession(session, cfg, engine, includeSamples) {
  const configuration = apiConfiguration(cfg, engine);
  const payload = {
    simulation_id: session.id,
    status: session.status === "complete" ? "completed" : session.status,
    metadata: {
      simulator_version: engine.CONFIG.version,
      api_version: "v1",
      timestamp: session.startTime,
      duration_s: cfg.duration_s,
      sample_interval_s: cfg.sample_interval_s,
      sample_count: session.metrics.sample_count,
      random_seed: session.randomSeed,
      disclaimer: DISCLAIMER
    },
    configuration: configuration,
    signal_quality: session.quality,
    metrics: session.metrics,
    transient_analysis: session.transientAnalysis,
    tracking_analysis: session.trackingAnalysis,
    summary: compactSummary(session)
  };
  if (includeSamples) payload.samples = session.samples;
  return engine.jsonSafe(payload);
}

function runConfigured(engine, cfg, extras) {
  const extra = extras || {};
  const seed = Number.isFinite(cfg.random_seed) ? cfg.random_seed : (Number.isFinite(extra.randomSeed) ? extra.randomSeed : generateSeed());
  return engine.runOfflineSimulation({
    scenario: cfg.scenario,
    durationS: cfg.duration_s,
    dt: cfg.sample_interval_s,
    params: toEngineParams(cfg),
    randomSeed: seed,
    rng: extra.rng,
    noiseTracks: extra.noiseTracks,
    unitNoiseTracks: extra.unitNoiseTracks,
    glucoseDriftNaPerMin: cfg.glucose.drift_na_per_min,
    oxygenDriftNaPerMin: cfg.oxygen.drift_na_per_min,
    status: "complete"
  });
}

function sweepRow(session, value, engine, cfg) {
  const cut = engine.calculateCutoffFrequency(cfg.glucose_tia.rf_ohm, cfg.glucose_tia.cf_f);
  return engine.jsonSafe({
    value: value,
    fc_hz: cut.fc,
    rc_s: cut.rc,
    mae_mgdl: session.metrics.glucose.mae_mgdl,
    rmse_mgdl: session.metrics.glucose.rmse_mgdl,
    max_abs_error_mgdl: session.metrics.glucose.max_abs_error_mgdl,
    mean_signed_error_mgdl: session.trackingAnalysis.mean_signed_error_mgdl,
    best_fit_lag_s: session.trackingAnalysis.best_fit_lag_s,
    lag_corrected_rmse_mgdl: session.trackingAnalysis.lag_corrected_rmse_mgdl,
    tia_saturation_count: session.metrics.glucose.tia_saturation_count,
    adc_clipping_count: session.metrics.glucose.adc_clipping_count,
    signal_quality: session.quality.status,
    summary: compactSummary(session)
  });
}

function applySweepValue(base, parameter, value) {
  const next = cloneJson(base);
  setPath(next, parameter, value);
  return next;
}

function countSamples(cfg) {
  return Math.round(cfg.duration_s / cfg.sample_interval_s) + 1;
}

module.exports = {
  DISCLAIMER,
  mergeDefaults,
  toEngineParams,
  apiConfiguration,
  compactSummary,
  presentSession,
  runConfigured,
  sweepRow,
  applySweepValue,
  countSamples,
  createSeededRng,
  generateSeed,
  getPath
};
