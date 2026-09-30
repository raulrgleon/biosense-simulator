"use strict";

const SWEEP_PATHS = Object.freeze([
  "duration_s",
  "sample_interval_s",
  "glucose.initial_mgdl",
  "glucose.sensitivity_na_per_mgdl",
  "glucose.baseline_na",
  "glucose.noise_rms_na",
  "glucose.drift_na_per_min",
  "oxygen.initial_sim",
  "oxygen.sensitivity_na_per_sim",
  "oxygen.baseline_na",
  "oxygen.noise_rms_na",
  "oxygen.drift_na_per_min",
  "temperature.initial_c",
  "temperature.coefficient_percent_per_c",
  "glucose_tia.vref_v",
  "glucose_tia.rf_ohm",
  "glucose_tia.cf_f",
  "oxygen_tia.vref_v",
  "oxygen_tia.rf_ohm",
  "oxygen_tia.cf_f",
  "adc.bits",
  "adc.vref_v",
  "adc.vcc_v",
  "oxygen_glucose_influence.coefficient"
]);

function invalid(field, message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code || "INVALID_CONFIGURATION";
  error.field = field;
  return error;
}

function assertFinite(value, field, message) {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(field, message || field + " must be a finite number");
  }
}

function optionalNumber(obj, key) {
  if (!obj || obj[key] == null) return undefined;
  return obj[key];
}

function getPath(target, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), target);
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateLimits(cfg) {
  const duration = cfg.duration_s;
  const dt = cfg.sample_interval_s;
  if (!(duration > 0)) throw invalid("duration_s", "duration_s must be greater than zero");
  if (!(dt > 0)) throw invalid("sample_interval_s", "sample_interval_s must be greater than zero");
  if (duration > cfg.limits.maxDurationS) {
    throw invalid("duration_s", "duration_s exceeds maximum of " + cfg.limits.maxDurationS + " s", "LIMIT_EXCEEDED");
  }
  const samples = Math.round(duration / dt) + 1;
  if (samples > cfg.limits.maxSamples) {
    throw invalid("sample_interval_s", "sample_count exceeds maximum of " + cfg.limits.maxSamples, "LIMIT_EXCEEDED");
  }
}

function validateTia(tia, prefix) {
  if (!tia) return;
  assertFinite(tia.vref_v, prefix + ".vref_v");
  assertFinite(tia.rf_ohm, prefix + ".rf_ohm");
  assertFinite(tia.cf_f, prefix + ".cf_f");
  if (tia.rf_ohm != null && !(tia.rf_ohm > 0)) {
    throw invalid(prefix + ".rf_ohm", prefix + ".rf_ohm must be greater than zero");
  }
  if (tia.cf_f != null && !(tia.cf_f > 0)) {
    throw invalid(prefix + ".cf_f", prefix + ".cf_f must be greater than zero");
  }
  if (tia.vref_v != null && tia.vref_v < 0) {
    throw invalid(prefix + ".vref_v", prefix + ".vref_v must be greater than or equal to zero");
  }
}

function validateAdc(adc, allowedBits) {
  if (!adc) return;
  assertFinite(adc.bits, "adc.bits");
  assertFinite(adc.vref_v, "adc.vref_v");
  assertFinite(adc.vcc_v, "adc.vcc_v");
  if (adc.bits != null && allowedBits.indexOf(adc.bits) < 0) {
    throw invalid("adc.bits", "adc.bits must be one of " + allowedBits.join(", "));
  }
  if (adc.vref_v != null && !(adc.vref_v > 0)) {
    throw invalid("adc.vref_v", "adc.vref_v must be greater than zero");
  }
  if (adc.vcc_v != null && !(adc.vcc_v > 0)) {
    throw invalid("adc.vcc_v", "adc.vcc_v must be greater than zero");
  }
}

