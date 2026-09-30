"use strict";

const { loadOAuthConfig } = require("../mcp/oauth");

function parseOrigins(raw) {
  if (!raw) return [];
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
}

function loadApiConfig(env) {
  const source = env || process.env;
  const nodeEnv = source.NODE_ENV || "development";
  const production = nodeEnv === "production";
  return {
    nodeEnv: nodeEnv,
    production: production,
    port: Number(source.PORT) || 3000,
    apiKey: source.BIOSENSE_API_KEY || "",
    allowedOrigins: parseOrigins(source.BIOSENSE_ALLOWED_ORIGINS),
    rateLimitPerMinute: Number(source.BIOSENSE_RATE_LIMIT_PER_MINUTE) || (production ? 60 : 600),
    limits: {
      maxDurationS: Number(source.BIOSENSE_MAX_DURATION_S) || 3600,
      maxSamples: Number(source.BIOSENSE_MAX_SAMPLES) || 100000,
      maxSweepPoints: Number(source.BIOSENSE_MAX_SWEEP_POINTS) || 100,
      maxCompareRuns: Number(source.BIOSENSE_MAX_COMPARE_RUNS) || 50
    },
    bodyLimit: source.BIOSENSE_BODY_LIMIT || "256kb",
    oauth: loadOAuthConfig(source)
  };
}

module.exports = { loadApiConfig, parseOrigins };
