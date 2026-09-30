"use strict";

const { createSeededRng, generateSeed, driftNaFromRatePerMin } = require("./rng");

function sampleTime(index, dt) {
  if (Math.abs(dt - 0.1) < 1e-15) return Math.round(index * dt * 10) / 10;
  return Number((index * dt).toFixed(9));
}

function resolveGlucose(engine, scenario, timeS, initialGlucose) {
  if (engine.isScripted(scenario)) return engine.scenarioGlucose(scenario, timeS, initialGlucose);
  return initialGlucose;
}

function generateUnitNoiseTracks(engine, rng, count) {
  const glucose = [];
  const oxygen = [];
  for (let i = 0; i < count; i += 1) {
    glucose.push(engine.gaussianNoise(rng));
    oxygen.push(engine.gaussianNoise(rng));
  }
  return { glucose, oxygen };
}

function scaleNoiseTracks(unitTracks, glucoseRms, oxygenRms) {
  const gRms = glucoseRms > 0 ? glucoseRms : 0;
  const oRms = oxygenRms > 0 ? oxygenRms : 0;
  return {
    glucose: unitTracks.glucose.map((value) => gRms * value),
    oxygen: unitTracks.oxygen.map((value) => oRms * value)
  };
}

function generateNoiseTracks(engine, rng, count, glucoseRms, oxygenRms) {
  return scaleNoiseTracks(generateUnitNoiseTracks(engine, rng, count), glucoseRms, oxygenRms);
}

function createRunner(engine) {
  function runOfflineSimulation(spec) {
    const options = spec || {};
    const dt = Number.isFinite(options.dt) && options.dt > 0 ? options.dt : engine.CONFIG.dt;
    const durationS = Number.isFinite(options.durationS) && options.durationS > 0 ? options.durationS : 200;
    const count = Math.round(durationS / dt) + 1;
    const scenario = options.scenario || "stable";
    const params = engine.sessionControlParams(options.params || {});
    params.scenario = scenario;
    const seed = Number.isFinite(options.randomSeed) ? options.randomSeed : generateSeed();
    const rng = options.rng || createSeededRng(seed);
    const unitTracks = options.unitNoiseTracks || null;
    const tracks = options.noiseTracks || (unitTracks
      ? scaleNoiseTracks(
        unitTracks,
        Number.isFinite(params.noiseRms) ? params.noiseRms : 0,
        Number.isFinite(params.oxygenNoiseRms) ? params.oxygenNoiseRms : 0
      )
      : generateNoiseTracks(
        engine,
        rng,
        count,
        Number.isFinite(params.noiseRms) ? params.noiseRms : 0,
        Number.isFinite(params.oxygenNoiseRms) ? params.oxygenNoiseRms : 0
      ));
    const glucoseRate = Number.isFinite(options.glucoseDriftNaPerMin) ? options.glucoseDriftNaPerMin : 0;
    const oxygenRate = Number.isFinite(options.oxygenDriftNaPerMin) ? options.oxygenDriftNaPerMin : 0;
    const session = engine.createSimulationSession(params, {
      now: options.now || new Date(),
      id: options.id
    });
    session.randomSeed = seed;
    session.sampleIntervalS = dt;
    const filterGlucose = engine.freshFilter();
    const filterOxygen = engine.freshFilter();

    for (let i = 0; i < count; i += 1) {
      const t = sampleTime(i, dt);
      const glucose = resolveGlucose(engine, scenario, t, params.initialGlucose);
      const sample = engine.runChain(Object.assign(engine.chainRequest(params, {
        glucose: glucose,
        noiseNa: tracks.glucose[i] || 0,
        oxygenNoiseNa: tracks.oxygen[i] || 0
      }), {
        filterMode: "step",
        filterState: filterGlucose,
        filterStateOxygen: filterOxygen,
        dt: dt,
        sensorDrift: (Number.isFinite(params.drift) ? params.drift : 0) + driftNaFromRatePerMin(glucoseRate, t),
        modelDrift: Number.isFinite(params.drift) ? params.drift : 0,
        oxygenSensorDrift: (Number.isFinite(params.oxygenDrift) ? params.oxygenDrift : 0) + driftNaFromRatePerMin(oxygenRate, t),
        oxygenModelDrift: Number.isFinite(params.oxygenDrift) ? params.oxygenDrift : 0
      }));
      sample.t = t;
      engine.recordSessionSample(session, sample, params);
    }
    return engine.finalizeSimulationSession(session, options.status || "complete");
  }

  return {
    runOfflineSimulation,
    generateNoiseTracks: (rng, count, glucoseRms, oxygenRms) => generateNoiseTracks(engine, rng, count, glucoseRms, oxygenRms),
    generateUnitNoiseTracks: (rng, count) => generateUnitNoiseTracks(engine, rng, count),
    scaleNoiseTracks,
    resolveGlucose,
    sampleTime
  };
}

module.exports = {
  createRunner,
  generateNoiseTracks,
  generateUnitNoiseTracks,
  scaleNoiseTracks,
  sampleTime,
  resolveGlucose
};