function validateSimulationBody(body, options) {
  const opts = options || {};
  const allowed = opts.scenarioIds || [];
  const limits = opts.limits;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("body", "JSON object required");
  }
  const scenario = body.scenario == null ? "meal" : body.scenario;
  if (typeof scenario !== "string" || allowed.indexOf(scenario) < 0) {
    throw invalid("scenario", "unknown scenario", "INVALID_SCENARIO");
  }
  assertFinite(body.duration_s, "duration_s");
  assertFinite(body.sample_interval_s, "sample_interval_s");
  if (body.random_seed != null) {
    if (!Number.isInteger(body.random_seed) || body.random_seed < 0 || body.random_seed > 0xffffffff) {
      throw invalid("random_seed", "random_seed must be an integer between 0 and 4294967295");
    }
  }
  if (body.glucose) {
    assertFinite(body.glucose.initial_mgdl, "glucose.initial_mgdl");
    assertFinite(body.glucose.sensitivity_na_per_mgdl, "glucose.sensitivity_na_per_mgdl");
    assertFinite(body.glucose.baseline_na, "glucose.baseline_na");
    assertFinite(body.glucose.noise_rms_na, "glucose.noise_rms_na");
    assertFinite(body.glucose.drift_na_per_min, "glucose.drift_na_per_min");
    if (body.glucose.noise_rms_na != null && body.glucose.noise_rms_na < 0) {
      throw invalid("glucose.noise_rms_na", "glucose.noise_rms_na must be greater than or equal to zero");
    }
  }
  if (body.oxygen) {
    assertFinite(body.oxygen.initial_sim, "oxygen.initial_sim");
    assertFinite(body.oxygen.sensitivity_na_per_sim, "oxygen.sensitivity_na_per_sim");
    assertFinite(body.oxygen.baseline_na, "oxygen.baseline_na");
    assertFinite(body.oxygen.noise_rms_na, "oxygen.noise_rms_na");
    assertFinite(body.oxygen.drift_na_per_min, "oxygen.drift_na_per_min");
  }
  if (body.temperature) {
    assertFinite(body.temperature.initial_c, "temperature.initial_c");
    assertFinite(body.temperature.coefficient_percent_per_c, "temperature.coefficient_percent_per_c");
  }
  validateTia(body.glucose_tia, "glucose_tia");
  validateTia(body.oxygen_tia, "oxygen_tia");
  validateAdc(body.adc, opts.adcBits || []);
  if (body.oxygen_glucose_influence) {
    assertFinite(body.oxygen_glucose_influence.coefficient, "oxygen_glucose_influence.coefficient");
  }
  const duration = body.duration_s == null ? 200 : body.duration_s;
  const dt = body.sample_interval_s == null ? 0.1 : body.sample_interval_s;
  validateLimits({ duration_s: duration, sample_interval_s: dt, limits: limits });
  return {
    scenario: scenario,
    duration_s: duration,
    sample_interval_s: dt,
    random_seed: body.random_seed,
    include_samples: body.include_samples !== false,
    glucose: body.glucose || {},
    oxygen: body.oxygen || {},
    temperature: body.temperature || {},
    glucose_tia: body.glucose_tia || {},
    oxygen_tia: body.oxygen_tia || {},
    adc: body.adc || {},
    oxygen_glucose_influence: body.oxygen_glucose_influence || {}
  };
}

function validateSweepBody(body, options) {
  if (!body || typeof body !== "object") throw invalid("body", "JSON object required");
  if (SWEEP_PATHS.indexOf(body.parameter) < 0) {
    throw invalid("parameter", "parameter is not in the allowlist", "INVALID_PARAMETER");
  }
  if (!Array.isArray(body.values) || !body.values.length) {
    throw invalid("values", "values must be a non-empty array");
  }
  if (body.values.length > options.limits.maxSweepPoints) {
    throw invalid("values", "values exceed maximum of " + options.limits.maxSweepPoints, "LIMIT_EXCEEDED");
  }
  body.values.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalid("values[" + index + "]", "sweep values must be finite numbers");
    }
  });
  const base = validateSimulationBody(body.base_configuration || {}, options);
  return {
    parameter: body.parameter,
    values: body.values,
    include_samples: body.include_samples === true,
    base: base,
    random_seed: body.random_seed != null ? body.random_seed : base.random_seed
  };
}

function validateCompareBody(body, options) {
  if (!body || typeof body !== "object") throw invalid("body", "JSON object required");
  if (!Array.isArray(body.runs) || body.runs.length < 2) {
    throw invalid("runs", "runs must contain at least two configurations");
  }
  if (body.runs.length > options.limits.maxCompareRuns) {
    throw invalid("runs", "runs exceed maximum of " + options.limits.maxCompareRuns, "LIMIT_EXCEEDED");
  }
  return {
    random_seed: body.random_seed,
    include_samples: body.include_samples === true,
    runs: body.runs.map((run, index) => {
      if (!run || typeof run !== "object") throw invalid("runs[" + index + "]", "run must be an object");
      return {
        name: run.name == null ? "run_" + (index + 1) : String(run.name),
        configuration: validateSimulationBody(run.configuration || {}, options)
      };
    })
  };
}

module.exports = {
  SWEEP_PATHS,
  invalid,
  assertFinite,
  optionalNumber,
  getPath,
  setPath,
  cloneJson,
  validateSimulationBody,
  validateSweepBody,
  validateCompareBody
};
