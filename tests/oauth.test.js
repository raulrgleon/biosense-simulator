"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPair, exportJWK, SignJWT } = require("jose");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { createApp } = require("../src/api/server");
const {
  CANONICAL_RESOURCE,
  RESOURCE_METADATA_URL,
  SCOPE_READ,
  SCOPE_SIMULATE
} = require("../src/mcp/oauth");

const API_KEY = "test-key-biosense";
const ISSUER = "https://auth.test.biosense/";
const WRONG_ISSUER = "https://other-issuer.test/";
const AUDIENCE = CANONICAL_RESOURCE;

function baseConfig(overrides) {
  return Object.assign({
    nodeEnv: "test",
    production: false,
    port: 0,
    apiKey: API_KEY,
    allowedOrigins: [],
    rateLimitPerMinute: 600,
    limits: { maxDurationS: 3600, maxSamples: 100000, maxSweepPoints: 100, maxCompareRuns: 50 },
    bodyLimit: "256kb"
  }, overrides || {});
}

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
        clientInfo: { name: "oauth-test", version: "1.0.0" }
      }
    })
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function connectClient(base, token) {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    authProvider: { token: async () => token }
  });
  const client = new Client({ name: "biosense-oauth-test", version: "1.0.0" });
  await client.connect(transport);
  return {
    client: client,
    close: async () => {
      await client.close();
      await transport.close();
    }
  };
}

async function createSigner() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return {
    privateKey: privateKey,
    jwks: { keys: [jwk] }
  };
}

async function signToken(privateKey, claims) {
  const extra = claims || {};
  const payload = {};
  if (typeof extra.scope === "string" && extra.scope) payload.scope = extra.scope;
  if (Array.isArray(extra.permissions)) payload.permissions = extra.permissions;
  if (typeof extra.resource === "string") payload.resource = extra.resource;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(extra.iss || ISSUER)
    .setAudience(extra.aud === undefined ? AUDIENCE : extra.aud)
    .setSubject(extra.sub || "user-test")
    .setIssuedAt()
    .setExpirationTime(extra.exp || "5m")
    .sign(privateKey);
}

function oauthConfig(jwks, extra) {
  return Object.assign({
    enabled: true,
    domain: "auth.test.biosense",
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: "",
    localJwks: jwks,
    resource: CANONICAL_RESOURCE,
    resourceMetadataUrl: RESOURCE_METADATA_URL,
    resourceDocumentation: "https://tuhoy.com/api/docs",
    scopesSupported: [SCOPE_READ, SCOPE_SIMULATE]
  }, extra || {});
}

