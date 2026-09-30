"use strict";

const { z } = require("zod");
const { McpServer, requireScopes } = require("@modelcontextprotocol/server");
const engine = require("../engine");
const { SWEEP_PATHS } = require("../engine/validation");
const { DISCLAIMER } = require("../api/mapper");
const { SCOPE_READ, SCOPE_SIMULATE, toolSecurityMeta } = require("./oauth");

const SCENARIO_IDS = engine.CONFIG.scenarios.map((item) => item.id);
const ADC_BITS = engine.CONFIG.adcBits;

const glucoseSchema = z.object({
  initial_mgdl: z.number().finite().optional().describe("Initial glucose in mg/dL. Used by custom/stable scenarios when the scenario does not drive the waveform."),
  sensitivity_na_per_mgdl: z.number().finite().optional().describe("Provisional electrode sensitivity in nA per mg/dL."),
  baseline_na: z.number().finite().optional().describe("Baseline sensor current in nA."),
  noise_rms_na: z.number().finite().min(0).optional().describe("Gaussian current noise RMS in nA. Applied only while the simulation runs."),
  drift_na_per_min: z.number().finite().optional().describe("Physical drift rate in nA/min. At time t seconds the engine adds rate * t / 60 nA to the sensor. Not nA/s.")
}).strict().optional();

const oxygenSchema = z.object({
  initial_sim: z.number().finite().optional().describe("Oxygen level in simulation units (sim). Not mmHg and not saturation."),
  sensitivity_na_per_sim: z.number().finite().optional().describe("Provisional oxygen sensitivity in nA per sim."),
  baseline_na: z.number().finite().optional().describe("Oxygen baseline current in nA."),
  noise_rms_na: z.number().finite().min(0).optional().describe("Oxygen current noise RMS in nA."),
  drift_na_per_min: z.number().finite().optional().describe("Oxygen drift rate in nA/min.")
}).strict().optional();

const temperatureSchema = z.object({
  initial_c: z.number().finite().optional().describe("Temperature in °C."),
  coefficient_percent_per_c: z.number().finite().optional().describe("PROVISIONAL temperature coefficient in %/°C. 0 disables the effect.")
}).strict().optional();

const tiaSchema = z.object({
  vref_v: z.number().finite().min(0).optional().describe("TIA reference voltage in volts."),
  rf_ohm: z.number().finite().gt(0).optional().describe("Feedback resistance in ohms. Must be > 0."),
  cf_f: z.number().finite().gt(0).optional().describe("Feedback capacitance in farads. Must be > 0. Example 4.7e-7 for 470 nF.")
}).strict().optional();

const adcSchema = z.object({
  bits: z.number().int().optional().describe("ADC resolution in bits. Supported: " + ADC_BITS.join(", ") + "."),
  vref_v: z.number().finite().gt(0).optional().describe("ADC reference voltage in volts."),
  vcc_v: z.number().finite().gt(0).optional().describe("Supply voltage in volts.")
}).strict().optional();

const influenceSchema = z.object({
  enabled: z.boolean().optional().describe("When false, oxygen does not alter the glucose channel."),
  coefficient: z.number().finite().optional().describe("PROVISIONAL oxygen→glucose influence coefficient. 0 leaves glucose unchanged.")
}).strict().optional();

const simulateFields = {
  scenario: z.enum(SCENARIO_IDS).optional().describe(
    "Waveform that drives simulated glucose. stable holds the initial value; rising/falling are ramps; meal is a non-clinical spike; rapid is electronics stress; custom follows initial_mgdl. Default meal."
  ),
  duration_s: z.number().finite().gt(0).optional().describe("Simulation duration in seconds. Default 200. Must stay within the configured maximum."),
  sample_interval_s: z.number().finite().gt(0).optional().describe("Sampling interval dt in seconds. Default 0.1 (10 Hz)."),
  random_seed: z.number().int().min(0).max(4294967295).optional().describe("Integer seed for reproducible noise. Same seed + same configuration yields identical samples."),
  include_samples: z.boolean().optional().describe("If true, include the full sample array. Default false for MCP to keep responses compact. Prefer summaries unless you need every point."),
  glucose: glucoseSchema,
  oxygen: oxygenSchema,
  temperature: temperatureSchema,
  glucose_tia: tiaSchema,
  oxygen_tia: tiaSchema,
  adc: adcSchema,
  oxygen_glucose_influence: influenceSchema
};

