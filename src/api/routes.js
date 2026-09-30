"use strict";

const engine = require("../engine");
const { createService } = require("./service");

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

function createRouter(express, apiConfig) {
  const router = express.Router();
  const service = createService(apiConfig);

  router.get("/health", (req, res) => {
    res.json({
      status: "ok",
      service: "biosense-simulator-api",
      version: engine.CONFIG.version,
      api_version: "v1"
    });
  });

  router.get("/info", (req, res) => {
    res.json(service.info());
  });

  router.get("/defaults", (req, res) => {
    res.json(service.defaults());
  });

  router.get("/scenarios", (req, res) => {
    res.json(service.scenarios());
  });

  router.post("/simulate", (req, res, next) => {
    try {
      const result = service.simulate(req.body);
      req.biosense = { simulationId: result.simulationId };
      res.json(result.payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sweep", (req, res, next) => {
    try {
      const result = service.sweep(req.body);
      req.biosense = { simulationId: result.simulationId };
      res.json(result.payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/compare", (req, res, next) => {
    try {
      const result = service.compare(req.body);
      req.biosense = { simulationId: result.simulationId };
      res.json(result.payload);
    } catch (error) {
      next(error);
    }
  });

  return { router, sendError };
}

module.exports = { createRouter, sendError: null };
