"use strict";

const { createRemoteJWKSet, createLocalJWKSet, jwtVerify } = require("jose");
const { OAuthError, OAuthErrorCode } = require("@modelcontextprotocol/server");

const CANONICAL_ORIGIN = "https://app.biosense.dev";
const CANONICAL_RESOURCE = CANONICAL_ORIGIN + "/mcp";
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const RESOURCE_METADATA_PATH_MCP = "/.well-known/oauth-protected-resource/mcp";
const RESOURCE_METADATA_URL = CANONICAL_ORIGIN + RESOURCE_METADATA_PATH;
const RESOURCE_DOCUMENTATION = CANONICAL_ORIGIN + "/api/docs";

const SCOPE_READ = "biosense:read";
const SCOPE_SIMULATE = "biosense:simulate";
const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_SIMULATE];

const READ_TOOLS = ["info", "defaults", "scenarios"];
const SIMULATE_TOOLS = ["simulate", "sweep", "compare"];

function scopesForTool(name) {
  if (READ_TOOLS.indexOf(name) >= 0) return [SCOPE_READ];
  if (SIMULATE_TOOLS.indexOf(name) >= 0) return [SCOPE_SIMULATE];
  return SUPPORTED_SCOPES.slice();
}

function toolSecurityMeta(name) {
  return {
    securitySchemes: [{ type: "oauth2", scopes: scopesForTool(name) }]
  };
}

function normalizeIssuer(raw) {
  const issuer = String(raw || "").trim();
  if (!issuer) return "";
  return issuer.endsWith("/") ? issuer : issuer + "/";
}

function loadOAuthConfig(source) {
  const env = source || {};
  const domain = String(env.AUTH0_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const audience = String(env.AUTH0_AUDIENCE || "").trim() || CANONICAL_RESOURCE;
  const issuer = normalizeIssuer(env.AUTH0_ISSUER) || (domain ? "https://" + domain + "/" : "");
  const enabled = Boolean(domain && issuer && audience);
  return {
    enabled: enabled,
    domain: domain,
    issuer: issuer,
    audience: audience,
    jwksUrl: domain ? "https://" + domain + "/.well-known/jwks.json" : "",
    localJwks: env.BIOSENSE_OAUTH_JWKS || null,
    resource: CANONICAL_RESOURCE,
    resourceMetadataUrl: RESOURCE_METADATA_URL,
    resourceDocumentation: RESOURCE_DOCUMENTATION,
    scopesSupported: SUPPORTED_SCOPES.slice()
  };
}

function buildProtectedResourceMetadata(oauth) {
  if (!oauth || !oauth.enabled) return null;
  return {
    resource: oauth.resource || CANONICAL_RESOURCE,
    authorization_servers: [oauth.issuer],
    scopes_supported: oauth.scopesSupported || SUPPORTED_SCOPES.slice(),
    bearer_methods_supported: ["header"],
    resource_name: "BioSense Simulator MCP",
    resource_documentation: oauth.resourceDocumentation || RESOURCE_DOCUMENTATION
  };
}

function extractScopes(payload) {
  const found = [];
  if (typeof payload.scope === "string") {
    payload.scope.split(/\s+/).forEach((item) => {
      if (item) found.push(item);
    });
  }
  if (Array.isArray(payload.permissions)) {
    payload.permissions.forEach((item) => {
      if (item) found.push(String(item));
    });
  }
  if (Array.isArray(payload.scp)) {
    payload.scp.forEach((item) => {
      if (item) found.push(String(item));
    });
  }
  return found.filter((item, index, all) => all.indexOf(item) === index);
}

function audienceMatches(payload, expected) {
  const aud = payload.aud;
  if (typeof aud === "string" && aud === expected) return true;
  if (Array.isArray(aud) && aud.indexOf(expected) >= 0) return true;
  if (payload.resource === expected) return true;
  return false;
}

function createJwks(oauth) {
  if (oauth.localJwks && oauth.localJwks.keys) {
    return createLocalJWKSet(oauth.localJwks);
  }
  if (!oauth.jwksUrl) {
    throw new OAuthError(OAuthErrorCode.ServerError, "OAuth JWKS is not configured");
  }
  return createRemoteJWKSet(new URL(oauth.jwksUrl));
}

function createJwtVerifier(oauth) {
  const jwks = createJwks(oauth);
  return async function verifyJwt(token) {
    let payload;
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: oauth.issuer,
        algorithms: ["RS256"],
        clockTolerance: 5
      });
      payload = verified.payload;
    } catch (error) {
      const code = error && error.code;
      if (code === "ERR_JWT_EXPIRED") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token has expired");
      }
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && error.claim === "iss") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token issuer is invalid");
      }
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && error.claim === "nbf") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is not yet valid");
      }
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token signature or claims are invalid");
    }

    if (!audienceMatches(payload, oauth.audience)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token audience is invalid");
    }

    const scopes = extractScopes(payload);
    const recognized = scopes.filter((scope) => SUPPORTED_SCOPES.indexOf(scope) >= 0);
    if (recognized.length === 0) {
      throw new OAuthError(OAuthErrorCode.InsufficientScope, "Access token is missing required scopes");
    }

    if (typeof payload.exp !== "number") {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token has no expiration");
    }

    return {
      token: token,
      clientId: String(payload.azp || payload.client_id || payload.sub || "oauth"),
      scopes: recognized,
      expiresAt: payload.exp,
      extra: {
        sub: payload.sub || null,
        iss: payload.iss || null
      }
    };
  };
}

function mountProtectedResourceMetadata(app, oauth) {
  const document = buildProtectedResourceMetadata(oauth);
  const send = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).end();
    }
    if (!document) {
      return res.status(404).json({
        error: {
          code: "OAUTH_NOT_CONFIGURED",
          message: "Protected Resource Metadata is unpublished until Auth0 is configured",
          field: null
        }
      });
    }
    return res.json(document);
  };
  app.all(RESOURCE_METADATA_PATH, send);
  app.all(RESOURCE_METADATA_PATH_MCP, send);
}

module.exports = {
  CANONICAL_ORIGIN,
  CANONICAL_RESOURCE,
  RESOURCE_METADATA_PATH,
  RESOURCE_METADATA_PATH_MCP,
  RESOURCE_METADATA_URL,
  SCOPE_READ,
  SCOPE_SIMULATE,
  SUPPORTED_SCOPES,
  READ_TOOLS,
  SIMULATE_TOOLS,
  scopesForTool,
  toolSecurityMeta,
  loadOAuthConfig,
  buildProtectedResourceMetadata,
  extractScopes,
  audienceMatches,
  createJwtVerifier,
  mountProtectedResourceMetadata
};