const simulateInput = z.object(simulateFields).strict();

function compactJson(value) {
  return JSON.stringify(value);
}

function toolError(error) {
  const payload = {
    error: {
      code: error.code || (error.status === 400 ? "INVALID_CONFIGURATION" : "INTERNAL_ERROR"),
      message: error.message || "Request failed",
      field: error.field || null
    }
  };
  return {
    isError: true,
    content: [{ type: "text", text: compactJson(payload) }],
    structuredContent: payload
  };
}

function toolOk(payload, text) {
  return {
    content: [{ type: "text", text: text }],
    structuredContent: payload
  };
}

function summarizeSimulate(payload) {
  const summary = payload.summary || {};
  const cfg = payload.configuration || {};
  return [
    DISCLAIMER,
    "simulation_id=" + payload.simulation_id,
    "scenario=" + cfg.scenario,
    "mae_mgdl=" + summary.mae_mgdl,
    "rmse_mgdl=" + summary.rmse_mgdl,
    "max_abs_error_mgdl=" + summary.max_abs_error_mgdl,
    "best_fit_lag_s=" + summary.best_fit_lag_s,
    "signal_quality=" + summary.signal_quality,
    "tia_saturation_count=" + summary.tia_saturation_count,
    "adc_clipping_count=" + summary.adc_clipping_count,
    "sample_count=" + (payload.metadata && payload.metadata.sample_count),
    "samples_included=" + Array.isArray(payload.samples)
  ].join("\n");
}

function summarizeSweep(payload) {
  const lines = [
    DISCLAIMER,
    "parameter=" + payload.parameter,
    "random_seed=" + payload.random_seed,
    "points=" + (payload.results || []).length
  ];
  (payload.results || []).forEach((row) => {
    lines.push(
      "value=" + row.value +
      " mae_mgdl=" + row.mae_mgdl +
      " rmse_mgdl=" + row.rmse_mgdl +
      " fc_hz=" + row.fc_hz +
      " rc_s=" + row.rc_s +
      " quality=" + row.signal_quality
    );
  });
  return lines.join("\n");
}

function summarizeCompare(payload) {
  const lines = [DISCLAIMER, "random_seed=" + payload.random_seed, "No winner is declared."];
  (payload.runs || []).forEach((run) => {
    const summary = run.summary || {};
    lines.push(
      "run=" + run.name +
      " mae_mgdl=" + summary.mae_mgdl +
      " rmse_mgdl=" + summary.rmse_mgdl +
      " quality=" + summary.signal_quality
    );
  });
  return lines.join("\n");
}

