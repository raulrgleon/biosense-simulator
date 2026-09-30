"use strict";

const crypto = require("crypto");
const { OAuthError, OAuthErrorCode } = require("@modelcontextprotocol/server");
const { requireBearerAuth } = require("@modelcontextprotocol/express");
const { createJwtVerifier, SCOPE_READ, SCOPE_SIMULATE } = require("./oauth");

function tokensEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function createApiKeyAuthInfo(token) {
  return {
    token: token,
    clientId: "biosense",
    scopes: [SCOPE_READ, SCOPE_SIMULATE],
    expiresAt: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
  };
}

function createDualVerifier(apiConfig) {
  const apiKey = apiConfig.apiKey;
  const oauth = apiConfig.oauth || {};
  const verifyJwt = oauth.enabled ? createJwtVerifier(oauth) : null;

  return {
    async verifyAccessToken(token) {
      if (!token) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing or invalid bearer token");
      }
      if (apiKey && tokensEqual(token, apiKey)) {
        return createApiKeyAuthInfo(token);
      }
      if (verifyJwt && looksLikeJwt(token)) {
        return verifyJwt(token);
      }
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing or invalid bearer token");
    }
  };
}

function createApiKeyVerifier(apiKey) {
  return createDualVerifier({ apiKey: apiKey, oauth: { enabled: false } });
}

function createMcpAuthMiddleware(apiConfig) {
  const oauth = apiConfig.oauth || {};
  const bearer = requireBearerAuth({
    verifier: createDualVerifier(apiConfig),
    requiredScopes: oauth.enabled ? [SCOPE_READ, SCOPE_SIMULATE] : [],
    resourceMetadataUrl: oauth.enabled ? oauth.resourceMetadataUrl : undefined
  });

  return function mcpAuth(req, res, next) {
    if (!apiConfig.apiKey && !apiConfig.production && !oauth.enabled) return next();
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

module.exports = {
  createMcpAuthMiddleware,
  createApiKeyVerifier,
  createDualVerifier
};
