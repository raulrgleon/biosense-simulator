"use strict";

const DISCLAIMER = "SIMULATION ONLY - NOT FOR MEDICAL USE";

function buildOpenApi(version) {
  const error = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", example: "INVALID_CONFIGURATION" },
          message: { type: "string" },
          field: { type: "string", nullable: true },
          request_id: { type: "string", nullable: true }
        }
      }
    }
  };

  const glucose = {
    type: "object",
    properties: {
      initial_mgdl: { type: "number", example: 100 },
      sensitivity_na_per_mgdl: { type: "number", example: 1 },
      baseline_na: { type: "number", example: 0 },
      noise_rms_na: { type: "number", minimum: 0, example: 10 },
      drift_na_per_min: {
        type: "number",
        description: "Physical drift rate in nA/min. Converted internally to nA at each sample as rate * t / 60. Not nA/s.",
        example: 0
      }
    }
  };

  const simulateRequest = {
    type: "object",
    properties: {
      scenario: { type: "string", example: "meal" },
      duration_s: { type: "number", exclusiveMinimum: 0, example: 200 },
      sample_interval_s: { type: "number", exclusiveMinimum: 0, example: 0.1 },
      random_seed: { type: "integer", minimum: 0, maximum: 4294967295, example: 12345 },
      include_samples: { type: "boolean", default: true },
      glucose: glucose,
      oxygen: {
        type: "object",
        properties: {
          initial_sim: { type: "number", example: 50, description: "Simulation units, not mmHg or saturation." },
          sensitivity_na_per_sim: { type: "number", example: 1 },
          baseline_na: { type: "number", example: 0 },
          noise_rms_na: { type: "number", example: 0 },
          drift_na_per_min: { type: "number", example: 0 }
        }
      },
      temperature: {
        type: "object",
        properties: {
          initial_c: { type: "number", example: 37 },
          coefficient_percent_per_c: { type: "number", example: 0 }
        }
      },
      glucose_tia: {
        type: "object",
        properties: {
          vref_v: { type: "number", example: 1.65 },
          rf_ohm: { type: "number", exclusiveMinimum: 0, example: 1000000 },
          cf_f: { type: "number", exclusiveMinimum: 0, example: 4.7e-7 }
        }
      },
      oxygen_tia: {
        type: "object",
        properties: {
          vref_v: { type: "number", example: 1.65 },
          rf_ohm: { type: "number", exclusiveMinimum: 0, example: 1000000 },
          cf_f: { type: "number", exclusiveMinimum: 0, example: 1e-7 }
        }
      },
      adc: {
        type: "object",
        properties: {
          bits: { type: "integer", example: 12 },
          vref_v: { type: "number", example: 3.3 },
          vcc_v: { type: "number", example: 3.3 }
        }
      },
      oxygen_glucose_influence: {
        type: "object",
        properties: {
          enabled: { type: "boolean", example: false },
          coefficient: { type: "number", example: 0 }
        }
      }
    }
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "BioSense Simulator API",
      version: version,
      description: [
        DISCLAIMER,
        "Glucose model is PROVISIONAL. Oxygen uses simulation units (sim), not mmHg or saturation.",
        "The API uses the same simulation engine as the browser UI.",
        "Numeric fields that are unavailable are JSON null. Responses never contain NaN or Infinity.",
        "Drift is specified as drift_na_per_min."
      ].join(" ")
    },
    servers: [{ url: "/", description: "Current host" }],
    tags: [
      { name: "meta" },
      { name: "simulation" }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key",
          description: "Authorization: Bearer <BIOSENSE_API_KEY>"
        }
      },
      schemas: {
        Error: error,
        SimulateRequest: simulateRequest
      }
    },
    paths: {
      "/api/v1/health": {
        get: {
          operationId: "healthCheck",
          tags: ["meta"],
          summary: "Liveness check",
          security: [],
          responses: {
            "200": {
              description: "Service is up",
              content: {
                "application/json": {
                  example: {
                    status: "ok",
                    service: "biosense-simulator-api",
                    version: version,
                    api_version: "v1"
                  }
                }
              }
            }
          }
        }
      },
      "/api/v1/info": {
        get: {
          operationId: "getSimulatorInfo",
          tags: ["meta"],
          summary: "Simulator capabilities",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Simulator metadata" }, "401": { description: "Unauthorized" } }
        }
      },
      "/api/v1/defaults": {
        get: {
          operationId: "getDefaults",
          tags: ["meta"],
          summary: "Current simulator defaults",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Default configuration" }, "401": { description: "Unauthorized" } }
        }
      },
      "/api/v1/scenarios": {
        get: {
          operationId: "listScenarios",
          tags: ["meta"],
          summary: "Supported scenarios",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Scenario list" }, "401": { description: "Unauthorized" } }
        }
      },
      "/api/v1/simulate": {
        post: {
          operationId: "runSimulation",
          tags: ["simulation"],
          summary: "Run one simulation",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SimulateRequest" } } }
          },
          responses: {
            "200": { description: "Completed simulation" },
            "400": { description: "Invalid configuration", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized" }
          }
        }
      },
      "/api/v1/sweep": {
        post: {
          operationId: "runSweep",
          tags: ["simulation"],
          summary: "Sweep one allowlisted parameter",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["parameter", "values"],
                  properties: {
                    parameter: { type: "string", example: "glucose_tia.cf_f" },
                    values: { type: "array", items: { type: "number" }, example: [4.7e-7, 5.6e-7] },
                    random_seed: { type: "integer", example: 12345 },
                    include_samples: { type: "boolean", default: false },
                    base_configuration: { $ref: "#/components/schemas/SimulateRequest" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Sweep comparison table" },
            "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized" }
          }
        }
      },
      "/api/v1/compare": {
        post: {
          operationId: "compareSimulations",
          tags: ["simulation"],
          summary: "Compare named configurations",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["runs"],
                  properties: {
                    random_seed: { type: "integer", example: 12345 },
                    include_samples: { type: "boolean", default: false },
                    runs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          configuration: { $ref: "#/components/schemas/SimulateRequest" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Comparable run metrics. No winner is declared." },
            "400": { description: "Invalid request" },
            "401": { description: "Unauthorized" }
          }
        }
      }
    }
  };
}

module.exports = { buildOpenApi };