test("OAuth protected resource metadata, challenges, and dual MCP auth", async (t) => {
  const signer = await createSigner();
  const app = createApp({
    config: baseConfig({ oauth: oauthConfig(signer.jwks) })
  });
  const http = await listen(app);
  t.after(() => http.close());

  await t.test("Protected Resource Metadata at root and path-aware well-known", async () => {
    const root = await fetch(http.url + "/.well-known/oauth-protected-resource");
    const pathAware = await fetch(http.url + "/.well-known/oauth-protected-resource/mcp");
    assert.equal(root.status, 200);
    assert.equal(pathAware.status, 200);
    const json = await root.json();
    const pathJson = await pathAware.json();
    assert.deepEqual(json, pathJson);
    assert.equal(json.resource, CANONICAL_RESOURCE);
    assert.deepEqual(json.authorization_servers, [ISSUER]);
    assert.deepEqual(json.scopes_supported, [SCOPE_READ, SCOPE_SIMULATE]);
    assert.equal(json.resource_documentation, "https://tuhoy.com/api/docs");
    assert.equal(root.headers.get("access-control-allow-origin"), "*");
  });

  await t.test("WWW-Authenticate includes resource_metadata and scopes", async () => {
    const missing = await rawMcp(http.url);
    assert.equal(missing.status, 401);
    const challenge = missing.headers.get("www-authenticate") || "";
    assert.match(challenge, /Bearer/i);
    assert.match(challenge, /resource_metadata="https:\/\/tuhoy\.com\/\.well-known\/oauth-protected-resource"/);
    assert.match(challenge, /scope="biosense:read biosense:simulate"/);
    assert.ok(!missing.text.includes(API_KEY));
  });

  await t.test("BIOSENSE_API_KEY remains valid beside OAuth", async () => {
    const allowed = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + API_KEY }
    });
    assert.equal(allowed.status, 200);
    assert.match(allowed.text, /serverInfo|protocolVersion|biosense-simulator/);
  });

  await t.test("BIOSENSE_API_KEY incorrect is rejected", async () => {
    const wrong = await rawMcp(http.url, {
      headers: { Authorization: "Bearer not-the-key" }
    });
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get("www-authenticate") || "", /resource_metadata=/);
  });

  await t.test("OAuth token with correct scopes authenticates MCP", async () => {
    const token = await signToken(signer.privateKey, {
      scope: SCOPE_READ + " " + SCOPE_SIMULATE
    });
    const allowed = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(allowed.status, 200);
  });

  await t.test("OAuth token with Auth0 permissions claim authenticates MCP", async () => {
    const token = await signToken(signer.privateKey, {
      permissions: [SCOPE_READ, SCOPE_SIMULATE]
    });
    const allowed = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(allowed.status, 200);
  });

  await t.test("OAuth token expired is rejected", async () => {
    const token = await signToken(signer.privateKey, {
      scope: SCOPE_READ + " " + SCOPE_SIMULATE,
      exp: Math.floor(Date.now() / 1000) - 60
    });
    const denied = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 401);
  });

  await t.test("OAuth token with wrong issuer is rejected", async () => {
    const token = await signToken(signer.privateKey, {
      scope: SCOPE_READ + " " + SCOPE_SIMULATE,
      iss: WRONG_ISSUER
    });
    const denied = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 401);
  });

  await t.test("OAuth token with wrong audience is rejected", async () => {
    const token = await signToken(signer.privateKey, {
      scope: SCOPE_READ + " " + SCOPE_SIMULATE,
      aud: "https://tuhoy.com"
    });
    const denied = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 401);
  });

  await t.test("OAuth token without scope is rejected", async () => {
    const token = await signToken(signer.privateKey, { scope: "" });
    const denied = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get("www-authenticate") || "", /insufficient_scope|scope=/);
  });

  await t.test("OAuth token with only read scope is not enough for the MCP gate", async () => {
    const token = await signToken(signer.privateKey, { scope: SCOPE_READ });
    const denied = await rawMcp(http.url, {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 403);
  });

  await t.test("official client initialize, tools/list, and tools/call with OAuth", async () => {
    const token = await signToken(signer.privateKey, {
      scope: SCOPE_READ + " " + SCOPE_SIMULATE
    });
    const session = await connectClient(http.url, token);
    t.after(() => session.close());

    const listed = await session.client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["compare", "defaults", "info", "scenarios", "simulate", "sweep"]);
    listed.tools.forEach((tool) => {
      const schemes = tool._meta && tool._meta.securitySchemes;
      assert.ok(Array.isArray(schemes));
      assert.equal(schemes[0].type, "oauth2");
      assert.ok(schemes[0].scopes.length >= 1);
    });

    const info = await session.client.callTool({ name: "info", arguments: {} });
    assert.equal(info.structuredContent.api_version, "v1");

    const defaults = await session.client.callTool({ name: "defaults", arguments: {} });
    assert.ok(defaults.structuredContent.glucose_tia || defaults.structuredContent.adc);

    const scenarios = await session.client.callTool({ name: "scenarios", arguments: {} });
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
  });

  await t.test("official client still works with BIOSENSE_API_KEY while OAuth is enabled", async () => {
    const session = await connectClient(http.url, API_KEY);
    t.after(() => session.close());
    const info = await session.client.callTool({ name: "info", arguments: {} });
    assert.equal(info.structuredContent.api_version, "v1");
  });
});

test("Protected Resource Metadata stays unpublished without Auth0", async () => {
  const app = createApp({ config: baseConfig() });
  const http = await listen(app);
  const res = await fetch(http.url + "/.well-known/oauth-protected-resource");
  await http.close();
  assert.equal(res.status, 404);
});
