"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { createApp } = require("../src/api/server");

const API_KEY = "test-key-biosense";

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

async function rawMcp(base, options) {
  const opts = options || {};
  const res = await fetch(base + "/mcp", {
    method: opts.method || "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "1.0.0" }
      }
    })
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function connectClient(base, token) {
  const options = token
    ? { authProvider: { token: async () => token } }
    : {};
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), options);
  const client = new Client({ name: "biosense-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return {
    client: client,
    close: async () => {
      await client.close();
      await transport.close();
    }
  };
}

test("MCP Streamable HTTP and REST isolation", async (t) => {
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

  await t.test("REST public surfaces still work", async () => {
    const health = await fetch(http.url + "/api/v1/health");
    const openapi = await fetch(http.url + "/openapi.json");
    const ui = await fetch(http.url + "/");
    const js = await fetch(http.url + "/app.js");
    const css = await fetch(http.url + "/styles.css");
    assert.equal(health.status, 200);
    assert.equal(openapi.status, 200);
    assert.equal(ui.status, 200);
    assert.equal(js.status, 200);
    assert.equal(css.status, 200);
  });

  await t.test("REST simulate still requires the existing bearer token", async () => {
    const denied = await fetch(http.url + "/api/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "meal", duration_s: 1, sample_interval_s: 0.1 })
    });
    const allowed = await fetch(http.url + "/api/v1/simulate", {
      method: "POST",
      headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "meal", duration_s: 1, sample_interval_s: 0.1, include_samples: false })
    });
    assert.equal(denied.status, 401);
    assert.equal(allowed.status, 200);
    const json = await allowed.json();
    assert.equal(json.status, "completed");
  });

  await t.test("MCP rejects missing and invalid bearer tokens", async () => {
    const missing = await rawMcp(http.url);
    const wrong = await rawMcp(http.url, {
      headers: { Authorization: "Bearer not-the-key" }
    });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.match(missing.headers.get("www-authenticate") || "", /Bearer/i);
    assert.ok(!missing.text.includes(API_KEY));
    assert.ok(!wrong.text.includes(API_KEY));
  });

  await t.test("official client initialize, tools/list, and tools/call", async () => {
    const session = await connectClient(http.url, API_KEY);
    t.after(() => session.close());

    const listed = await session.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["compare", "defaults", "info", "scenarios", "simulate", "sweep"]);
    assert.ok(!names.includes("health"));

    const info = await session.client.callTool({ name: "info", arguments: {} });
    assert.equal(info.isError, undefined);
    assert.equal(info.structuredContent.api_version, "v1");
    assert.ok(info.structuredContent.supported_scenarios.includes("meal"));

    const defaults = await session.client.callTool({ name: "defaults", arguments: {} });
    assert.ok(defaults.structuredContent.glucose_tia || defaults.structuredContent.adc);

    const scenarios = await session.client.callTool({ name: "scenarios", arguments: {} });
    assert.ok(Array.isArray(scenarios.structuredContent.scenarios));
    assert.ok(scenarios.structuredContent.scenarios.some((item) => item.id === "meal"));

    const simulated = await session.client.callTool({
      name: "simulate",
      arguments: {
        scenario: "meal",
        duration_s: 2,
        sample_interval_s: 0.1,
        random_seed: 12345,
        include_samples: false
      }
    });
    assert.equal(simulated.structuredContent.status, "completed");
    assert.ok(String(simulated.structuredContent.simulation_id).startsWith("BS-"));
    assert.equal(simulated.structuredContent.samples, undefined);
    assert.match(simulated.content[0].text, /SIMULATION ONLY/);

    const swept = await session.client.callTool({
      name: "sweep",
      arguments: {
        parameter: "glucose_tia.cf_f",
        values: [4.7e-7, 5.6e-7],
        include_samples: false,
        base_configuration: {
          scenario: "meal",
          duration_s: 2,
          sample_interval_s: 0.1,
          random_seed: 12345
        }
      }
    });
    assert.equal(swept.structuredContent.parameter, "glucose_tia.cf_f");
    assert.equal(swept.structuredContent.results.length, 2);

    const compared = await session.client.callTool({
      name: "compare",
      arguments: {
        random_seed: 12345,
        runs: [
          {
            name: "470nF",
            configuration: {
              scenario: "meal",
              duration_s: 2,
              sample_interval_s: 0.1,
              glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 4.7e-7 }
            }
          },
          {
            name: "560nF",
            configuration: {
              scenario: "meal",
              duration_s: 2,
              sample_interval_s: 0.1,
              glucose_tia: { vref_v: 1.65, rf_ohm: 1e6, cf_f: 5.6e-7 }
            }
          }
        ]
      }
    });
    assert.equal(compared.structuredContent.runs.length, 2);
    assert.ok(!("winner" in compared.structuredContent));

    const invalid = await session.client.callTool({
      name: "simulate",
      arguments: {
        scenario: "meal",
        duration_s: 2,
        sample_interval_s: 0.1,
        adc: { bits: 9, vref_v: 3.3, vcc_v: 3.3 }
      }
    });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.field, "adc.bits");
  });
});

test("MCP CORS allows ChatGPT origin without opening REST", async (t) => {
  const app = createApp({
    config: {
      nodeEnv: "production",
      production: true,
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

  const chatgpt = { Origin: "https://chatgpt.com" };

  await t.test("preflight and unauthenticated POST /mcp from chatgpt.com are not CORS_FORBIDDEN", async () => {
    const preflight = await fetch(http.url + "/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://chatgpt.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,mcp-protocol-version"
      }
    });
    const denied = await rawMcp(http.url, { headers: chatgpt });
    const allowed = await rawMcp(http.url, {
      headers: Object.assign({ Authorization: "Bearer " + API_KEY }, chatgpt)
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://chatgpt.com");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("access-control-allow-origin"), "https://chatgpt.com");
    assert.match(denied.headers.get("www-authenticate") || "", /Bearer/i);
    assert.ok(!denied.text.includes("CORS_FORBIDDEN"));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://chatgpt.com");
  });

  await t.test("production REST still rejects chatgpt.com when allowedOrigins is empty", async () => {
    const res = await fetch(http.url + "/api/v1/simulate", {
      method: "POST",
      headers: {
        Origin: "https://chatgpt.com",
        Authorization: "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ scenario: "meal", duration_s: 1, sample_interval_s: 0.1 })
    });
    const json = await res.json();
    assert.equal(res.status, 403);
    assert.equal(json.error.code, "CORS_FORBIDDEN");
  });
});
