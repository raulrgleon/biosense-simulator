# BioSense Simulator API

SIMULATION ONLY — NOT FOR MEDICAL USE.

The HTTP API and the browser UI share the same simulation engine. Glucose is a provisional linear model. Oxygen uses simulation units (`sim`), not mmHg or saturation.

## Installation

```bash
cd /home/raul/Calculator
npm install
cp .env.example .env
npm start
```

The UI is still served at `/`. The API listens on `PORT` (default 3000).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `BIOSENSE_API_KEY` | Bearer token. Required in production. |
| `BIOSENSE_ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Do not use `*` in production. |
| `BIOSENSE_RATE_LIMIT_PER_MINUTE` | Production rate limit. Default 60. |
| `BIOSENSE_MAX_DURATION_S` | Max simulation duration. Default 3600. |
| `BIOSENSE_MAX_SAMPLES` | Max sample count. Default 100000. |
| `BIOSENSE_MAX_SWEEP_POINTS` | Max sweep length. Default 100. |
| `BIOSENSE_MAX_COMPARE_RUNS` | Max compare runs. Default 50. |
| `PORT` | Listen port. Default 3000. |
| `NODE_ENV` | `production` refuses to start without an API key. |

## Authentication

```http
Authorization: Bearer $BIOSENSE_API_KEY
```

Public without a key: `GET /api/v1/health`, `GET /openapi.json`, `GET /api/docs`.

Simulation routes return `401` JSON if the bearer token is missing or wrong.

## OpenAPI

- Spec: `/openapi.json`
- Swagger UI: `/api/docs`

## curl

```bash
curl -X POST \
  https://YOUR_DOMAIN/api/v1/simulate \
  -H "Authorization: Bearer $BIOSENSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "scenario": "meal",
    "duration_s": 200,
    "sample_interval_s": 0.1,
    "random_seed": 12345,
    "glucose": {
      "initial_mgdl": 100,
      "noise_rms_na": 10,
      "drift_na_per_min": 0
    },
    "glucose_tia": {
      "rf_ohm": 1000000,
      "cf_f": 4.7e-7,
      "vref_v": 1.65
    }
  }'
```

## Python

```python
import os, requests

r = requests.post(
    "https://YOUR_DOMAIN/api/v1/simulate",
    headers={"Authorization": "Bearer " + os.environ["BIOSENSE_API_KEY"]},
    json={
        "scenario": "meal",
        "duration_s": 200,
        "sample_interval_s": 0.1,
        "random_seed": 12345,
        "glucose": {"initial_mgdl": 100, "noise_rms_na": 10, "drift_na_per_min": 0},
        "glucose_tia": {"rf_ohm": 1_000_000, "cf_f": 4.7e-7, "vref_v": 1.65},
    },
)
r.raise_for_status()
print(r.json()["summary"])
```

## JavaScript

```javascript
const res = await fetch("https://YOUR_DOMAIN/api/v1/simulate", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.BIOSENSE_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    scenario: "meal",
    duration_s: 200,
    sample_interval_s: 0.1,
    random_seed: 12345,
    glucose: { initial_mgdl: 100, noise_rms_na: 10, drift_na_per_min: 0 },
    glucose_tia: { rf_ohm: 1e6, cf_f: 4.7e-7, vref_v: 1.65 }
  })
});
const data = await res.json();
```

## Sweep

`parameter` must be an allowlisted path. The same `random_seed` reuses one noise realization.

```bash
curl -X POST https://YOUR_DOMAIN/api/v1/sweep \
  -H "Authorization: Bearer $BIOSENSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "parameter": "glucose_tia.cf_f",
    "values": [1e-7, 4.7e-7, 5.6e-7],
    "random_seed": 12345,
    "base_configuration": {
      "scenario": "meal",
      "duration_s": 200,
      "sample_interval_s": 0.1,
      "glucose": { "initial_mgdl": 100, "noise_rms_na": 10, "drift_na_per_min": 0 },
      "glucose_tia": { "rf_ohm": 1000000, "vref_v": 1.65 }
    }
  }'
```

## Drift sweep

`glucose.drift_na_per_min` is a rate. At time `t` seconds the engine applies `rate * t / 60` nA on the sensor only. The estimator still subtracts the configured constant drift (0 unless you set the engine constant). This is not nA/s.

```bash
curl -X POST https://YOUR_DOMAIN/api/v1/sweep \
  -H "Authorization: Bearer $BIOSENSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "parameter": "glucose.drift_na_per_min",
    "values": [0, 0.5, 1, 2, 5, 10],
    "base_configuration": {
      "scenario": "meal",
      "duration_s": 300,
      "sample_interval_s": 0.1,
      "random_seed": 20260929,
      "glucose": { "initial_mgdl": 100, "noise_rms_na": 10 },
      "glucose_tia": { "rf_ohm": 1000000, "cf_f": 4.7e-7, "vref_v": 1.65 }
    }
  }'
```

## Response shape

`POST /api/v1/simulate` returns `simulation_id`, `metadata`, `configuration`, `signal_quality`, `metrics`, `transient_analysis`, `tracking_analysis`, `summary`, and `samples` when `include_samples` is true (default).

Unavailable numbers are JSON `null`. Zero stays `0`.

## Errors

All API errors are JSON:

```json
{
  "error": {
    "code": "INVALID_CONFIGURATION",
    "message": "glucose_tia.cf_f must be greater than zero",
    "field": "glucose_tia.cf_f",
    "request_id": "..."
  }
}
```

The `X-Request-ID` header is always set.

## Security notes

- Never put the API key in the repository or in client-side UI code.
- Production CORS is an explicit origin list.
- Sweep `parameter` is allowlisted. Arbitrary object paths are rejected.
- Stack traces are not returned in production.
