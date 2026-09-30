"use strict";

const crypto = require("crypto");
const { OAuthError, OAuthErrorCode } = require("@modelcontextprotocol/server");
const { requireBearerAuth } = require("@modelcontextprotocol/express");

function tokensEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createApiKeyVerifier(apiKey) {
  return {
    async verifyAccessToken(token) {
      if (!token || !apiKey || !tokensEqual(token, apiKey)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing or invalid bearer token");
      }
      return {
        token: token,
        clientId: "biosense",
        scopes: ["biosense"],
        expiresAt: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      };
    }
  };
}

function createMcpAuthMiddleware(apiConfig) {
  const bearer = requireBearerAuth({
    verifier: createApiKeyVerifier(apiConfig.apiKey)
  });

  return function mcpAuth(req, res, next) {
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
    return bearer(req, res, next);
  };
}

module.exports = { createMcpAuthMiddleware, createApiKeyVerifier };
