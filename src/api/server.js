"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const swaggerUi = require("swagger-ui-express");
const engine = require("../engine");
const { loadApiConfig } = require("./config");
const { createRouter } = require("./routes");
const { buildOpenApi } = require("./openapi");

const PUBLIC_PATHS = new Set(["/api/v1/health", "/openapi.json"]);

function requestId() {
  return crypto.randomUUID();
}

function isAuthorized(req, apiKey) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = match[1].trim();
  if (!provided || !apiKey) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(apiKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createApp(options) {
  const apiConfig = (options && options.config) || loadApiConfig(process.env);
  if (apiConfig.production && !apiConfig.apiKey) {
    console.error("[biosense] BIOSENSE_API_KEY is not set; UI will start but simulation API routes return 503");
  }
  if (!apiConfig.production && !apiConfig.apiKey) {
    console.warn("[biosense] BIOSENSE_API_KEY is not set; development requests are allowed without a key");
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && incoming.length < 128 ? incoming : requestId();
    res.setHeader("X-Request-ID", req.requestId);
    next();
  });

  const originList = apiConfig.allowedOrigins;
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!apiConfig.production && originList.length === 0) return callback(null, true);
      if (originList.indexOf(origin) >= 0) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
    credentials: false
  }));

  app.use(express.json({ limit: apiConfig.bodyLimit }));
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      err.status = 400;
      err.code = "INVALID_JSON";
      err.message = "Malformed JSON body";
    }
    if (err && err.type === "entity.too.large") {
      err.status = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      err.message = "JSON body exceeds size limit";
    }
    next(err);
  });

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: apiConfig.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/api/v1/health" || !apiConfig.production
  });
  app.use("/api", limiter);

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.indexOf("/api/docs") === 0) return next();
    if (req.path.indexOf("/api/v1/") !== 0) return next();
    if (!apiConfig.apiKey && !apiConfig.production) return next();
    if (apiConfig.production && !apiConfig.apiKey) {
      return res.status(503).json({
        error: {
          code: "API_KEY_NOT_CONFIGURED",
          message: "BIOSENSE_API_KEY is not configured",
          field: "Authorization",
          request_id: req.requestId
        }
      });
    }
    if (isAuthorized(req, apiConfig.apiKey)) return next();
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid bearer token",
        field: "Authorization",
        request_id: req.requestId
      }
    });
  });

  const started = Date.now();
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path === "/api/v1/health") return;
      const simId = req.biosense && req.biosense.simulationId;
      console.log(JSON.stringify({
        request_id: req.requestId,
        endpoint: req.method + " " + req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        simulation_id: simId || null,
        uptime_s: Math.round((Date.now() - started) / 1000)
      }));
    });
    next();
  });

  const { router } = createRouter(express, apiConfig);
  app.use("/api/v1", router);

  const spec = buildOpenApi(engine.CONFIG.version);
  app.get("/openapi.json", (req, res) => {
    res.json(spec);
  });
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec, {
    persistAuthorization: true,
    customSiteTitle: "BioSense Simulator API"
  }));

  const root = path.join(__dirname, "../..");
  function sendUi(fileName) {
    return (req, res) => {
      res.sendFile(path.join(root, fileName), {
        headers: fileName.endsWith(".html") ? { "Cache-Control": "no-store" } : {}
      });
    };
  }
  app.get("/", sendUi("index.html"));
  app.get("/index.html", sendUi("index.html"));
  app.get("/app.js", sendUi("app.js"));
  app.get("/styles.css", sendUi("styles.css"));
  app.use("/vendor", express.static(path.join(root, "vendor"), { dotfiles: "deny", index: false }));

  app.use((req, res) => {
    if (req.path.indexOf("/api/") === 0 || req.path === "/openapi.json") {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "Unknown API route",
          field: null,
          request_id: req.requestId
        }
      });
    }
    res.status(404).send("Not found");
  });

  app.use((err, req, res, _next) => {
    if (err && err.message === "Origin not allowed") {
      return res.status(403).json({
        error: { code: "CORS_FORBIDDEN", message: "Origin not allowed", field: null, request_id: req.requestId }
      });
    }
    const status = err && err.status ? err.status : 500;
    const expose = status < 500 || !apiConfig.production;
    res.status(status).json({
      error: {
        code: (err && err.code) || (status === 400 ? "INVALID_CONFIGURATION" : "INTERNAL_ERROR"),
        message: expose && err && err.message ? err.message : "Request failed",
        field: (err && err.field) || null,
        request_id: req.requestId
      }
    });
  });

  return app;
}

function start() {
  const apiConfig = loadApiConfig(process.env);
  const app = createApp({ config: apiConfig });
  const server = app.listen(apiConfig.port, "0.0.0.0", () => {
    console.log(JSON.stringify({
      event: "listen",
      service: "biosense-simulator-api",
      port: apiConfig.port,
      env: apiConfig.nodeEnv
    }));
  });
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