function createBiosenseMcpServer(service) {
  const server = new McpServer({
    name: "biosense-simulator",
    version: engine.CONFIG.version,
    title: "BioSense Simulator",
    description: [
      DISCLAIMER,
      "Remote MCP access to the same BioSense / TuHoy simulation engine as the REST API and browser UI.",
      "Glucose is a PROVISIONAL linear model in mg/dL. Oxygen uses simulation units (sim), not mmHg or saturation.",
      "Use info, scenarios, and defaults before changing electronics. Use simulate for one run, sweep to vary one allowlisted parameter, and compare to place named configurations side by side.",
      "Unavailable numbers are JSON null. Responses never contain NaN or Infinity."
    ].join(" ")
  });

  server.registerTool("info", {
    title: "Simulator info",
    description: [
      "Return simulator capabilities, supported scenarios, ADC bit depths, and scientific units.",
      "Use this first when you need to know which scenario IDs, ADC bits, or units are valid.",
      "Does not run a simulation. Glucose model is PROVISIONAL. Oxygen unit is sim."
    ].join(" "),
    scopeChallenge: requireScopes(SCOPE_READ),
    _meta: toolSecurityMeta("info")
  }, () => {
    const payload = service.info();
    return toolOk(payload, compactJson(payload));
  });

  server.registerTool("defaults", {
    title: "Simulator defaults",
    description: [
      "Return the current default electronics and sensor configuration used when a simulate/sweep/compare field is omitted.",
      "Use this to see baseline RF, CF, VREF, ADC bits, and sensor coefficients before overriding them.",
      "Does not run a simulation."
    ].join(" "),
    scopeChallenge: requireScopes(SCOPE_READ),
    _meta: toolSecurityMeta("defaults")
  }, () => {
    const payload = service.defaults();
    return toolOk(payload, compactJson(payload));
  });

  server.registerTool("scenarios", {
    title: "List scenarios",
    description: [
      "List supported glucose waveform scenarios with their IDs and descriptions.",
      "Use this when choosing the scenario argument for simulate, sweep, or compare.",
      "Scenarios are simulated signals only. meal is not a clinical meal model."
    ].join(" "),
    scopeChallenge: requireScopes(SCOPE_READ),
    _meta: toolSecurityMeta("scenarios")
  }, () => {
    const payload = service.scenarios();
    return toolOk(payload, compactJson(payload));
  });

  server.registerTool("simulate", {
    title: "Run one simulation",
    description: [
      "Run one offline BioSense simulation through the shared engine (sensor → TIA → filter → ADC → algorithm).",
      "Use this for a single configuration. Prefer include_samples=false and read summary/metrics.",
      "Set random_seed for reproducibility. Drift is drift_na_per_min. Oxygen is sim, not mmHg.",
      DISCLAIMER
    ].join(" "),
    inputSchema: simulateInput,
    scopeChallenge: requireScopes(SCOPE_SIMULATE),
    _meta: toolSecurityMeta("simulate")
  }, (args) => {
    try {
      const result = service.simulate(Object.assign({}, args, {
        include_samples: args.include_samples === true
      }));
      return toolOk(result.payload, summarizeSimulate(result.payload));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("sweep", {
    title: "Sweep one parameter",
    description: [
      "Sweep one allowlisted parameter across numeric values while reusing the same noise realization when random_seed is set.",
      "Use this to study electronics such as glucose_tia.cf_f (farads) or glucose.drift_na_per_min.",
      "parameter must be one of the allowlisted dotted paths. values is a non-empty array of finite numbers.",
      "Does not declare a winner. include_samples defaults to false."
    ].join(" "),
    scopeChallenge: requireScopes(SCOPE_SIMULATE),
    _meta: toolSecurityMeta("sweep"),
    inputSchema: z.object({
      parameter: z.enum(SWEEP_PATHS).describe("Allowlisted dotted path to vary. Example glucose_tia.cf_f."),
      values: z.array(z.number().finite()).min(1).describe("Finite numeric values for the swept parameter, in the parameter's native unit."),
      random_seed: z.number().int().min(0).max(4294967295).optional().describe("Shared seed so every sweep point uses the same noise track."),
      include_samples: z.boolean().optional().describe("If true, attach samples to every sweep row. Default false."),
      base_configuration: simulateInput.optional().describe("Base SimulateRequest. Omitted fields use simulator defaults.")
    }).strict()
  }, (args) => {
    try {
      const result = service.sweep(args);
      return toolOk(result.payload, summarizeSweep(result.payload));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("compare", {
    title: "Compare configurations",
    description: [
      "Compare two or more named configurations with a shared noise realization when random_seed is set.",
      "Use this to place electronics setups side by side (for example 470 nF vs 560 nF).",
      "runs must contain at least two objects with name and configuration. No winner is declared.",
      "include_samples defaults to false."
    ].join(" "),
    scopeChallenge: requireScopes(SCOPE_SIMULATE),
    _meta: toolSecurityMeta("compare"),
    inputSchema: z.object({
      random_seed: z.number().int().min(0).max(4294967295).optional().describe("Shared seed across compared runs."),
      include_samples: z.boolean().optional().describe("If true, attach samples to every run. Default false."),
      runs: z.array(z.object({
        name: z.string().optional().describe("Label for this run in the comparison table."),
        configuration: simulateInput.optional().describe("SimulateRequest for this run.")
      }).strict()).min(2).describe("At least two named configurations to compare.")
    }).strict()
  }, (args) => {
    try {
      const result = service.compare(args);
      return toolOk(result.payload, summarizeCompare(result.payload));
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

module.exports = { createBiosenseMcpServer };
