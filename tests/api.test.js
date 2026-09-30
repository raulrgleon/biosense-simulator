"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/api/server");
const engine = require("../src/engine");
const { jsonContainsNonFinite } = require("../app.js");

const API_KEY = "test-key-biosense";
const AUTH = { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: "http://127.0.0.1:" + port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

async function request(base, path, options) {
  const opts = options || {};
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers: opts.headers || {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_err) { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

function mealBody(overrides) {
  return Object.assign({
    scenario: "meal",
    duration_s: 200,
    sample_interval_s: 0.1,
    random_seed: 12345,
    glucose: {
      initial_mgdl: 100,
      sensitivity_na_per_mgdl: 1,
      baseline_na: 0,
      noise_rms_na: 10,
      drift_na_per_min: 0
    },
    oxygen: {
      initial_sim: 50,
      sensitivity_na_per_sim: 1,
      baseline_na: 0,
      noise_rms_na: 0,
      drift_na_per_min: 0
    },
    temperature: {
      initial_c: 37,
      coefficient_percent_per_c: 0
    },
    glucose_tia: {
      vref_v: 1.65,
      rf_ohm: 1000000,
      cf_f: 4.7e-7
    },
    oxygen_tia: {
      vref_v: 1.65,
      rf_ohm: 1000000,
      cf_f: 1e-7
    },
    adc: {
      bits: 12,
      vref_v: 3.3,
      vcc_v: 3.3
    },
    oxygen_glucose_influence: {
      enabled: false,
      coefficient: 0
    }
  }, overrides || {});
}

test("API contract and shared engine", async (t) => {
  const app = createApp({
    config: {
      nodeEnv: "test",
      production: false,
      port: 0,
      apiKey: API_KEY,
      allowedOrigins: [],
      rateLimitPerMinute: 600,
      limits: { maxDurationS: 3600, maxSamples: 100000, maxSweepPoints: 100, maxCompareRuns: 50 },
      bodyLimit: "256kb"
    }
  });
  const http = await listen(app);
  t.after(() => http.close());

  await t.test("production without API key serves UI and rejects simulation with 503", async () => {
    const unsafe = createApp({
      config: {
        nodeEnv: "production",
        production: true,
        port: 0,
        apiKey: "",
        allowedOrigins: ["https://tuhoy.com"],
        rateLimitPerMinute: 60,
        limits: { maxDurationS: 3600, maxSamples: 100000, maxSweepPoints: 100, maxCompareRuns: 50 },
        bodyLimit: "256kb"
      }
    });
    const http = await listen(unsafe);
    t.after(() => http.close());
    const health = await request(http.url, "/api/v1/health");
    const ui = await request(http.url, "/");
    const sim = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { scenario: "meal", duration_s: 1, sample_interval_s: 0.1 }
    });
    assert.equal(health.status, 200);
    assert.equal(ui.status, 200);
    assert.equal(sim.status, 503);
    assert.equal(sim.json.error.code, "API_KEY_NOT_CONFIGURED");
  });

  await t.test("GET /health returns 200 JSON", async () => {
    const res = await request(http.url, "/api/v1/health");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.json.status, "ok");
    assert.equal(res.json.service, "biosense-simulator-api");
    assert.equal(res.json.api_version, "v1");
    assert.ok(res.headers.get("x-request-id"));
  });

  await t.test("unauthenticated /simulate fails", async () => {
    const res = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: mealBody()
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "UNAUTHORIZED");
    assert.ok(!JSON.stringify(res.json).includes(API_KEY));
  });

  await t.test("authenticated /simulate succeeds", async () => {
    const res = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody()
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.json.status, "completed");
    assert.ok(res.json.simulation_id.startsWith("BS-"));
    assert.equal(res.json.metadata.random_seed, 12345);
    assert.equal(res.json.metadata.sample_count, 2001);
    assert.equal(res.json.configuration.glucose.drift_na_per_min, 0);
    assert.ok(!JSON.stringify(res.json).includes(API_KEY));
    assert.equal(jsonContainsNonFinite(res.text), false);
  });

  await t.test("470 nF and 560 nF convert to the validated RC/fc", async () => {
    const a = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ include_samples: false, glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 4.7e-7 } })
    });
    assert.equal(a.status, 200);
    assert.ok(Math.abs(a.json.configuration.glucose_tia.rc_s - 0.47) < 1e-12);
    assert.ok(Math.abs(a.json.configuration.glucose_tia.fc_hz - 0.3386) < 5e-4);

    const b = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ include_samples: false, glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 5.6e-7 } })
    });
    assert.equal(b.status, 200);
    assert.ok(Math.abs(b.json.configuration.glucose_tia.rc_s - 0.56) < 1e-12);
    assert.ok(Math.abs(b.json.configuration.glucose_tia.fc_hz - 0.2842) < 5e-4);
  });

  await t.test("same seed is identical; different seed changes noise", async () => {
    const body = mealBody({ include_samples: true });
    const a = await request(http.url, "/api/v1/simulate", { method: "POST", headers: AUTH, body: body });
    const b = await request(http.url, "/api/v1/simulate", { method: "POST", headers: AUTH, body: body });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.json.samples, b.json.samples);
    assert.deepEqual(a.json.metrics, b.json.metrics);

    const c = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ random_seed: 99999, include_samples: true })
    });
    assert.equal(c.status, 200);
    const firstNoiseA = a.json.samples[1].sensor_current_na;
    const firstNoiseC = c.json.samples[1].sensor_current_na;
    assert.notEqual(firstNoiseA, firstNoiseC);
  });

  await t.test("sweep reuses the same noise realization", async () => {
    const res = await request(http.url, "/api/v1/sweep", {
      method: "POST",
      headers: AUTH,
      body: {
        parameter: "glucose_tia.cf_f",
        values: [4.7e-7, 5.6e-7],
        include_samples: true,
        random_seed: 12345,
        base_configuration: mealBody()
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.parameter, "glucose_tia.cf_f");
    assert.equal(res.json.results.length, 2);
    const first = res.json.results[0].samples[3].actual_glucose_mgdl;
    const second = res.json.results[1].samples[3].actual_glucose_mgdl;
    assert.equal(first, second);
    assert.ok(Math.abs(res.json.results[0].rc_s - 0.47) < 1e-12);
    assert.ok(Math.abs(res.json.results[1].rc_s - 0.56) < 1e-12);
    const engineA = engine.runOfflineSimulation({
      scenario: "meal",
      durationS: 200,
      dt: 0.1,
      randomSeed: 12345,
      params: {
        scenario: "meal",
        sensitivity: 1,
        baseline: 0,
        drift: 0,
        noiseRms: 10,
        tempC: 37,
        tempCoeff: 0,
        vref: 1.65,
        rf: 1e6,
        cf: 4.7e-7,
        vcc: 3.3,
        adcBits: 12,
        adcVref: 3.3,
        oxygenLevel: 50,
        oxygenSensitivity: 1,
        oxygenBaseline: 0,
        oxygenDrift: 0,
        oxygenNoiseRms: 0,
        oxygenVref: 1.65,
        oxygenRf: 1e6,
        oxygenCf: 1e-7,
        oxygenInfluenceEnabled: false,
        oxygenInfluenceCoeff: 0,
        initialGlucose: 100
      },
      glucoseDriftNaPerMin: 0,
      oxygenDriftNaPerMin: 0
    });
    assert.equal(res.json.results[0].mae_mgdl, engine.jsonSafe(engineA.metrics.glucose.mae_mgdl));
  });

  await t.test("invalid CF, RF, and scenario are rejected", async () => {
    const cf = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 0 } })
    });
    assert.equal(cf.status, 400);
    assert.equal(cf.json.error.field, "glucose_tia.cf_f");

    const rf = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ glucose_tia: { vref_v: 1.65, rf_ohm: -1, cf_f: 4.7e-7 } })
    });
    assert.equal(rf.status, 400);
    assert.equal(rf.json.error.field, "glucose_tia.rf_ohm");

    const sc = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ scenario: "clinical-meal" })
    });
    assert.equal(sc.status, 400);
    assert.equal(sc.json.error.code, "INVALID_SCENARIO");
  });

  await t.test("null transients stay null; zeros stay zero; meal step_count is 0", async () => {
    const res = await request(http.url, "/api/v1/simulate", {
      method: "POST",
      headers: AUTH,
      body: mealBody({ include_samples: false })
    });
    assert.equal(res.status, 200);
    const summary = res.json.transient_analysis.summary;
    assert.equal(summary.step_count, 0);
    assert.equal(summary.mean_settling_time_5mg_s, null);
    assert.equal(res.json.configuration.glucose.drift_na_per_min, 0);
    assert.equal(res.json.configuration.oxygen.drift_na_per_min, 0);
    assert.equal(jsonContainsNonFinite(res.text), false);
  });

  await t.test("source and env files are not served as static assets", async () => {
    const src = await request(http.url, "/src/api/server.js");
    const env = await request(http.url, "/.env.example");
    const pkg = await request(http.url, "/package.json");
    assert.equal(src.status, 404);
    assert.equal(env.status, 404);
    assert.equal(pkg.status, 404);
  });

  await t.test("OpenAPI document is valid enough to consume", async () => {
    const res = await request(http.url, "/openapi.json");
    assert.equal(res.status, 200);
    assert.equal(res.json.openapi.startsWith("3."), true);
    assert.ok(res.json.paths["/api/v1/simulate"]);
    assert.equal(res.json.paths["/api/v1/health"].get.operationId, "healthCheck");
    assert.equal(res.json.paths["/api/v1/simulate"].post.operationId, "runSimulation");
    assert.equal(res.json.paths["/api/v1/sweep"].post.operationId, "runSweep");
    assert.equal(res.json.paths["/api/v1/compare"].post.operationId, "compareSimulations");
  });

  await t.test("compare returns two runs and no winner", async () => {
    const res = await request(http.url, "/api/v1/compare", {
      method: "POST",
      headers: AUTH,
      body: {
        random_seed: 12345,
        runs: [
          { name: "470nF", configuration: mealBody({ glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 4.7e-7 } }) },
          { name: "560nF", configuration: mealBody({ glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 5.6e-7 } }) }
        ]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.runs.length, 2);
    assert.equal(res.json.runs[0].name, "470nF");
    assert.ok(!("winner" in res.json));
  });

  await t.test("API and shared engine match for the meal reference", async () => {
    const body = mealBody({ include_samples: true, glucose: Object.assign(mealBody().glucose, { noise_rms_na: 0 }) });
    const api = await request(http.url, "/api/v1/simulate", { method: "POST", headers: AUTH, body: body });
    const session = engine.runOfflineSimulation({
      scenario: "meal",
      durationS: 200,
      dt: 0.1,
      randomSeed: 12345,
      params: {
        scenario: "meal",
        sensitivity: 1,
        baseline: 0,
        drift: 0,
        noiseRms: 0,
        tempC: 37,
        tempCoeff: 0,
        vref: 1.65,
        rf: 1e6,
        cf: 4.7e-7,
        vcc: 3.3,
        adcBits: 12,
        adcVref: 3.3,
        oxygenLevel: 50,
        oxygenSensitivity: 1,
        oxygenBaseline: 0,
        oxygenDrift: 0,
        oxygenNoiseRms: 0,
        oxygenVref: 1.65,
        oxygenRf: 1e6,
        oxygenCf: 1e-7,
        oxygenInfluenceEnabled: false,
        oxygenInfluenceCoeff: 0,
        initialGlucose: 100
      }
    });
    assert.equal(api.status, 200);
    assert.equal(api.json.metrics.glucose.mae_mgdl, engine.jsonSafe(session.metrics.glucose.mae_mgdl));
    assert.equal(api.json.metrics.glucose.rmse_mgdl, engine.jsonSafe(session.metrics.glucose.rmse_mgdl));
    assert.equal(api.json.samples.length, session.samples.length);
    assert.equal(api.json.samples[20].estimated_glucose_mgdl, engine.jsonSafe(session.samples[20].estimated_glucose_mgdl));
  });
});
