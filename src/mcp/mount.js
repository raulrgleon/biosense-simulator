"use strict";

const { createMcpHandler } = require("@modelcontextprotocol/server");
const { toNodeHandler } = require("@modelcontextprotocol/node");
const { createService } = require("../api/service");
const { createBiosenseMcpServer } = require("./factory");
const { createMcpAuthMiddleware } = require("./auth");

function createMcpNodeHandler(apiConfig) {
  const service = createService(apiConfig);
  const handler = createMcpHandler(() => createBiosenseMcpServer(service));
  return toNodeHandler(handler, {
    onerror: (error) => {
      console.error(JSON.stringify({
        event: "mcp_error",
        message: error && error.message ? error.message : "mcp handler failed"
      }));
    }
  });
}

function mountMcp(app, apiConfig) {
  const auth = createMcpAuthMiddleware(apiConfig);
  const node = createMcpNodeHandler(apiConfig);
  const handle = (req, res, next) => {
    Promise.resolve(node(req, res, req.body)).catch(next);
  };
  app.all("/mcp", auth, handle);
  app.all("/mcp/", auth, handle);
}

module.exports = { mountMcp, createMcpNodeHandler };
