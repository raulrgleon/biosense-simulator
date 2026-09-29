"use strict";

/* ============================================================
   CONFIG
   Provisional values are design knobs for the bench simulator.
   They are not measurements from a physical electrode.
   ============================================================ */

const CONFIG = {
  glucose: { min: 40, max: 400, default: 200 },
  temperature: { min: 30, max: 42, default: 37, referenceC: 37 },
  sensitivity: { min: 0.01, max: 20, default: 1 },
  baseline: { min: -200, max: 200, default: 0 },
  drift: { min: -50, max: 50, default: 0 },
  noise: { min: 0, max: 50, default: 0 },
  tempCoeff: { min: -5, max: 5, default: 0 },
  oxygen: {
    min: 0,
    max: 100,
    default: 50,
    reference: 50,
    unit: "sim",
    sensitivity: { min: 0.01, max: 20, default: 1 },
    influence: { min: -5, max: 5, default: 0 }
  },
  quality: { noiseWarnNa: 20 },
  vcc: 3.3,
  vref: { min: 0, max: 3.3, default: 1.65 },
  adcVref: { min: 0.5, max: 5, default: 3.3 },
  adcBits: [8, 10, 12, 14, 16, 18, 24],
  adcBitsDefault: 12,
  rfOptions: [
    { label: "100 kΩ", ohms: 1e5 },
    { label: "220 kΩ", ohms: 2.2e5 },
    { label: "470 kΩ", ohms: 4.7e5 },
    { label: "1 MΩ", ohms: 1e6, isDefault: true },
    { label: "2.2 MΩ", ohms: 2.2e6 },
    { label: "4.7 MΩ", ohms: 4.7e6 },
    { label: "10 MΩ", ohms: 1e7 }
  ],
  cfOptions: [
    { label: "100 pF", farads: 100e-12 },
    { label: "1 nF", farads: 1e-9 },
    { label: "10 nF", farads: 10e-9 },
    { label: "100 nF", farads: 100e-9, isDefault: true },
    { label: "1 µF", farads: 1e-6 }
  ],
  scenarios: [
    { id: "stable", label: "Stable glucose" },
    { id: "rising", label: "Rising glucose" },
    { id: "falling", label: "Falling glucose" },
    { id: "meal", label: "Meal spike" },
    { id: "rapid", label: "Hypothetical rapid change" },
    { id: "custom", label: "Custom" }
  ],
  scenarioCopy: {
    stable: "Holds the glucose slider. Simulated constant input.",
    rising: "Simulated rise from 80 to 300 mg/dL over 120 s, then holds.",
    falling: "Simulated fall from 340 to 60 mg/dL over 120 s, then holds.",
    meal: "Simulated spike from 100 to 280 mg/dL, then decay to 150. Not a clinical meal model.",
    rapid: "Hypothetical steps for electronics stress. Not a physiological signal.",
    custom: "The glucose slider is the live input while the simulation runs."
  },
  sweepGlucose: [40, 50, 70, 100, 150, 200, 250, 300, 350, 400],
  mmolDivisor: 18.01559,
  sampleHz: 10,
  dt: 0.1,
  historySeconds: 120,
  chartSeconds: 60,
  transient: {
    stepThresholdMgDl: 5,
    settlingBandMgDl: 5,
    settlingPercent: 2,
    holdTimeS: 1,
    trackingRateThreshold: 0.25,
    lagMaxS: 5
  },
  version: "2.2.0"
};

/* ============================================================
   STATE
   ============================================================ */

const STATE = {
  running: false,
  time: 0,
  timerId: null,
  filterGlucose: { value: null, initialized: false },
  filterOxygen: { value: null, initialized: false },
  history: [],
  saturationCount: 0,
  glucoseSatCount: 0,
  oxygenSatCount: 0,
  glucoseClipCount: 0,
  oxygenClipCount: 0,
  sweepRows: [],
  experimentRows: [],
  charts: null,
  manualGlucose: CONFIG.glucose.default,
  selfTest: null,
  holdLast: false,
  session: null
};

/* ============================================================
   SENSOR MODEL
   ============================================================ */

function glucoseToCurrent(glucoseMgDl, sensitivityNaPerMgDl, baselineNa, driftNa, noiseNa) {
  return glucoseMgDl * sensitivityNaPerMgDl + baselineNa + driftNa + noiseNa;
}

function temperatureFactor(tempC, coeffPercentPerC) {
  const k = coeffPercentPerC / 100;
  return 1 + k * (tempC - CONFIG.temperature.referenceC);
}

function applyPhysicalTemperature(rawCurrentNa, tempC, coeffPercentPerC) {
  const factor = temperatureFactor(tempC, coeffPercentPerC);
  if (!Number.isFinite(rawCurrentNa) || !Number.isFinite(factor)) {
    return { currentNa: NaN, factor };
  }
  return { currentNa: rawCurrentNa * factor, factor };
}

function applyTemperatureCompensation(currentNa, tempC, coeffPercentPerC) {
  const factor = temperatureFactor(tempC, coeffPercentPerC);
  if (!Number.isFinite(currentNa) || !Number.isFinite(factor) || Math.abs(factor) < 1e-12) {
    return { currentNa: NaN, factor, valid: false };
  }
  return { currentNa: currentNa / factor, factor, valid: true };
}

function applyTemperatureInfluence(rawCurrentNa, tempC, coeffPercentPerC) {
  return applyPhysicalTemperature(rawCurrentNa, tempC, coeffPercentPerC);
}

function oxygenToCurrent(oxygenLevel, sensitivity, baseline, drift, noiseNa) {
  return oxygenLevel * sensitivity + baseline + drift + noiseNa;
}

function applyOxygenInfluence(currentNa, oxygenLevel, coeffPercent, enabled) {
  if (!enabled || coeffPercent === 0 || !Number.isFinite(currentNa) || !Number.isFinite(oxygenLevel) || !Number.isFinite(coeffPercent)) {
    return { currentNa: currentNa, factor: 1, correctionNa: 0, active: false };
  }
  const factor = 1 + (coeffPercent / 100) * (oxygenLevel - CONFIG.oxygen.reference);
  if (!Number.isFinite(factor)) {
    return { currentNa: NaN, factor: NaN, correctionNa: NaN, active: true };
  }
  const influenced = currentNa * factor;
  return {
    currentNa: influenced,
    factor: factor,
    correctionNa: influenced - currentNa,
    active: true
  };
}

function gaussianNoise(random) {
  const rng = random || Math.random;
  let u = 0;
  let v = 0;
  let guard = 0;
  while (u === 0 && guard < 20) {
    u = rng();
    guard += 1;
  }
  guard = 0;
  while (v === 0 && guard < 20) {
    v = rng();
    guard += 1;
  }
  if (!(u > 0) || !(v > 0)) return 0;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mgDlToMmol(mgDl) {
  if (!Number.isFinite(mgDl)) return NaN;
  return mgDl / CONFIG.mmolDivisor;
}

/* ============================================================
   TIA MODEL
   ============================================================ */

function calculateTIAOutput(currentNa, vref, rfOhms, vcc) {
  if (!Number.isFinite(currentNa) || !Number.isFinite(vref) || !(rfOhms > 0) || !(vcc > 0)) {
    return { ideal: NaN, clamped: NaN, saturated: false, currentA: NaN };
  }
  const currentA = currentNa * 1e-9;
  const ideal = vref + currentA * rfOhms;
  const saturated = ideal <= 0 || ideal >= vcc;
  const clamped = Math.min(vcc, Math.max(0, ideal));
  return { ideal, clamped, saturated, currentA };
}

/* ============================================================
   FILTER MODEL
   ============================================================ */

function calculateCutoffFrequency(rfOhms, cfFarads) {
  const rc = rfOhms * cfFarads;
  if (!(rc > 0) || !Number.isFinite(rc)) return { fc: NaN, rc: NaN };
  return { fc: 1 / (2 * Math.PI * rc), rc };
}

function filterAlpha(rfOhms, cfFarads, dt) {
  const rc = rfOhms * cfFarads;
  const denom = rc + dt;
  if (!(dt > 0) || !(denom > 0) || !Number.isFinite(denom)) return 1;
  const alpha = dt / denom;
  if (!Number.isFinite(alpha)) return 1;
  return Math.min(1, Math.max(0, alpha));
}

function applyLowPassFilter(state, input, rfOhms, cfFarads, dt) {
  if (!Number.isFinite(input)) {
    return state.initialized ? state.value : NaN;
  }
  const alpha = filterAlpha(rfOhms, cfFarads, dt);
  if (!state.initialized || !Number.isFinite(state.value)) {
    state.value = input;
    state.initialized = true;
    return input;
  }
  state.value = state.value + alpha * (input - state.value);
  return state.value;
}

/* ============================================================
   ADC MODEL
   ============================================================ */

function adcMaximum(bits) {
  if (!Number.isFinite(bits) || bits < 1 || bits > 30) return NaN;
  return 2 ** bits - 1;
}

function voltageToADC(voltage, bits, adcVref) {
  const max = adcMaximum(bits);
  const lsb = Number.isFinite(max) && max > 0 && adcVref > 0 ? adcVref / max : NaN;
  if (!Number.isFinite(voltage) || !Number.isFinite(max) || !(adcVref > 0)) {
    return { count: NaN, max, lsb, clipped: false, valid: false };
  }
  const scaled = (voltage / adcVref) * max;
  let clipped = false;
  let bounded = scaled;
  if (bounded < 0) {
    bounded = 0;
    clipped = true;
  } else if (bounded > max) {
    bounded = max;
    clipped = true;
  }
  let count = Math.round(bounded);
  if (count < 0) {
    count = 0;
    clipped = true;
  }
  if (count > max) {
    count = max;
    clipped = true;
  }
  return { count, max, lsb, clipped, valid: true };
}

function adcToVoltage(count, bits, adcVref) {
  const max = adcMaximum(bits);
  if (!Number.isFinite(count) || !Number.isFinite(max) || !(max > 0) || !(adcVref > 0)) return NaN;
  const clamped = Math.min(max, Math.max(0, count));
  return (clamped / max) * adcVref;
}

/* ============================================================
   CALIBRATION MODEL
   ============================================================ */

function recoverCurrent(vAdc, vref, rfOhms) {
  if (!Number.isFinite(vAdc) || !Number.isFinite(vref) || !(rfOhms > 0)) return NaN;
  const currentA = (vAdc - vref) / rfOhms;
  return currentA * 1e9;
}

function currentToGlucose(compensatedNa, baselineNa, driftNa, sensitivity) {
  if (!Number.isFinite(compensatedNa) || !Number.isFinite(baselineNa) || !Number.isFinite(driftNa)) return NaN;
  if (!(Math.abs(sensitivity) > 1e-12)) return NaN;
  return (compensatedNa - baselineNa - driftNa) / sensitivity;
}

const GlucoseSensorModel = { glucoseToCurrent };
const OxygenSensorModel = { oxygenToCurrent, applyOxygenInfluence };
const TemperatureModel = {
  temperatureFactor,
  applyTemperatureInfluence,
  applyTemperatureCompensation
};
const TIAModel = { calculateTIAOutput };
const FilterModel = { calculateCutoffFrequency, filterAlpha, applyLowPassFilter };
const ADCModel = { voltageToADC, adcToVoltage, adcMaximum };

function freshFilter() {
  return { value: null, initialized: false };
}

function oxygenSettings(input) {
  return {
    level: Number.isFinite(input.oxygenLevel) ? input.oxygenLevel : CONFIG.oxygen.default,
    sensitivity: Number.isFinite(input.oxygenSensitivity) ? input.oxygenSensitivity : CONFIG.oxygen.sensitivity.default,
    baseline: Number.isFinite(input.oxygenBaseline) ? input.oxygenBaseline : 0,
    drift: Number.isFinite(input.oxygenDrift) ? input.oxygenDrift : 0,
    noiseNa: Number.isFinite(input.oxygenNoiseNa) ? input.oxygenNoiseNa : 0,
    vref: Number.isFinite(input.oxygenVref) ? input.oxygenVref : input.vref,
    rf: Number.isFinite(input.oxygenRf) ? input.oxygenRf : input.rf,
    cf: Number.isFinite(input.oxygenCf) ? input.oxygenCf : input.cf,
    influenceEnabled: !!input.oxygenInfluenceEnabled,
    influenceCoeff: Number.isFinite(input.oxygenInfluenceCoeff) ? input.oxygenInfluenceCoeff : 0
  };
}

function processChannel(currentNa, vref, rf, cf, vcc, adcBits, adcVref, filterMode, filterState, dt) {
  const tia = TIAModel.calculateTIAOutput(currentNa, vref, rf, vcc);
  const cutoff = FilterModel.calculateCutoffFrequency(rf, cf);
  const alpha = FilterModel.filterAlpha(rf, cf, dt);
  const state = filterState || freshFilter();
  const vFiltered = filterMode === "step"
    ? FilterModel.applyLowPassFilter(state, tia.clamped, rf, cf, dt)
    : tia.clamped;
  const adc = ADCModel.voltageToADC(vFiltered, adcBits, adcVref);
  const vAdc = ADCModel.adcToVoltage(adc.count, adcBits, adcVref);
  const iRecovered = recoverCurrent(vAdc, vref, rf);
  return { tia, cutoff, alpha, vFiltered, adc, vAdc, iRecovered, vref, rf, cf };
}

function temperatureChannel(tempC, adcBits, adcVref) {
  const span = CONFIG.temperature.max - CONFIG.temperature.min;
  const fraction = span > 0 && Number.isFinite(tempC) ? (tempC - CONFIG.temperature.min) / span : NaN;
  const voltage = Number.isFinite(fraction) && adcVref > 0 ? fraction * adcVref : NaN;
  return {
    tempC,
    provisional: true,
    voltage,
    adc: ADCModel.voltageToADC(voltage, adcBits, adcVref),
    label: "PROVISIONAL / SIMULATION PARAMETER"
  };
}

function assessSignalQuality(glucoseElec, oxygenElec, estimatedGlucose, estimatedOxygen, noiseRms, oxygenNoiseRms) {
  const reasons = [];
  const invalid = !Number.isFinite(estimatedGlucose) || !Number.isFinite(estimatedOxygen);
  if (invalid) reasons.push("invalid parameters");
  if (glucoseElec.tia && glucoseElec.tia.saturated) reasons.push("glucose TIA saturation");
  if (oxygenElec.tia && oxygenElec.tia.saturated) reasons.push("oxygen TIA saturation");
  if (glucoseElec.adc && glucoseElec.adc.clipped) reasons.push("glucose ADC clipping");
  if (oxygenElec.adc && oxygenElec.adc.clipped) reasons.push("oxygen ADC clipping");
  if (noiseRms > CONFIG.quality.noiseWarnNa || oxygenNoiseRms > CONFIG.quality.noiseWarnNa) {
    reasons.push("excessive noise");
  }
  let status = "GOOD";
  if (invalid) status = "INVALID";
  else if (reasons.length) status = "WARNING";
  return { status, reasons };
}

function bioSenseAlgorithm(glucoseSignal, oxygenSignal, temperature) {
  const quality = assessSignalQuality(
    glucoseSignal,
    oxygenSignal,
    glucoseSignal.glucoseEst,
    oxygenSignal.oxygenEst,
    glucoseSignal.noiseRms,
    oxygenSignal.noiseRms
  );
  return {
    estimatedGlucose: glucoseSignal.glucoseEst,
    estimatedOxygen: oxygenSignal.oxygenEst,
    temperature: temperature.tempC,
    signalQuality: quality.status,
    qualityReasons: quality.reasons,
    rawGlucoseNa: glucoseSignal.iRaw,
    oxygenCorrectionNa: glucoseSignal.oxygenCorrectionNa,
    temperatureCorrectionNa: glucoseSignal.tempCorrectionNa
  };
}

const BioSenseAlgorithm = { run: bioSenseAlgorithm, assessSignalQuality };

function runChain(input) {
  const o2 = oxygenSettings(input);
  const iRaw = GlucoseSensorModel.glucoseToCurrent(
    input.glucose, input.sensitivity, input.baseline, input.drift, input.noiseNa
  );
  const influence = OxygenSensorModel.applyOxygenInfluence(
    iRaw, o2.level, o2.influenceCoeff, o2.influenceEnabled
  );
  const physical = TemperatureModel.applyTemperatureInfluence(influence.currentNa, input.tempC, input.tempCoeff);
  const glucoseElec = processChannel(
    physical.currentNa, input.vref, input.rf, input.cf, input.vcc,
    input.adcBits, input.adcVref, input.filterMode, input.filterState, input.dt
  );
  const compensated = TemperatureModel.applyTemperatureCompensation(
    glucoseElec.iRecovered, input.tempC, input.tempCoeff
  );
  const glucoseEst = currentToGlucose(compensated.currentNa, input.baseline, input.drift, input.sensitivity);
  const error = Number.isFinite(glucoseEst) ? glucoseEst - input.glucose : NaN;
  const tempCorrectionNa = Number.isFinite(compensated.currentNa) && Number.isFinite(glucoseElec.iRecovered)
    ? compensated.currentNa - glucoseElec.iRecovered
    : NaN;

  const oxygenRaw = OxygenSensorModel.oxygenToCurrent(o2.level, o2.sensitivity, o2.baseline, o2.drift, o2.noiseNa);
  const oxygenElec = processChannel(
    oxygenRaw, o2.vref, o2.rf, o2.cf, input.vcc,
    input.adcBits, input.adcVref, input.filterMode, input.filterStateOxygen, input.dt
  );
  const oxygenEst = currentToGlucose(oxygenElec.iRecovered, o2.baseline, o2.drift, o2.sensitivity);
  const temperature = temperatureChannel(input.tempC, input.adcBits, input.adcVref);

  const glucoseSignal = {
    iRaw,
    glucoseEst,
    oxygenCorrectionNa: influence.correctionNa,
    tempCorrectionNa,
    noiseRms: Number.isFinite(input.noiseRms) ? input.noiseRms : 0,
    tia: glucoseElec.tia,
    adc: glucoseElec.adc
  };
  const oxygenSignal = {
    oxygenEst,
    noiseRms: Number.isFinite(input.oxygenNoiseRms) ? input.oxygenNoiseRms : 0,
    tia: oxygenElec.tia,
    adc: oxygenElec.adc
  };
  const algorithm = BioSenseAlgorithm.run(glucoseSignal, oxygenSignal, temperature);
  const quantErrorV = Number.isFinite(glucoseElec.vFiltered) && Number.isFinite(glucoseElec.vAdc)
    ? Math.abs(glucoseElec.vFiltered - glucoseElec.vAdc)
    : NaN;

  return {
    glucose: input.glucose,
    glucoseMmol: mgDlToMmol(input.glucose),
    iRaw,
    iPhysical: physical.currentNa,
    currentA: glucoseElec.tia.currentA,
    tempFactor: physical.factor,
    oxygenFactor: influence.factor,
    oxygenCorrectionNa: influence.correctionNa,
    oxygenInfluenceActive: influence.active,
    iCompensated: compensated.currentNa,
    tempCorrectionNa,
    tia: glucoseElec.tia,
    cutoff: glucoseElec.cutoff,
    alpha: glucoseElec.alpha,
    vFiltered: glucoseElec.vFiltered,
    adc: glucoseElec.adc,
    vAdc: glucoseElec.vAdc,
    iRecovered: glucoseElec.iRecovered,
    glucoseEst,
    error,
    absError: Number.isFinite(error) ? Math.abs(error) : NaN,
    pctError: Number.isFinite(error) && input.glucose !== 0 ? (error / input.glucose) * 100 : NaN,
    quantErrorV,
    currentError: Number.isFinite(glucoseElec.iRecovered) && Number.isFinite(physical.currentNa)
      ? glucoseElec.iRecovered - physical.currentNa
      : NaN,
    noiseNa: input.noiseNa,
    noiseRms: glucoseSignal.noiseRms,
    tempC: input.tempC,
    tempCoeff: input.tempCoeff,
    vref: input.vref,
    rf: input.rf,
    cf: input.cf,
    adcBits: input.adcBits,
    oxygen: {
      level: o2.level,
      unit: CONFIG.oxygen.unit,
      sensitivity: o2.sensitivity,
      baseline: o2.baseline,
      drift: o2.drift,
      noiseNa: o2.noiseNa,
      iRaw: oxygenRaw,
      iPhysical: oxygenRaw,
      currentA: oxygenElec.tia.currentA,
      tia: oxygenElec.tia,
      cutoff: oxygenElec.cutoff,
      alpha: oxygenElec.alpha,
      vFiltered: oxygenElec.vFiltered,
      adc: oxygenElec.adc,
      vAdc: oxygenElec.vAdc,
      iRecovered: oxygenElec.iRecovered,
      oxygenEst,
      vref: o2.vref,
      rf: o2.rf,
      cf: o2.cf
    },
    temperature,
    algorithm,
    signalQuality: algorithm.signalQuality,
    qualityReasons: algorithm.qualityReasons
  };
}

function calculateMetrics(history, saturationCount) {
  let n = 0;
  let sum = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let maxAbs = 0;
  let sumQ = 0;
  let nQ = 0;
  for (let i = 0; i < history.length; i += 1) {
    const sample = history[i];
    if (!Number.isFinite(sample.error)) continue;
    n += 1;
    sum += sample.error;
    const ae = Math.abs(sample.error);
    sumAbs += ae;
    sumSq += sample.error * sample.error;
    if (ae > maxAbs) maxAbs = ae;
    if (Number.isFinite(sample.quantErrorV)) {
      sumQ += sample.quantErrorV;
      nQ += 1;
    }
  }
  if (n === 0) {
    return {
      meanError: NaN,
      mae: NaN,
      rmse: NaN,
      maxError: NaN,
      meanQuantUv: NaN,
      saturationCount: saturationCount || 0,
      n: 0
    };
  }
  return {
    meanError: sum / n,
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    maxError: maxAbs,
    meanQuantUv: nQ ? (sumQ / nQ) * 1e6 : NaN,
    saturationCount: saturationCount || 0,
    n
  };
}

/* ============================================================
   SCENARIOS
   Simulated waveforms only. Not physiological claims.
   ============================================================ */

function ease01(u) {
  const x = Math.min(1, Math.max(0, u));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

function scenarioGlucose(scenario, t, customGlucose) {
  const lo = CONFIG.glucose.min;
  const hi = CONFIG.glucose.max;
  const clamp = (g) => Math.min(hi, Math.max(lo, g));
  if (scenario === "rising") {
    return clamp(80 + (300 - 80) * ease01(t / 120));
  }
  if (scenario === "falling") {
    return clamp(340 + (60 - 340) * ease01(t / 120));
  }
  if (scenario === "meal") {
    if (t <= 20) return 100;
    if (t <= 50) return clamp(100 + (280 - 100) * ease01((t - 20) / 30));
    if (t <= 120) return clamp(280 + (150 - 280) * ease01((t - 50) / 70));
    return 150;
  }
  if (scenario === "rapid") {
    const levels = [60, 180, 320, 90, 250, 140, 380, 70];
    const idx = Math.floor(Math.max(0, t) / 10) % levels.length;
    return levels[idx];
  }
  return clamp(customGlucose);
}

function isScripted(scenario) {
  return scenario !== "stable" && scenario !== "custom";
}

function experimentFrame(kind, t, params) {
  const u = Math.min(1, Math.max(0, t / 120));
  if (kind === "exp1") {
    return {
      glucose: 200,
      oxygenLevel: CONFIG.oxygen.min + (CONFIG.oxygen.max - CONFIG.oxygen.min) * u,
      tempC: 37,
      drift: 0,
      oxygenDrift: 0,
      noiseNa: 0,
      oxygenNoiseNa: 0
    };
  }
  if (kind === "exp2") {
    return {
      glucose: 200,
      oxygenLevel: params.oxygenLevel,
      tempC: CONFIG.temperature.min + (CONFIG.temperature.max - CONFIG.temperature.min) * u,
      drift: 0,
      oxygenDrift: 0,
      noiseNa: 0,
      oxygenNoiseNa: 0
    };
  }
  if (kind === "exp3") {
    return {
      glucose: CONFIG.glucose.min + (CONFIG.glucose.max - CONFIG.glucose.min) * u,
      oxygenLevel: params.oxygenLevel,
      tempC: params.tempC,
      drift: 0,
      oxygenDrift: 0,
      noiseNa: 0,
      oxygenNoiseNa: 0
    };
  }
  return {
    glucose: 80 + (320 - 80) * u,
    oxygenLevel: Math.min(CONFIG.oxygen.max, Math.max(CONFIG.oxygen.min, 50 + 40 * Math.sin((2 * Math.PI * t) / 40))),
    tempC: 33 + (41 - 33) * u,
    drift: -10 + 20 * u,
    oxygenDrift: -10 + 20 * u,
    noiseNa: 5 * gaussianNoise(),
    oxygenNoiseNa: 5 * gaussianNoise()
  };
}

function runExperiment(kind, params) {
  const rows = [];
  for (let t = 0; t <= 120; t += 1) {
    const frame = experimentFrame(kind, t, params);
    const sample = runChain(Object.assign(chainRequest(params, frame), {
      filterMode: "steady",
      filterState: freshFilter(),
      filterStateOxygen: freshFilter(),
      noiseRms: kind === "exp4" ? 5 : 0,
      oxygenNoiseRms: kind === "exp4" ? 5 : 0
    }));
    sample.t = t;
    rows.push(sample);
  }
  return rows;
}

const ExperimentEngine = { run: runExperiment, frame: experimentFrame };

function chainRequest(params, frame) {
  return {
    glucose: frame.glucose,
    sensitivity: params.sensitivity,
    baseline: params.baseline,
    drift: frame.drift != null ? frame.drift : params.drift,
    noiseNa: frame.noiseNa,
    noiseRms: params.noiseRms,
    tempC: frame.tempC != null ? frame.tempC : params.tempC,
    tempCoeff: params.tempCoeff,
    vref: params.vref,
    rf: params.rf,
    cf: params.cf,
    vcc: params.vcc,
    adcBits: params.adcBits,
    adcVref: params.adcVref,
    dt: CONFIG.dt,
    oxygenLevel: frame.oxygenLevel != null ? frame.oxygenLevel : params.oxygenLevel,
    oxygenSensitivity: params.oxygenSensitivity,
    oxygenBaseline: params.oxygenBaseline,
    oxygenDrift: frame.oxygenDrift != null ? frame.oxygenDrift : params.oxygenDrift,
    oxygenNoiseNa: frame.oxygenNoiseNa,
    oxygenNoiseRms: params.oxygenNoiseRms,
    oxygenVref: params.oxygenVref,
    oxygenRf: params.oxygenRf,
    oxygenCf: params.oxygenCf,
    oxygenInfluenceEnabled: params.oxygenInfluenceEnabled,
    oxygenInfluenceCoeff: params.oxygenInfluenceCoeff
  };
}

/* ============================================================
   VALIDATION
   ============================================================ */

function nominalInput(overrides) {
  return Object.assign({
    glucose: 200,
    sensitivity: 1,
    baseline: 0,
    drift: 0,
    noiseNa: 0,
    tempC: 37,
    tempCoeff: 0,
    vref: 1.65,
    rf: 1e6,
    cf: 100e-9,
    vcc: 3.3,
    adcBits: 12,
    adcVref: 3.3,
    filterMode: "steady",
    filterState: { value: null, initialized: false },
    dt: 0.1
  }, overrides || {});
}

function runSelfTests() {
  const results = [];
  function check(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });
  }

  const nominal = runChain(nominalInput());
  check("Sensor current is 200 nA", Math.abs(nominal.iPhysical - 200) < 1e-6, nominal.iPhysical);
  check("TIA VOUT displays 1.850 V", nominal.tia.ideal.toFixed(3) === "1.850", nominal.tia.ideal);
  check("TIA is within 1 nV of 1.850 V", Math.abs(nominal.tia.ideal - 1.85) < 1e-9, nominal.tia.ideal);
  check("ADC 12-bit count is 2296", nominal.adc.count === 2296, nominal.adc.count);
  check("Recovered current is about 200 nA", Math.abs(nominal.iRecovered - 200) < 0.5, nominal.iRecovered);
  check("Estimated glucose is about 200 mg/dL", Math.abs(nominal.glucoseEst - 200) < 0.5, nominal.glucoseEst);
  check("Nominal path is not saturated", nominal.tia.saturated === false, "");
  check("Nominal path has no NaN", [
    nominal.iPhysical, nominal.tia.ideal, nominal.vFiltered, nominal.adc.count,
    nominal.vAdc, nominal.iRecovered, nominal.glucoseEst, nominal.error
  ].every(Number.isFinite), "");
  check("fc is about 1.59 Hz", Math.abs(nominal.cutoff.fc - 1.5915494309189535) < 1e-9, nominal.cutoff.fc);
  check("Quantization stays inside 0.5 LSB", nominal.quantErrorV < 0.5 * nominal.adc.lsb, nominal.quantErrorV);

  const roundTrip = recoverCurrent(1.85, 1.65, 1e6);
  check("200 nA round-trips through 1 MΩ", Math.abs(roundTrip - 200) < 1e-6, roundTrip);

  const filterState = { value: 1.65, initialized: true };
  const y1 = applyLowPassFilter(filterState, 1.85, 1e6, 100e-9, 0.1);
  const y2 = applyLowPassFilter(filterState, 1.85, 1e6, 100e-9, 0.1);
  check("Low-pass first step is 1.75 V", Math.abs(y1 - 1.75) < 1e-9, y1);
  check("Low-pass second step is 1.80 V", Math.abs(y2 - 1.8) < 1e-9, y2);

  const satHigh = calculateTIAOutput(200, 1.65, 1e7, 3.3);
  check("10 MΩ at 200 nA saturates", satHigh.saturated === true && satHigh.clamped === 3.3, satHigh.ideal);
  const satLow = calculateTIAOutput(-2000, 1.65, 1e6, 3.3);
  check("Negative current can saturate low", satLow.saturated === true && satLow.clamped === 0, satLow.ideal);

  const clipHigh = voltageToADC(4, 12, 3.3);
  const clipLow = voltageToADC(-0.2, 12, 3.3);
  check("ADC clips high", clipHigh.clipped && clipHigh.count === 4095, clipHigh.count);
  check("ADC clips low", clipLow.clipped && clipLow.count === 0, clipLow.count);
  check("Zero sensitivity is guarded", Number.isNaN(currentToGlucose(10, 0, 0, 0)), "");
  check("Zero RF is guarded", Number.isNaN(calculateTIAOutput(200, 1.65, 0, 3.3).ideal), "");
  check("Temperature coefficient 0 is identity", Math.abs(temperatureFactor(42, 0) - 1) < 1e-12, "");

  const temp = runChain(nominalInput({ tempC: 40, tempCoeff: 2 }));
  check("Temperature path cancels at DC", Math.abs(temp.glucoseEst - 200) < 0.5, temp.glucoseEst);
  check("Physical current rose with +2 %/°C", temp.iPhysical > 205 && temp.iPhysical < 215, temp.iPhysical);

  let sweepOk = true;
  let sweepDetail = "";
  CONFIG.sweepGlucose.forEach((g) => {
    const row = runChain(nominalInput({ glucose: g }));
    if (!Number.isFinite(row.glucoseEst) || row.tia.saturated || !(row.absError < 0.5)) {
      sweepOk = false;
      sweepDetail = g + " mg/dL error " + row.absError;
    }
  });
  check("Nominal sweep error stays under 0.5 mg/dL", sweepOk, sweepDetail);

  check("Rising scenario stays inside 40–400", scenarioInRange("rising"), "");
  check("Falling scenario stays inside 40–400", scenarioInRange("falling"), "");
  check("Meal scenario stays inside 40–400", scenarioInRange("meal"), "");
  check("Rapid scenario stays inside 40–400", scenarioInRange("rapid"), "");
  check("Rising starts at 80 and ends at 300", scenarioGlucose("rising", 0, 200) === 80 && scenarioGlucose("rising", 120, 200) === 300, "");

  const z = gaussianNoise(() => 0.5);
  check("Box-Muller matches a known sample", Math.abs(z - (-1.1774100225154747)) < 1e-9, z);
  check("Box-Muller fallback avoids a hang", gaussianNoise(() => 0) === 0, "");

  const metrics = calculateMetrics([
    { error: 1, quantErrorV: 1e-4 },
    { error: -3, quantErrorV: 3e-4 },
    { error: NaN, quantErrorV: NaN }
  ], 2);
  check("Metrics ignore NaN and count saturation", metrics.n === 2 && metrics.meanError === -1 && metrics.mae === 2 && Math.abs(metrics.rmse - Math.sqrt(5)) < 1e-12 && metrics.maxError === 3 && metrics.saturationCount === 2, "");

  const lowOxygen = runChain(nominalInput({ oxygenLevel: 0 }));
  const highOxygen = runChain(nominalInput({ oxygenLevel: 100 }));
  check(
    "Oxygen influence OFF leaves estimated glucose unchanged",
    Math.abs(lowOxygen.glucoseEst - highOxygen.glucoseEst) < 1e-9
      && Math.abs(lowOxygen.iPhysical - highOxygen.iPhysical) < 1e-9
      && lowOxygen.oxygenInfluenceActive === false,
    lowOxygen.glucoseEst + " vs " + highOxygen.glucoseEst
  );

  const cold = runChain(nominalInput({ tempC: 30, tempCoeff: 0 }));
  const warm = runChain(nominalInput({ tempC: 42, tempCoeff: 0 }));
  check(
    "Temperature coefficient 0 leaves estimated glucose unchanged",
    Math.abs(cold.glucoseEst - warm.glucoseEst) < 1e-9 && Math.abs(cold.iPhysical - warm.iPhysical) < 1e-9,
    cold.iPhysical + " vs " + warm.iPhysical
  );

  const split = runChain(nominalInput({
    oxygenLevel: 100,
    oxygenSensitivity: 20,
    oxygenRf: 1e7
  }));
  check(
    "Oxygen TIA saturation does not mark the glucose TIA",
    split.oxygen.tia.saturated === true && split.tia.saturated === false,
    "glucose " + split.tia.ideal.toFixed(3) + " V · oxygen " + split.oxygen.tia.ideal.toFixed(3) + " V"
  );
  check(
    "ADC CH1 and ADC CH2 are independent",
    split.adc.count === 2296 && split.oxygen.adc.count === 4095 && split.adc.count !== split.oxygen.adc.count,
    split.adc.count + " vs " + split.oxygen.adc.count
  );

  const glucoseFilter = { value: 1.65, initialized: true };
  const oxygenFilter = { value: 1.65, initialized: true };
  const stepped = runChain(nominalInput({
    filterMode: "step",
    filterState: glucoseFilter,
    filterStateOxygen: oxygenFilter,
    oxygenLevel: 0
  }));
  check(
    "Glucose and oxygen filters keep separate state",
    Math.abs(stepped.vFiltered - 1.75) < 1e-6 && Math.abs(stepped.oxygen.vFiltered - 1.65) < 1e-6,
    stepped.vFiltered + " / " + stepped.oxygen.vFiltered
  );
  check("Nominal signal quality is GOOD", nominal.signalQuality === "GOOD", nominal.signalQuality);
  check(
    "Nominal oxygen channel is 50 sim and not saturated",
    Math.abs(nominal.oxygen.level - 50) < 1e-9 && Math.abs(nominal.oxygen.iRaw - 50) < 1e-9 && nominal.oxygen.tia.saturated === false,
    nominal.oxygen.iRaw
  );

  const influenced = runChain(nominalInput({
    oxygenLevel: 100,
    oxygenInfluenceEnabled: true,
    oxygenInfluenceCoeff: 5
  }));
  check(
    "Oxygen influence ON is provisional and changes glucose current",
    influenced.oxygenInfluenceActive === true && influenced.iPhysical > nominal.iPhysical,
    influenced.iPhysical
  );

  const expRows = ExperimentEngine.run("exp1", {
    sensitivity: 1,
    baseline: 0,
    drift: 0,
    noiseRms: 0,
    tempC: 37,
    tempCoeff: 0,
    vref: 1.65,
    rf: 1e6,
    cf: 100e-9,
    vcc: 3.3,
    adcBits: 12,
    adcVref: 3.3,
    oxygenLevel: 50,
    oxygenSensitivity: 1,
    oxygenBaseline: 0,
    oxygenDrift: 0,
    oxygenNoiseRms: 0,
    oxygenVref: 1.65,
    oxygenRf: 1e6,
    oxygenCf: 100e-9,
    oxygenInfluenceEnabled: false,
    oxygenInfluenceCoeff: 5
  });
  check(
    "Experiment 1 varies oxygen and holds estimated glucose",
    expRows.length === 121
      && expRows[0].oxygen.level === 0
      && expRows[expRows.length - 1].oxygen.level === 100
      && expRows.every((row) => Math.abs(row.glucoseEst - nominal.glucoseEst) < 1e-6 && row.glucose === 200 && row.tempC === 37),
    expRows.length
  );

  const session120 = buildRecordedSession(120, null, { now: new Date("2026-09-29T10:00:00"), id: "BS-TEST-120" });
  check(
    "A 120 s session at 0.1 s has 1201 samples",
    session120.samples.length === 1201 && session120.samples[0].time_s === 0 && session120.samples[1200].time_s === 120,
    session120.samples.length
  );
  const rawLines = buildRawCsv(session120).split("\n");
  check("Raw CSV has one data row per sample", rawLines.length === session120.samples.length + 1, rawLines.length);
  const jsonObject = buildSessionJson(session120);
  check("JSON has the same sample count", jsonObject.samples.length === session120.samples.length, jsonObject.samples.length);
  check(
    "Session metrics use the full run",
    session120.metrics.sample_count === 1201 && session120.metrics.glucose.mae_mgdl != null,
    session120.metrics.sample_count
  );
  const first = session120.samples[0];
  check("Ideal session glucose TIA is 1.850 V", Number(first.tia_vout_v).toFixed(3) === "1.850", first.tia_vout_v);
  check("Ideal session glucose ADC is 2296", first.adc_count === 2296, first.adc_count);
  check("Ideal session estimated glucose is about 200.256 mg/dL", Math.abs(first.estimated_glucose_mgdl - 200.256) < 0.01, first.estimated_glucose_mgdl);
  check("Ideal session oxygen TIA is 1.700 V", Number(first.oxygen_tia_vout_v).toFixed(3) === "1.700", first.oxygen_tia_vout_v);
  check("Ideal session oxygen ADC is 2110", first.oxygen_adc_count === 2110, first.oxygen_adc_count);
  check("Ideal session recovered oxygen is about 50.37 sim", Math.abs(first.oxygen_recovered_level_sim - 50.37) < 0.02, first.oxygen_recovered_level_sim);

  const pauseSession = createSimulationSession(controlParamsFromNominal(), { now: new Date("2026-09-29T10:00:00"), id: "BS-PAUSE" });
  recordSessionSample(pauseSession, runChain(nominalInput()), controlParamsFromNominal());
  pauseSession.samples[0].time_s = 0;
  pauseSession.status = "paused";
  const pausedCount = pauseSession.samples.length;
  check("PAUSE does not clear session samples", pausedCount === 1 && pauseSession.status === "paused", pausedCount);
  finalizeSimulationSession(pauseSession, "stopped");
  check("STOP & ANALYZE keeps the recorded samples", pauseSession.samples.length === 1 && pauseSession.status === "stopped" && pauseSession.metrics.sample_count === 1, pauseSession.samples.length);

  const emptySession = createSimulationSession(controlParamsFromNominal(), { id: "BS-NEW" });
  check("A new session does not mix previous samples", emptySession.id !== pauseSession.id && emptySession.samples.length === 0, emptySession.samples.length);
  check("RESET warns when results are unexported", sessionNeedsExportWarning(pauseSession) === true, "");
  pauseSession.exported = true;
  check("RESET does not warn after export", sessionNeedsExportWarning(pauseSession) === false, "");
  check("RESET does not warn on an empty session", sessionNeedsExportWarning(emptySession) === false, "");

  const dirty = buildRecordedSession(0.1, null, { now: new Date("2026-09-29T10:00:00"), id: "BS-JSON" });
  dirty.samples[0].estimated_glucose_mgdl = NaN;
  dirty.samples[0].error_mgdl = Infinity;
  const jsonText = sessionJsonString(dirty);
  const parsed = JSON.parse(jsonText);
  check(
    "JSON never contains NaN or Infinity",
    !jsonContainsNonFinite(jsonText) && parsed.samples[0].estimated_glucose_mgdl === null && parsed.samples[0].error_mgdl === null,
    jsonText.slice(0, 80)
  );
  const report = buildHtmlReport(dirty, {});
  check("HTML report is standalone", report.indexOf("BIOSENSE SIMULATOR") >= 0 && report.indexOf("SIMULATION ONLY") >= 0 && report.indexOf("<svg") >= 0, "");
  const pdfBytes = buildSessionPdf(session120, []);
  let pdfText = "";
  for (let i = 0; i < Math.min(pdfBytes.length, 8000); i += 1) pdfText += String.fromCharCode(pdfBytes[i]);
  check(
    "PDF report is a single standalone file",
    pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50 && pdfBytes[2] === 0x44 && pdfBytes[3] === 0x46
      && pdfText.indexOf("BIOSENSE SIMULATOR") >= 0
      && pdfText.indexOf("NOT FOR MEDICAL USE") >= 0
      && pdfText.indexOf("1201") >= 0,
    pdfBytes.length
  );

  const longSession = createSimulationSession(controlParamsFromNominal(), { id: "BS-LONG" });
  const longSample = runChain(nominalInput());
  const longParams = controlParamsFromNominal();
  for (let i = 0; i < 1500; i += 1) {
    longSample.t = Math.round(i * 0.1 * 10) / 10;
    recordSessionSample(longSession, longSample, longParams);
  }
  finalizeSimulationSession(longSession, "stopped");
  const trimmed = longSession.samples.map((row) => ({ t: row.time_s, error: row.error_mgdl }));
  trimHistory(trimmed, 149.9, 120);
  check(
    "Full-session metrics are not limited to the 120 s chart buffer",
    longSession.metrics.sample_count === 1500 && trimmed.length <= 1201 && trimmed.length < 1500,
    longSession.metrics.sample_count + " vs trimmed " + trimmed.length
  );

  const history = [];
  for (let i = 0; i <= 1500; i += 1) history.push({ t: Math.round(i * 0.1 * 10) / 10, error: 1 });
  trimHistory(history, 150, 120);
  check(
    "History buffer covers 120 s and does not grow without bound",
    history.length > 0 && history[0].t >= 30 && history[history.length - 1].t === 150 && history.length <= 1201,
    history.length + " samples from " + history[0].t
  );

  check(
    "Nominal 200 mg/dL path is unchanged",
    Math.abs(nominal.glucose - 200) < 1e-12
      && nominal.tia.ideal.toFixed(3) === "1.850"
      && nominal.adc.count === 2296
      && Math.abs(session120.samples[0].estimated_glucose_mgdl - 200.256) < 0.01,
    session120.samples[0].estimated_glucose_mgdl
  );
  check(
    "Full-session capture still has 1201 samples at 0.1 s",
    session120.samples.length === 1201,
    session120.samples.length
  );
  check(
    "Stable 200 mg/dL session has zero step events",
    session120.transientAnalysis.summary.step_count === 0
      && session120.transientAnalysis.events.length === 0,
    session120.transientAnalysis.summary.step_count
  );

  function synthPairs(from, to, directionLabel) {
    const rows = [];
    for (let i = 0; i <= 80; i += 1) {
      const t = Math.round(i * 0.1 * 10) / 10;
      const stepped = t >= 2;
      const actual = stepped ? to : from;
      const u = stepped ? Math.min(1, (t - 2) / 1.5) : 0;
      const est = from + (to - from) * u;
      rows.push({
        time_s: t,
        actual_glucose_mgdl: actual,
        estimated_glucose_mgdl: est,
        error_mgdl: est - actual
      });
    }
    return { rows: rows, directionLabel: directionLabel };
  }
  const risingSynth = analyzeTransientResponse(synthPairs(80, 220, "rising").rows, { sampleIntervalS: 0.1 });
  const fallingSynth = analyzeTransientResponse(synthPairs(220, 80, "falling").rows, { sampleIntervalS: 0.1 });
  check("Synthetic single step detects exactly one event", risingSynth.summary.step_count === 1 && risingSynth.events.length === 1, risingSynth.summary.step_count);
  check("Rising step direction is rising", risingSynth.events[0] && risingSynth.events[0].direction === "rising", risingSynth.events[0] && risingSynth.events[0].direction);
  check("Falling step direction is falling", fallingSynth.events[0] && fallingSynth.events[0].direction === "falling", fallingSynth.events[0] && fallingSynth.events[0].direction);

  const rapidSession = buildScenarioSession("rapid", 120, { now: new Date("2026-09-29T10:00:00"), id: "BS-RAPID" });
  const rapidTimes = rapidSession.transientAnalysis.events.map((ev) => ev.start_time_s);
  const expectedRapid = [];
  for (let t = 10; t <= 120; t += 10) expectedRapid.push(t);
  const rapidTimesOk = rapidTimes.length === expectedRapid.length && rapidTimes.every((t, i) => Math.abs(t - expectedRapid[i]) < 0.15);
  check(
    "Rapid scenario detects discrete steps at 10 s boundaries",
    rapidTimesOk && rapidSession.transientAnalysis.summary.step_count === 12,
    rapidTimes.join(",")
  );

  const risingSession = buildScenarioSession("rising", 120, { now: new Date("2026-09-29T10:00:00"), id: "BS-RISE" });
  check(
    "Smooth rising scenario does not produce a step storm",
    risingSession.transientAnalysis.summary.step_count === 0,
    risingSession.transientAnalysis.summary.step_count
  );

  function valuesFiniteOrNull(obj) {
    if (obj == null) return true;
    if (typeof obj === "number") return Number.isFinite(obj);
    if (Array.isArray(obj)) return obj.every(valuesFiniteOrNull);
    if (typeof obj === "object") return Object.keys(obj).every((key) => valuesFiniteOrNull(obj[key]));
    return true;
  }
  const settleOk = rapidSession.transientAnalysis.events.every((ev) => (
    (ev.settling_time_5mg_s == null || Number.isFinite(ev.settling_time_5mg_s))
    && (ev.settling_time_2pct_s == null || Number.isFinite(ev.settling_time_2pct_s))
    && ev.settling_time_5mg_s !== Infinity
    && !Number.isNaN(ev.settling_time_5mg_s)
  ));
  const riseFallOk = rapidSession.transientAnalysis.events.every((ev) => (
    (ev.rise_time_10_90_s == null || Number.isFinite(ev.rise_time_10_90_s))
    && (ev.fall_time_90_10_s == null || Number.isFinite(ev.fall_time_90_10_s))
  ));
  check("Settling times are finite or null", settleOk && valuesFiniteOrNull(rapidSession.transientAnalysis), "");
  check("Rise/fall times are finite or null", riseFallOk, "");

  const rapidJson = sessionJsonString(rapidSession);
  const parsedRapid = JSON.parse(rapidJson);
  check(
    "JSON with transient analysis contains no NaN or Infinity",
    !jsonContainsNonFinite(rapidJson)
      && parsedRapid.transientAnalysis
      && parsedRapid.trackingAnalysis
      && parsedRapid.transientAnalysis.summary.step_count === 12,
    ""
  );
  const summaryText = buildSummaryCsv(session120);
  check(
    "Summary CSV contains new transient fields",
    summaryText.indexOf("step_count") >= 0
      && summaryText.indexOf("Transient") >= 0
      && summaryText.indexOf("best_fit_lag") >= 0,
    ""
  );
  const transLines = buildTransitionsCsv(rapidSession).split("\n");
  check(
    "Transitions CSV row count equals events plus header",
    transLines.length === rapidSession.transientAnalysis.events.length + 1,
    transLines.length
  );
  const zeroTrans = buildTransitionsCsv(session120).split("\n");
  check(
    "Zero-transition session still exports header-only transitions CSV",
    zeroTrans.length === 1 && zeroTrans[0].indexOf("event_id") >= 0,
    zeroTrans.length
  );
  const zeroHtml = buildHtmlReport(session120, {});
  check(
    "HTML report still works with zero transitions",
    zeroHtml.indexOf("TRANSIENT RESPONSE") >= 0 && zeroHtml.indexOf("No discrete glucose steps detected") >= 0,
    ""
  );
  const pdfAgain = buildSessionPdf(session120, []);
  check(
    "PDF generation still starts with a valid %PDF signature",
    pdfAgain[0] === 0x25 && pdfAgain[1] === 0x50 && pdfAgain[2] === 0x44 && pdfAgain[3] === 0x46,
    pdfAgain.length
  );
  const rapidPdf = buildSessionPdf(rapidSession, []);
  check(
    "Rapid-session PDF remains a valid standalone file",
    rapidPdf[0] === 0x25 && rapidPdf[1] === 0x50 && rapidPdf[2] === 0x44 && rapidPdf[3] === 0x46,
    rapidPdf.length
  );

  return { pass: results.every((item) => item.pass), results, nominal };
}

function scenarioInRange(name) {
  for (let t = 0; t <= 180; t += 5) {
    const g = scenarioGlucose(name, t, 200);
    if (g < 40 || g > 400 || !Number.isFinite(g)) return false;
  }
  return true;
}

/* ============================================================
   SIMULATION ENGINE
   ============================================================ */

function trimHistory(history, latestT, seconds) {
  const minT = latestT - seconds;
  let drop = 0;
  while (drop < history.length && history[drop].t < minT) drop += 1;
  if (drop > 0) history.splice(0, drop);
}

/* ============================================================
   SIMULATION SESSION
   Full-run capture. Independent from the 120 s chart buffer.
   ============================================================ */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatFileStamp(date) {
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
    + "_" + pad2(date.getHours()) + "-" + pad2(date.getMinutes()) + "-" + pad2(date.getSeconds());
}

function newSimulationId(date) {
  const compact = date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate())
    + "-" + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
  const rand = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return "BS-" + compact + "-" + rand;
}

function jsonSafe(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach((key) => { out[key] = jsonSafe(value[key]); });
    return out;
  }
  return value;
}

function jsonContainsNonFinite(text) {
  return /[:\[]\s*(NaN|-?Infinity)/.test(text) || /:\s*"?NaN"?/.test(text);
}

function sessionControlParams(params) {
  const rf = Number.isFinite(params.rf) ? params.rf : 1e6;
  const cf = Number.isFinite(params.cf) ? params.cf : 100e-9;
  const vref = Number.isFinite(params.vref) ? params.vref : 1.65;
  return {
    scenario: params.scenario || "stable",
    sensitivity: params.sensitivity,
    baseline: params.baseline,
    drift: params.drift,
    noiseRms: Number.isFinite(params.noiseRms) ? params.noiseRms : 0,
    tempC: params.tempC,
    tempCoeff: params.tempCoeff,
    vref: vref,
    rf: rf,
    cf: cf,
    vcc: Number.isFinite(params.vcc) ? params.vcc : CONFIG.vcc,
    adcBits: params.adcBits,
    adcVref: params.adcVref,
    oxygenLevel: Number.isFinite(params.oxygenLevel) ? params.oxygenLevel : CONFIG.oxygen.default,
    oxygenSensitivity: Number.isFinite(params.oxygenSensitivity) ? params.oxygenSensitivity : CONFIG.oxygen.sensitivity.default,
    oxygenBaseline: Number.isFinite(params.oxygenBaseline) ? params.oxygenBaseline : 0,
    oxygenDrift: Number.isFinite(params.oxygenDrift) ? params.oxygenDrift : 0,
    oxygenNoiseRms: Number.isFinite(params.oxygenNoiseRms) ? params.oxygenNoiseRms : 0,
    oxygenVref: Number.isFinite(params.oxygenVref) ? params.oxygenVref : vref,
    oxygenRf: Number.isFinite(params.oxygenRf) ? params.oxygenRf : rf,
    oxygenCf: Number.isFinite(params.oxygenCf) ? params.oxygenCf : cf,
    oxygenInfluenceEnabled: !!params.oxygenInfluenceEnabled,
    oxygenInfluenceCoeff: Number.isFinite(params.oxygenInfluenceCoeff) ? params.oxygenInfluenceCoeff : 0,
    initialGlucose: Number.isFinite(params.initialGlucose)
      ? params.initialGlucose
      : (Number.isFinite(params.glucose) ? params.glucose : CONFIG.glucose.default)
  };
}

function captureConfiguration(params) {
  const p = sessionControlParams(params);
  const glucoseCut = calculateCutoffFrequency(p.rf, p.cf);
  const oxygenCut = calculateCutoffFrequency(p.oxygenRf, p.oxygenCf);
  return {
    adc: { bits: p.adcBits, vref: p.adcVref, vcc: p.vcc },
    glucose_sensor: {
      initial_glucose_mgdl: p.initialGlucose,
      sensitivity_na_per_mgdl: p.sensitivity,
      baseline_na: p.baseline,
      noise_rms_na: p.noiseRms,
      drift_na: p.drift,
      scenario: p.scenario
    },
    glucose_tia: { vref: p.vref, rf_ohm: p.rf, cf_f: p.cf, fc_hz: glucoseCut.fc, rc_s: glucoseCut.rc },
    oxygen_sensor: {
      initial_oxygen_sim: p.oxygenLevel,
      unit: CONFIG.oxygen.unit,
      sensitivity_na_per_sim: p.oxygenSensitivity,
      baseline_na: p.oxygenBaseline,
      noise_rms_na: p.oxygenNoiseRms,
      drift_na: p.oxygenDrift,
      model: "PROVISIONAL"
    },
    oxygen_tia: { vref: p.oxygenVref, rf_ohm: p.oxygenRf, cf_f: p.oxygenCf, fc_hz: oxygenCut.fc, rc_s: oxygenCut.rc },
    temperature: {
      initial_c: p.tempC,
      coefficient_percent_per_c: p.tempCoeff,
      compensation: "PROVISIONAL"
    },
    oxygen_glucose_influence: {
      enabled: p.oxygenInfluenceEnabled,
      coefficient: p.oxygenInfluenceCoeff,
      model: "PROVISIONAL"
    }
  };
}

function createSimulationSession(params, options) {
  const now = (options && options.now) ? options.now : new Date();
  const p = sessionControlParams(params);
  return {
    id: (options && options.id) ? options.id : newSimulationId(now),
    version: CONFIG.version,
    startTime: now.toISOString(),
    endTime: null,
    fileStamp: formatFileStamp(now),
    status: "running",
    exported: false,
    sampleIntervalS: CONFIG.dt,
    configuration: captureConfiguration(p),
    samples: [],
    metrics: null,
    quality: { status: "GOOD", reasons: [] },
    transientAnalysis: null,
    trackingAnalysis: null
  };
}

function toSessionRecord(sample, params) {
  const p = sessionControlParams(params || {});
  const oxygen = sample.oxygen || {};
  const tia = sample.tia || {};
  const adc = sample.adc || {};
  const oTia = oxygen.tia || {};
  const oAdc = oxygen.adc || {};
  const tempAdc = sample.temperature && sample.temperature.adc ? sample.temperature.adc.count : null;
  return {
    time_s: sample.t,
    actual_glucose_mgdl: sample.glucose,
    sensor_current_na: sample.iPhysical,
    tia_vout_v: tia.saturated ? tia.clamped : tia.ideal,
    filtered_vout_v: sample.vFiltered,
    adc_count: adc.count,
    adc_voltage_v: sample.vAdc,
    recovered_current_na: sample.iRecovered,
    estimated_glucose_mgdl: sample.glucoseEst,
    error_mgdl: sample.error,
    error_percent: sample.pctError,
    oxygen_level_sim: oxygen.level,
    oxygen_sensor_current_na: oxygen.iPhysical,
    oxygen_tia_vout_v: oTia.saturated ? oTia.clamped : oTia.ideal,
    oxygen_filtered_vout_v: oxygen.vFiltered,
    oxygen_adc_count: oAdc.count,
    oxygen_adc_voltage_v: oxygen.vAdc,
    oxygen_recovered_current_na: oxygen.iRecovered,
    oxygen_recovered_level_sim: oxygen.oxygenEst,
    temperature_c: sample.tempC,
    temperature_adc_count: tempAdc,
    glucose_noise_rms_na: p.noiseRms,
    glucose_drift_na: p.drift,
    oxygen_noise_rms_na: p.oxygenNoiseRms,
    oxygen_drift_na: p.oxygenDrift,
    temperature_coefficient: p.tempCoeff,
    oxygen_influence_enabled: p.oxygenInfluenceEnabled,
    oxygen_influence_coefficient: p.oxygenInfluenceCoeff,
    signal_quality: sample.signalQuality,
    glucose_tia_saturated: !!tia.saturated,
    oxygen_tia_saturated: !!oTia.saturated,
    glucose_adc_clipped: !!adc.clipped,
    oxygen_adc_clipped: !!oAdc.clipped,
    glucose_quant_error_v: sample.quantErrorV
  };
}

function recordSessionSample(session, sample, params) {
  if (!session || session.status === "stopped" || session.status === "complete") return;
  session.samples.push(toSessionRecord(sample, params));
}

function finiteList(samples, key) {
  const out = [];
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i][key];
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function statsOf(values) {
  if (!values.length) return { n: 0, mean: null, min: null, max: null, std: null };
  let sum = 0;
  let min = values[0];
  let max = values[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = sum / values.length;
  let sq = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return { n: values.length, mean: mean, min: min, max: max, std: Math.sqrt(sq / values.length) };
}

function countTrue(samples, key) {
  let n = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i][key]) n += 1;
  }
  return n;
}

function calculateSessionMetrics(samples) {
  const glucoseError = finiteList(samples, "error_mgdl");
  const glucoseAbs = glucoseError.map(Math.abs);
  const glucoseEst = finiteList(samples, "estimated_glucose_mgdl");
  const actual = finiteList(samples, "actual_glucose_mgdl");
  const oxygenErr = [];
  for (let i = 0; i < samples.length; i += 1) {
    const row = samples[i];
    if (Number.isFinite(row.oxygen_level_sim) && Number.isFinite(row.oxygen_recovered_level_sim)) {
      oxygenErr.push(row.oxygen_recovered_level_sim - row.oxygen_level_sim);
    }
  }
  const oxygenAbs = oxygenErr.map(Math.abs);
  const gEst = statsOf(glucoseEst);
  const oLevel = statsOf(finiteList(samples, "oxygen_level_sim"));
  const oRec = statsOf(finiteList(samples, "oxygen_recovered_level_sim"));
  const temp = statsOf(finiteList(samples, "temperature_c"));
  const mae = glucoseAbs.length ? glucoseAbs.reduce((a, b) => a + b, 0) / glucoseAbs.length : null;
  const rmse = glucoseError.length
    ? Math.sqrt(glucoseError.reduce((a, b) => a + b * b, 0) / glucoseError.length)
    : null;
  const oMae = oxygenAbs.length ? oxygenAbs.reduce((a, b) => a + b, 0) / oxygenAbs.length : null;
  const oRmse = oxygenErr.length
    ? Math.sqrt(oxygenErr.reduce((a, b) => a + b * b, 0) / oxygenErr.length)
    : null;
  return {
    sample_count: samples.length,
    glucose: {
      mean_actual_mgdl: statsOf(actual).mean,
      mean_estimated_mgdl: gEst.mean,
      mean_error_mgdl: statsOf(glucoseError).mean,
      mae_mgdl: mae,
      rmse_mgdl: rmse,
      max_abs_error_mgdl: glucoseAbs.length ? Math.max.apply(null, glucoseAbs) : null,
      min_estimated_mgdl: gEst.min,
      max_estimated_mgdl: gEst.max,
      std_estimated_mgdl: gEst.std,
      mean_sensor_current_na: statsOf(finiteList(samples, "sensor_current_na")).mean,
      mean_recovered_current_na: statsOf(finiteList(samples, "recovered_current_na")).mean,
      mean_tia_vout_v: statsOf(finiteList(samples, "tia_vout_v")).mean,
      mean_filtered_vout_v: statsOf(finiteList(samples, "filtered_vout_v")).mean,
      adc_min: statsOf(finiteList(samples, "adc_count")).min,
      adc_max: statsOf(finiteList(samples, "adc_count")).max,
      mean_adc_count: statsOf(finiteList(samples, "adc_count")).mean,
      mean_quantization_error_v: statsOf(finiteList(samples, "glucose_quant_error_v")).mean,
      tia_saturation_count: countTrue(samples, "glucose_tia_saturated"),
      adc_clipping_count: countTrue(samples, "glucose_adc_clipped")
    },
    oxygen: {
      mean_level_sim: oLevel.mean,
      mean_recovered_sim: oRec.mean,
      mae_sim: oMae,
      rmse_sim: oRmse,
      mean_sensor_current_na: statsOf(finiteList(samples, "oxygen_sensor_current_na")).mean,
      mean_recovered_current_na: statsOf(finiteList(samples, "oxygen_recovered_current_na")).mean,
      mean_tia_vout_v: statsOf(finiteList(samples, "oxygen_tia_vout_v")).mean,
      mean_filtered_vout_v: statsOf(finiteList(samples, "oxygen_filtered_vout_v")).mean,
      adc_min: statsOf(finiteList(samples, "oxygen_adc_count")).min,
      adc_max: statsOf(finiteList(samples, "oxygen_adc_count")).max,
      mean_adc_count: statsOf(finiteList(samples, "oxygen_adc_count")).mean,
      tia_saturation_count: countTrue(samples, "oxygen_tia_saturated"),
      adc_clipping_count: countTrue(samples, "oxygen_adc_clipped")
    },
    temperature: {
      mean_c: temp.mean,
      min_c: temp.min,
      max_c: temp.max
    }
  };
}

/* ============================================================
   TRANSIENT / TRACKING ANALYSIS
   Pure post-run metrics. Does not change sensor or electronics math.
   ============================================================ */

function analysisFinite(value) {
  return Number.isFinite(value) ? value : null;
}

function analysisMean(values) {
  const finite = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  if (!finite.length) return null;
  let sum = 0;
  for (let i = 0; i < finite.length; i += 1) sum += finite[i];
  return sum / finite.length;
}

function analysisMax(values) {
  const finite = [];
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  if (!finite.length) return null;
  return Math.max.apply(null, finite);
}

function inferAnalysisDt(samples, fallback) {
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  if (samples && samples.length >= 2) {
    const dt = samples[1].time_s - samples[0].time_s;
    if (Number.isFinite(dt) && dt > 0) return dt;
  }
  return CONFIG.dt;
}

function sampleSignedError(row) {
  if (!row) return null;
  if (Number.isFinite(row.error_mgdl)) return row.error_mgdl;
  if (Number.isFinite(row.estimated_glucose_mgdl) && Number.isFinite(row.actual_glucose_mgdl)) {
    return row.estimated_glucose_mgdl - row.actual_glucose_mgdl;
  }
  return null;
}

function interpolateLevelTime(t0, y0, t1, y1, level) {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(level)) {
    return null;
  }
  if (y1 === y0) return Math.abs(y0 - level) <= 1e-12 ? t0 : null;
  const u = (level - y0) / (y1 - y0);
  if (u < -1e-12 || u > 1 + 1e-12) return null;
  const t = t0 + Math.min(1, Math.max(0, u)) * (t1 - t0);
  return Number.isFinite(t) ? t : null;
}

function firstLevelCrossing(window, level, afterTime, rising) {
  if (!window || !window.length || !Number.isFinite(level)) return null;
  const startT = Number.isFinite(afterTime) ? afterTime : -Infinity;
  for (let i = 1; i < window.length; i += 1) {
    const t0 = window[i - 1].time_s;
    const t1 = window[i].time_s;
    const y0 = window[i - 1].estimated_glucose_mgdl;
    const y1 = window[i].estimated_glucose_mgdl;
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if (t1 + 1e-12 < startT) continue;
    const crossed = rising
      ? ((y0 < level && y1 >= level) || (y0 <= level && y1 > level))
      : ((y0 > level && y1 <= level) || (y0 >= level && y1 < level));
    if (!crossed) continue;
    const tc = interpolateLevelTime(t0, y0, t1, y1, level);
    if (tc == null || tc + 1e-12 < startT) continue;
    return tc;
  }
  for (let i = 0; i < window.length; i += 1) {
    const t = window[i].time_s;
    const y = window[i].estimated_glucose_mgdl;
    if (!Number.isFinite(t) || t + 1e-12 < startT || !Number.isFinite(y)) continue;
    if (rising ? y >= level : y <= level) return Math.max(t, startT);
    break;
  }
  return null;
}

function measureHoldSettling(window, target, band, holdS, dt) {
  if (!window || !window.length || !Number.isFinite(target) || !Number.isFinite(band) || !(holdS > 0) || !(dt > 0)) {
    return { time: null, completeIndex: -1 };
  }
  const required = Math.max(1, Math.round(holdS / dt));
  const t0 = window[0].time_s;
  let runStart = -1;
  for (let i = 0; i < window.length; i += 1) {
    const est = window[i].estimated_glucose_mgdl;
    const inBand = Number.isFinite(est) && Math.abs(est - target) <= band + 1e-12;
    if (inBand) {
      if (runStart < 0) runStart = i;
      if (i - runStart + 1 >= required) {
        const settle = Number.isFinite(window[i].time_s) && Number.isFinite(t0) ? window[i].time_s - t0 : null;
        return { time: analysisFinite(settle), completeIndex: i };
      }
    } else {
      runStart = -1;
    }
  }
  return { time: null, completeIndex: -1 };
}

function emptyTransientSummary() {
  return {
    step_count: 0,
    settled_5mg_count: 0,
    unsettled_5mg_count: 0,
    mean_settling_time_5mg_s: null,
    max_settling_time_5mg_s: null,
    mean_settling_time_2pct_s: null,
    max_settling_time_2pct_s: null,
    mean_rise_time_10_90_s: null,
    mean_fall_time_90_10_s: null,
    max_peak_abs_error_mgdl: null,
    mean_event_transient_mae_mgdl: null,
    mean_event_transient_rmse_mgdl: null,
    max_overshoot_mgdl: null,
    max_undershoot_mgdl: null,
    mean_steady_state_mae_mgdl: null
  };
}

function theoreticalRcTimes(rcS) {
  if (!Number.isFinite(rcS) || rcS < 0) {
    return { tau_s: null, t63_2_s: null, t90_s: null, t95_s: null, t98_s: null };
  }
  return {
    tau_s: rcS,
    t63_2_s: rcS,
    t90_s: 2.303 * rcS,
    t95_s: 2.996 * rcS,
    t98_s: 3.912 * rcS
  };
}

function transientFilterInfo(options, dt) {
  const tia = (options && options.glucoseTia) || {};
  let rc = Number.isFinite(tia.rc_s) ? tia.rc_s : null;
  if (rc == null && Number.isFinite(tia.rf_ohm) && Number.isFinite(tia.cf_f)) rc = tia.rf_ohm * tia.cf_f;
  const cutoff = Number.isFinite(tia.rf_ohm) && Number.isFinite(tia.cf_f)
    ? calculateCutoffFrequency(tia.rf_ohm, tia.cf_f)
    : { fc: Number.isFinite(tia.fc_hz) ? tia.fc_hz : (rc > 0 ? 1 / (2 * Math.PI * rc) : NaN), rc: rc };
  const alpha = Number.isFinite(tia.rf_ohm) && Number.isFinite(tia.cf_f)
    ? filterAlpha(tia.rf_ohm, tia.cf_f, dt)
    : (Number.isFinite(rc) ? filterAlpha(1, rc, dt) : NaN);
  return {
    rc_s: analysisFinite(Number.isFinite(cutoff.rc) ? cutoff.rc : rc),
    fc_hz: analysisFinite(cutoff.fc),
    dt_s: analysisFinite(dt),
    alpha: analysisFinite(alpha),
    theoretical: theoreticalRcTimes(Number.isFinite(cutoff.rc) ? cutoff.rc : rc)
  };
}

function analyzeTransientResponse(samples, options) {
  const opts = options || {};
  const cfgT = CONFIG.transient;
  const stepThreshold = Number.isFinite(opts.stepThresholdMgDl) ? opts.stepThresholdMgDl : cfgT.stepThresholdMgDl;
  const band5 = Number.isFinite(opts.settlingBandMgDl) ? opts.settlingBandMgDl : cfgT.settlingBandMgDl;
  const pct = Number.isFinite(opts.settlingPercent) ? opts.settlingPercent : cfgT.settlingPercent;
  const holdS = Number.isFinite(opts.holdTimeS) ? opts.holdTimeS : cfgT.holdTimeS;
  const list = Array.isArray(samples) ? samples : [];
  const dt = inferAnalysisDt(list, opts.sampleIntervalS);
  const configuration = {
    step_threshold_mgdl: stepThreshold,
    settling_band_mgdl: band5,
    settling_percent: pct,
    hold_time_s: holdS
  };
  const filter = transientFilterInfo(opts, dt);
  const starts = [];
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1].actual_glucose_mgdl;
    const curr = list[i].actual_glucose_mgdl;
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
    if (Math.abs(curr - prev) >= stepThreshold) starts.push(i);
  }

  const events = [];
  for (let e = 0; e < starts.length; e += 1) {
    const startIdx = starts[e];
    const endIdx = e + 1 < starts.length ? starts[e + 1] - 1 : list.length - 1;
    const window = list.slice(startIdx, endIdx + 1);
    const crossingWindow = list.slice(startIdx - 1, endIdx + 1);
    const from = list[startIdx - 1].actual_glucose_mgdl;
    const to = list[startIdx].actual_glucose_mgdl;
    const delta = to - from;
    const direction = delta >= 0 ? "rising" : "falling";
    const startTime = list[startIdx].time_s;

    let peakAbs = null;
    let peakSigned = null;
    let peakTime = null;
    let absSum = 0;
    let sqSum = 0;
    let nErr = 0;
    let maxEst = -Infinity;
    let minEst = Infinity;
    for (let i = 0; i < window.length; i += 1) {
      const est = window[i].estimated_glucose_mgdl;
      if (Number.isFinite(est)) {
        if (est > maxEst) maxEst = est;
        if (est < minEst) minEst = est;
      }
      const signed = sampleSignedError(window[i]);
      if (!Number.isFinite(signed)) continue;
      const ae = Math.abs(signed);
      nErr += 1;
      absSum += ae;
      sqSum += signed * signed;
      if (peakAbs == null || ae > peakAbs) {
        peakAbs = ae;
        peakSigned = signed;
        peakTime = window[i].time_s;
      }
    }

    const settle5 = measureHoldSettling(window, to, band5, holdS, dt);
    const bandPct = Math.max(Math.abs(to) * (pct / 100), 1);
    const settlePct = measureHoldSettling(window, to, bandPct, holdS, dt);

    const level10 = from + 0.10 * delta;
    const level90 = from + 0.90 * delta;
    let rise = null;
    let fall = null;
    if (direction === "rising") {
      const t10 = firstLevelCrossing(crossingWindow, level10, null, true);
      const t90 = t10 == null ? null : firstLevelCrossing(crossingWindow, level90, t10, true);
      rise = t10 != null && t90 != null ? analysisFinite(t90 - t10) : null;
    } else {
      const t10 = firstLevelCrossing(crossingWindow, level10, null, false);
      const t90 = t10 == null ? null : firstLevelCrossing(crossingWindow, level90, t10, false);
      fall = t10 != null && t90 != null ? analysisFinite(t90 - t10) : null;
    }

    const overshoot = direction === "rising" && Number.isFinite(maxEst) ? Math.max(0, maxEst - to) : 0;
    const undershoot = direction === "falling" && Number.isFinite(minEst) ? Math.max(0, to - minEst) : 0;

    let ssMean = null;
    let ssMae = null;
    if (settle5.completeIndex >= 0) {
      let sSum = 0;
      let sAbs = 0;
      let sN = 0;
      for (let i = settle5.completeIndex; i < window.length; i += 1) {
        const signed = sampleSignedError(window[i]);
        if (!Number.isFinite(signed)) continue;
        sN += 1;
        sSum += signed;
        sAbs += Math.abs(signed);
      }
      if (sN) {
        ssMean = sSum / sN;
        ssMae = sAbs / sN;
      }
    }

    events.push({
      id: e + 1,
      start_time_s: analysisFinite(startTime),
      from_mgdl: analysisFinite(from),
      to_mgdl: analysisFinite(to),
      delta_mgdl: analysisFinite(delta),
      direction: direction,
      settling_time_5mg_s: settle5.time,
      settling_time_2pct_s: settlePct.time,
      rise_time_10_90_s: rise,
      fall_time_90_10_s: fall,
      peak_abs_error_mgdl: analysisFinite(peakAbs),
      peak_error_signed_mgdl: analysisFinite(peakSigned),
      peak_error_time_s: analysisFinite(peakTime),
      transient_mae_mgdl: nErr ? absSum / nErr : null,
      transient_rmse_mgdl: nErr ? Math.sqrt(sqSum / nErr) : null,
      overshoot_mgdl: analysisFinite(overshoot) == null ? 0 : overshoot,
      undershoot_mgdl: analysisFinite(undershoot) == null ? 0 : undershoot,
      steady_state_mean_error_mgdl: analysisFinite(ssMean),
      steady_state_mae_mgdl: analysisFinite(ssMae),
      status: settle5.time != null ? "SETTLED" : "NOT_SETTLED_BEFORE_NEXT_STEP"
    });
  }

  const summary = emptyTransientSummary();
  summary.step_count = events.length;
  summary.settled_5mg_count = events.filter((ev) => ev.settling_time_5mg_s != null).length;
  summary.unsettled_5mg_count = events.length - summary.settled_5mg_count;
  if (events.length) {
    summary.mean_settling_time_5mg_s = analysisMean(events.map((ev) => ev.settling_time_5mg_s));
    summary.max_settling_time_5mg_s = analysisMax(events.map((ev) => ev.settling_time_5mg_s));
    summary.mean_settling_time_2pct_s = analysisMean(events.map((ev) => ev.settling_time_2pct_s));
    summary.max_settling_time_2pct_s = analysisMax(events.map((ev) => ev.settling_time_2pct_s));
    summary.mean_rise_time_10_90_s = analysisMean(events.map((ev) => ev.rise_time_10_90_s));
    summary.mean_fall_time_90_10_s = analysisMean(events.map((ev) => ev.fall_time_90_10_s));
    summary.max_peak_abs_error_mgdl = analysisMax(events.map((ev) => ev.peak_abs_error_mgdl));
    summary.mean_event_transient_mae_mgdl = analysisMean(events.map((ev) => ev.transient_mae_mgdl));
    summary.mean_event_transient_rmse_mgdl = analysisMean(events.map((ev) => ev.transient_rmse_mgdl));
    summary.max_overshoot_mgdl = analysisMax(events.map((ev) => ev.overshoot_mgdl));
    summary.max_undershoot_mgdl = analysisMax(events.map((ev) => ev.undershoot_mgdl));
    summary.mean_steady_state_mae_mgdl = analysisMean(events.map((ev) => ev.steady_state_mae_mgdl));
  }

  return {
    version: 1,
    configuration: configuration,
    summary: summary,
    events: events,
    filter: filter,
    interpretation: "Step-response metrics characterize the simulated electronic/filter chain under artificial instantaneous glucose changes. Real electrochemical sensor dynamics are not yet modeled."
  };
}

function analyzeContinuousTracking(samples, options) {
  const opts = options || {};
  const cfgT = CONFIG.transient;
  const rateTh = Number.isFinite(opts.trackingRateThreshold) ? opts.trackingRateThreshold : cfgT.trackingRateThreshold;
  const lagMax = Number.isFinite(opts.lagMaxS) ? opts.lagMaxS : cfgT.lagMaxS;
  const list = Array.isArray(samples) ? samples : [];
  const dt = inferAnalysisDt(list, opts.sampleIntervalS);

  let moving = 0;
  let sum = 0;
  let absSum = 0;
  let sq = 0;
  let n = 0;
  let maxAbs = null;
  let maxT = null;
  for (let i = 1; i < list.length; i += 1) {
    const t0 = list[i - 1].time_s;
    const t1 = list[i].time_s;
    const a0 = list[i - 1].actual_glucose_mgdl;
    const a1 = list[i].actual_glucose_mgdl;
    const span = t1 - t0;
    if (!(span > 0) || !Number.isFinite(a0) || !Number.isFinite(a1)) continue;
    if (Math.abs((a1 - a0) / span) <= rateTh) continue;
    moving += 1;
    const signed = sampleSignedError(list[i]);
    if (!Number.isFinite(signed)) continue;
    n += 1;
    sum += signed;
    absSum += Math.abs(signed);
    sq += signed * signed;
    if (maxAbs == null || Math.abs(signed) > maxAbs) {
      maxAbs = Math.abs(signed);
      maxT = list[i].time_s;
    }
  }

  let bestLag = null;
  let bestRmse = null;
  if (moving > 0 && list.length >= 2 && dt > 0) {
    const maxSteps = Math.floor(lagMax / dt + 1e-9);
    for (let k = 0; k <= maxSteps; k += 1) {
      let ssq = 0;
      let cn = 0;
      for (let i = k; i < list.length; i += 1) {
        const est = list[i].estimated_glucose_mgdl;
        const act = list[i - k].actual_glucose_mgdl;
        if (!Number.isFinite(est) || !Number.isFinite(act)) continue;
        const err = est - act;
        ssq += err * err;
        cn += 1;
      }
      if (!cn) continue;
      const rmse = Math.sqrt(ssq / cn);
      if (bestRmse == null || rmse < bestRmse - 1e-15) {
        bestRmse = rmse;
        bestLag = k * dt;
      }
    }
  }

  return {
    moving_sample_count: moving,
    mean_signed_error_mgdl: n ? sum / n : null,
    mae_mgdl: n ? absSum / n : null,
    rmse_mgdl: n ? Math.sqrt(sq / n) : null,
    max_abs_error_mgdl: analysisFinite(maxAbs),
    max_abs_error_time_s: analysisFinite(maxT),
    best_fit_lag_s: analysisFinite(bestLag),
    lag_corrected_rmse_mgdl: analysisFinite(bestRmse),
    configuration: {
      rate_threshold_mgdl_per_s: rateTh,
      lag_max_s: lagMax
    }
  };
}

function attachSessionDynamicAnalysis(session) {
  if (!session) return session;
  const samples = session.samples || [];
  const tia = session.configuration && session.configuration.glucose_tia;
  session.transientAnalysis = analyzeTransientResponse(samples, {
    sampleIntervalS: session.sampleIntervalS,
    glucoseTia: tia
  });
  session.trackingAnalysis = analyzeContinuousTracking(samples, {
    sampleIntervalS: session.sampleIntervalS
  });
  return session;
}

function sessionQualityFromMetrics(session) {
  const reasons = [];
  const samples = session.samples;
  const cfg = session.configuration;
  const glucose = session.metrics.glucose;
  const oxygen = session.metrics.oxygen;
  let invalid = false;
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i].estimated_glucose_mgdl) || !Number.isFinite(samples[i].oxygen_recovered_level_sim)) {
      invalid = true;
      break;
    }
  }
  if (invalid) reasons.push("invalid parameters");
  if (glucose.tia_saturation_count) reasons.push("Glucose TIA saturation");
  if (oxygen.tia_saturation_count) reasons.push("Oxygen TIA saturation");
  if (glucose.adc_clipping_count) reasons.push("Glucose ADC clipping");
  if (oxygen.adc_clipping_count) reasons.push("Oxygen ADC clipping");
  const gNoise = cfg.glucose_sensor.noise_rms_na;
  const oNoise = cfg.oxygen_sensor.noise_rms_na;
  const liveG = samples.some((row) => row.glucose_noise_rms_na > CONFIG.quality.noiseWarnNa);
  const liveO = samples.some((row) => row.oxygen_noise_rms_na > CONFIG.quality.noiseWarnNa);
  if (gNoise > CONFIG.quality.noiseWarnNa || liveG) reasons.push("Excessive glucose noise");
  if (oNoise > CONFIG.quality.noiseWarnNa || liveO) reasons.push("Excessive oxygen noise");
  let status = "GOOD";
  if (invalid) status = "INVALID";
  else if (reasons.length) status = "WARNING";
  return { status: status, reasons: reasons };
}

function finalizeSimulationSession(session, status) {
  if (!session) return session;
  session.status = status === "complete" ? "complete" : "stopped";
  session.endTime = new Date().toISOString();
  const samples = session.samples;
  session.duration_s = samples.length ? samples[samples.length - 1].time_s - samples[0].time_s : 0;
  session.metrics = calculateSessionMetrics(samples);
  session.quality = sessionQualityFromMetrics(session);
  attachSessionDynamicAnalysis(session);
  return session;
}

function sessionNeedsExportWarning(session) {
  return !!(session && session.samples && session.samples.length && !session.exported);
}

function markSessionExported(session) {
  if (session) session.exported = true;
}

function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

const SESSION_RAW_HEADERS = [
  "time_s",
  "actual_glucose_mgdl", "sensor_current_na", "tia_vout_v", "filtered_vout_v",
  "adc_count", "adc_voltage_v", "recovered_current_na", "estimated_glucose_mgdl",
  "error_mgdl", "error_percent",
  "oxygen_level_sim", "oxygen_sensor_current_na", "oxygen_tia_vout_v", "oxygen_filtered_vout_v",
  "oxygen_adc_count", "oxygen_adc_voltage_v", "oxygen_recovered_current_na", "oxygen_recovered_level_sim",
  "temperature_c", "temperature_adc_count",
  "glucose_noise_rms_na", "glucose_drift_na", "oxygen_noise_rms_na", "oxygen_drift_na",
  "temperature_coefficient", "oxygen_influence_enabled", "oxygen_influence_coefficient",
  "signal_quality", "glucose_tia_saturated", "oxygen_tia_saturated",
  "glucose_adc_clipped", "oxygen_adc_clipped"
];

function buildRawCsv(session) {
  const lines = [SESSION_RAW_HEADERS.join(",")];
  session.samples.forEach((row) => {
    lines.push(SESSION_RAW_HEADERS.map((key) => csvCell(row[key])).join(","));
  });
  return lines.join("\n");
}

function summaryRows(session) {
  const cfg = session.configuration;
  const m = session.metrics;
  const q = session.quality;
  return [
    ["Simulation", "id", session.id, ""],
    ["Simulation", "version", session.version, ""],
    ["Simulation", "timestamp", session.startTime, ""],
    ["Simulation", "duration", session.duration_s, "s"],
    ["Simulation", "samples", session.samples.length, ""],
    ["Simulation", "sample_interval", session.sampleIntervalS, "s"],
    ["Simulation", "status", session.status, ""],
    ["Simulation", "signal_quality", q.status, ""],
    ["Simulation", "quality_reasons", q.reasons.join("; "), "engineering threshold"],
    ["ADC", "resolution", cfg.adc.bits, "bits"],
    ["ADC", "reference_voltage", cfg.adc.vref, "V"],
    ["Glucose", "initial", cfg.glucose_sensor.initial_glucose_mgdl, "mg/dL"],
    ["Glucose", "sensitivity", cfg.glucose_sensor.sensitivity_na_per_mgdl, "nA/(mg/dL)"],
    ["Glucose", "baseline", cfg.glucose_sensor.baseline_na, "nA"],
    ["Glucose", "noise_rms", cfg.glucose_sensor.noise_rms_na, "nA"],
    ["Glucose", "drift", cfg.glucose_sensor.drift_na, "nA"],
    ["Glucose", "RF", cfg.glucose_tia.rf_ohm, "ohm"],
    ["Glucose", "CF", cfg.glucose_tia.cf_f, "F"],
    ["Glucose", "VREF", cfg.glucose_tia.vref, "V"],
    ["Glucose", "fc", cfg.glucose_tia.fc_hz, "Hz"],
    ["Glucose", "RC", cfg.glucose_tia.rc_s, "s"],
    ["Glucose", "mean_actual", m.glucose.mean_actual_mgdl, "mg/dL"],
    ["Glucose", "mean_estimated", m.glucose.mean_estimated_mgdl, "mg/dL"],
    ["Glucose", "mean_error", m.glucose.mean_error_mgdl, "mg/dL"],
    ["Glucose", "MAE", m.glucose.mae_mgdl, "mg/dL"],
    ["Glucose", "RMSE", m.glucose.rmse_mgdl, "mg/dL"],
    ["Glucose", "max_abs_error", m.glucose.max_abs_error_mgdl, "mg/dL"],
    ["Glucose", "min_estimated", m.glucose.min_estimated_mgdl, "mg/dL"],
    ["Glucose", "max_estimated", m.glucose.max_estimated_mgdl, "mg/dL"],
    ["Glucose", "std_estimated", m.glucose.std_estimated_mgdl, "mg/dL"],
    ["Glucose", "mean_sensor_current", m.glucose.mean_sensor_current_na, "nA"],
    ["Glucose", "mean_recovered_current", m.glucose.mean_recovered_current_na, "nA"],
    ["Glucose", "mean_tia_vout", m.glucose.mean_tia_vout_v, "V"],
    ["Glucose", "mean_filtered_vout", m.glucose.mean_filtered_vout_v, "V"],
    ["Glucose", "adc_min", m.glucose.adc_min, "counts"],
    ["Glucose", "adc_max", m.glucose.adc_max, "counts"],
    ["Glucose", "mean_adc", m.glucose.mean_adc_count, "counts"],
    ["Glucose", "quantization_error", m.glucose.mean_quantization_error_v, "V"],
    ["Glucose", "tia_saturation_count", m.glucose.tia_saturation_count, "samples"],
    ["Glucose", "adc_clipping_count", m.glucose.adc_clipping_count, "samples"],
    ["Oxygen", "initial", cfg.oxygen_sensor.initial_oxygen_sim, "sim"],
    ["Oxygen", "sensitivity", cfg.oxygen_sensor.sensitivity_na_per_sim, "nA/sim"],
    ["Oxygen", "baseline", cfg.oxygen_sensor.baseline_na, "nA"],
    ["Oxygen", "noise_rms", cfg.oxygen_sensor.noise_rms_na, "nA"],
    ["Oxygen", "drift", cfg.oxygen_sensor.drift_na, "nA"],
    ["Oxygen", "RF", cfg.oxygen_tia.rf_ohm, "ohm"],
    ["Oxygen", "CF", cfg.oxygen_tia.cf_f, "F"],
    ["Oxygen", "VREF", cfg.oxygen_tia.vref, "V"],
    ["Oxygen", "fc", cfg.oxygen_tia.fc_hz, "Hz"],
    ["Oxygen", "RC", cfg.oxygen_tia.rc_s, "s"],
    ["Oxygen", "mean_level", m.oxygen.mean_level_sim, "sim"],
    ["Oxygen", "mean_recovered", m.oxygen.mean_recovered_sim, "sim"],
    ["Oxygen", "MAE", m.oxygen.mae_sim, "sim"],
    ["Oxygen", "RMSE", m.oxygen.rmse_sim, "sim"],
    ["Oxygen", "mean_sensor_current", m.oxygen.mean_sensor_current_na, "nA"],
    ["Oxygen", "mean_recovered_current", m.oxygen.mean_recovered_current_na, "nA"],
    ["Oxygen", "mean_tia_vout", m.oxygen.mean_tia_vout_v, "V"],
    ["Oxygen", "mean_filtered_vout", m.oxygen.mean_filtered_vout_v, "V"],
    ["Oxygen", "adc_min", m.oxygen.adc_min, "counts"],
    ["Oxygen", "adc_max", m.oxygen.adc_max, "counts"],
    ["Oxygen", "mean_adc", m.oxygen.mean_adc_count, "counts"],
    ["Oxygen", "tia_saturation_count", m.oxygen.tia_saturation_count, "samples"],
    ["Oxygen", "adc_clipping_count", m.oxygen.adc_clipping_count, "samples"],
    ["Temperature", "initial", cfg.temperature.initial_c, "C"],
    ["Temperature", "coefficient", cfg.temperature.coefficient_percent_per_c, "%/C"],
    ["Temperature", "mean", m.temperature.mean_c, "C"],
    ["Temperature", "min", m.temperature.min_c, "C"],
    ["Temperature", "max", m.temperature.max_c, "C"],
    ["Influence", "enabled", cfg.oxygen_glucose_influence.enabled, ""],
    ["Influence", "coefficient", cfg.oxygen_glucose_influence.coefficient, "%/sim"]
  ].concat(transientSummaryRows(session));
}

function transientSummaryRows(session) {
  const tr = session.transientAnalysis || analyzeTransientResponse(session.samples || [], {
    sampleIntervalS: session.sampleIntervalS,
    glucoseTia: session.configuration && session.configuration.glucose_tia
  });
  const tk = session.trackingAnalysis || analyzeContinuousTracking(session.samples || [], {
    sampleIntervalS: session.sampleIntervalS
  });
  const s = tr.summary || emptyTransientSummary();
  const f = tr.filter || transientFilterInfo({ glucoseTia: session.configuration && session.configuration.glucose_tia }, session.sampleIntervalS);
  const theo = f.theoretical || theoreticalRcTimes(null);
  return [
    ["Transient", "step_count", s.step_count, ""],
    ["Transient", "settled_5mg_count", s.settled_5mg_count, ""],
    ["Transient", "unsettled_5mg_count", s.unsettled_5mg_count, ""],
    ["Transient", "mean_settling_time_5mg", s.mean_settling_time_5mg_s, "s"],
    ["Transient", "max_settling_time_5mg", s.max_settling_time_5mg_s, "s"],
    ["Transient", "mean_settling_time_2pct", s.mean_settling_time_2pct_s, "s"],
    ["Transient", "max_settling_time_2pct", s.max_settling_time_2pct_s, "s"],
    ["Transient", "mean_rise_time_10_90", s.mean_rise_time_10_90_s, "s"],
    ["Transient", "mean_fall_time_90_10", s.mean_fall_time_90_10_s, "s"],
    ["Transient", "max_peak_abs_error", s.max_peak_abs_error_mgdl, "mg/dL"],
    ["Transient", "mean_event_transient_mae", s.mean_event_transient_mae_mgdl, "mg/dL"],
    ["Transient", "mean_event_transient_rmse", s.mean_event_transient_rmse_mgdl, "mg/dL"],
    ["Transient", "max_overshoot", s.max_overshoot_mgdl, "mg/dL"],
    ["Transient", "max_undershoot", s.max_undershoot_mgdl, "mg/dL"],
    ["Transient", "mean_steady_state_mae", s.mean_steady_state_mae_mgdl, "mg/dL"],
    ["Transient", "glucose_filter_rc", f.rc_s, "s"],
    ["Transient", "glucose_filter_fc", f.fc_hz, "Hz"],
    ["Transient", "simulation_dt", f.dt_s, "s"],
    ["Transient", "filter_alpha", f.alpha, ""],
    ["Transient", "theoretical_tau", theo.tau_s, "s"],
    ["Transient", "theoretical_t63_2", theo.t63_2_s, "s"],
    ["Transient", "theoretical_t90", theo.t90_s, "s"],
    ["Transient", "theoretical_t95", theo.t95_s, "s"],
    ["Transient", "theoretical_t98", theo.t98_s, "s"],
    ["Tracking", "moving_sample_count", tk.moving_sample_count, ""],
    ["Tracking", "mean_signed_error", tk.mean_signed_error_mgdl, "mg/dL"],
    ["Tracking", "mae", tk.mae_mgdl, "mg/dL"],
    ["Tracking", "rmse", tk.rmse_mgdl, "mg/dL"],
    ["Tracking", "max_abs_error", tk.max_abs_error_mgdl, "mg/dL"],
    ["Tracking", "max_abs_error_time", tk.max_abs_error_time_s, "s"],
    ["Tracking", "best_fit_lag", tk.best_fit_lag_s, "s"],
    ["Tracking", "lag_corrected_rmse", tk.lag_corrected_rmse_mgdl, "mg/dL"]
  ];
}

function buildSummaryCsv(session) {
  const lines = ["section,parameter,value,unit"];
  summaryRows(session).forEach((row) => {
    lines.push(row.map(csvCell).join(","));
  });
  return lines.join("\n");
}

function buildSessionJson(session) {
  return jsonSafe({
    biosense_simulator: {
      version: session.version,
      simulation_id: session.id,
      timestamp: session.startTime,
      end_timestamp: session.endTime,
      duration_s: session.duration_s,
      sample_interval_s: session.sampleIntervalS,
      sample_count: session.samples.length,
      status: session.status,
      disclaimer: "SIMULATED · NOT FOR MEDICAL USE · PROVISIONAL"
    },
    configuration: session.configuration,
    metrics: session.metrics,
    signal_quality: session.quality,
    transientAnalysis: session.transientAnalysis,
    trackingAnalysis: session.trackingAnalysis,
    samples: session.samples
  });
}

function sessionJsonString(session) {
  return JSON.stringify(buildSessionJson(session), null, 2);
}

function downsamplePoints(samples, xKey, yKey, maxPoints) {
  const n = samples.length;
  const step = n > maxPoints ? Math.ceil(n / maxPoints) : 1;
  const points = [];
  for (let i = 0; i < n; i += step) {
    const x = samples[i][xKey];
    const y = samples[i][yKey];
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: x, y: y });
  }
  const last = samples[n - 1];
  if (last && Number.isFinite(last[xKey]) && Number.isFinite(last[yKey])) {
    const prev = points[points.length - 1];
    if (!prev || prev.x !== last[xKey]) points.push({ x: last[xKey], y: last[yKey] });
  }
  return points;
}

function svgSeriesChart(title, series, width, height, markers) {
  const w = width || 640;
  const h = height || 220;
  const padL = 48;
  const padR = 16;
  const padT = 28;
  const padB = 28;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  series.forEach((item) => {
    item.points.forEach((p) => {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    });
  });
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) {
    return "<p>" + escapeHtml(title) + " — no finite points.</p>";
  }
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  function xPos(x) { return padL + ((x - xMin) / xSpan) * (w - padL - padR); }
  function yPos(y) { return padT + (1 - (y - yMin) / ySpan) * (h - padT - padB); }
  const paths = series.map((item) => {
    if (!item.points.length) return "";
    const d = item.points.map((p, i) => (i ? "L" : "M") + xPos(p.x).toFixed(1) + " " + yPos(p.y).toFixed(1)).join(" ");
    return '<path d="' + d + '" fill="none" stroke="' + item.color + '" stroke-width="1.6"/>';
  }).join("");
  const marks = (markers || []).map((mark) => {
    const x = Number.isFinite(mark.x) ? mark.x : mark.start_time_s;
    if (!Number.isFinite(x) || x < xMin || x > xMax) return "";
    const px = xPos(x).toFixed(1);
    return '<line x1="' + px + '" y1="' + padT + '" x2="' + px + '" y2="' + (h - padB)
      + '" stroke="rgba(226,177,90,0.35)" stroke-width="1" stroke-dasharray="3 3"/>';
  }).join("");
  const legend = series.map((item, i) => (
    '<text x="' + (padL + i * 160) + '" y="18" fill="' + item.color + '" font-size="11">' + escapeHtml(item.label) + "</text>"
  )).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" width="100%" role="img">'
    + '<rect width="' + w + '" height="' + h + '" fill="#141c25"/>'
    + '<text x="' + padL + '" y="14" fill="#8ea0b4" font-size="11">' + escapeHtml(title) + "</text>"
    + legend
    + '<text x="8" y="' + (padT + 8) + '" fill="#8ea0b4" font-size="10">' + yMax.toFixed(2) + "</text>"
    + '<text x="8" y="' + (h - 8) + '" fill="#8ea0b4" font-size="10">' + yMin.toFixed(2) + "</text>"
    + marks
    + paths
    + "</svg>";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function formatMetric(value, digits) {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "—";
  if (typeof value === "number") return value.toFixed(digits);
  return String(value);
}

function captureLiveChartImages() {
  const images = {};
  if (typeof document === "undefined") return images;
  const ids = [
    "chart-glucose", "chart-current", "chart-vout", "chart-adc",
    "chart-oxygen", "chart-oxygen-current", "chart-oxygen-vout", "chart-environment"
  ];
  ids.forEach((id) => {
    const canvas = document.getElementById(id);
    if (!canvas || typeof canvas.toDataURL !== "function") return;
    try {
      images[id] = canvas.toDataURL("image/png");
    } catch (error) {
      images[id] = null;
    }
  });
  return images;
}

function htmlTransientReport(session) {
  const tr = session.transientAnalysis || { summary: emptyTransientSummary(), events: [], filter: {}, interpretation: "" };
  const tk = session.trackingAnalysis || {};
  const s = tr.summary || emptyTransientSummary();
  const f = tr.filter || {};
  const theo = f.theoretical || theoreticalRcTimes(null);
  const events = tr.events || [];
  let eventBlock = "<p>No discrete glucose steps detected in this session.</p>";
  if (events.length) {
    eventBlock = "<table><thead><tr><th>#</th><th>Time</th><th>Direction</th><th>From</th><th>To</th><th>Δ</th>"
      + "<th>Settle ±5</th><th>Settle ±2%</th><th>Rise/Fall</th><th>Peak error</th><th>OS/US</th><th>Status</th></tr></thead><tbody>"
      + events.map((ev) => (
        "<tr><td>" + escapeHtml(ev.id)
        + "</td><td>" + escapeHtml(formatMetric(ev.start_time_s, 1))
        + "</td><td>" + escapeHtml(ev.direction)
        + "</td><td>" + escapeHtml(formatMetric(ev.from_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.to_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.delta_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.settling_time_5mg_s, 3))
        + "</td><td>" + escapeHtml(formatMetric(ev.settling_time_2pct_s, 3))
        + "</td><td>" + escapeHtml(ev.direction === "rising" ? formatMetric(ev.rise_time_10_90_s, 3) : formatMetric(ev.fall_time_90_10_s, 3))
        + "</td><td>" + escapeHtml(formatMetric(ev.peak_abs_error_mgdl, 2))
        + "</td><td>" + escapeHtml(formatMetric(ev.direction === "rising" ? ev.overshoot_mgdl : ev.undershoot_mgdl, 2))
        + "</td><td>" + escapeHtml(ev.status)
        + "</td></tr>"
      )).join("")
      + "</tbody></table>";
  }
  return "<h2>TRANSIENT RESPONSE</h2>"
    + "<p>" + escapeHtml(tr.interpretation || "Step-response metrics characterize the simulated electronic/filter chain under artificial instantaneous glucose changes. Real electrochemical sensor dynamics are not yet modeled.") + "</p>"
    + "<p>Step events " + s.step_count
    + " · Settled " + s.settled_5mg_count
    + " · Mean settle ±5 " + escapeHtml(formatMetric(s.mean_settling_time_5mg_s, 3))
    + " s · Worst settle ±5 " + escapeHtml(formatMetric(s.max_settling_time_5mg_s, 3))
    + " s · Mean 10–90% " + escapeHtml(formatMetric(s.mean_rise_time_10_90_s, 3))
    + " s · Mean 90–10% " + escapeHtml(formatMetric(s.mean_fall_time_90_10_s, 3))
    + " s · Max transient error " + escapeHtml(formatMetric(s.max_peak_abs_error_mgdl, 2))
    + " mg/dL · Mean event MAE " + escapeHtml(formatMetric(s.mean_event_transient_mae_mgdl, 2))
    + " · Steady-state MAE " + escapeHtml(formatMetric(s.mean_steady_state_mae_mgdl, 3))
    + " · Max overshoot " + escapeHtml(formatMetric(s.max_overshoot_mgdl, 2))
    + " · Max undershoot " + escapeHtml(formatMetric(s.max_undershoot_mgdl, 2)) + "</p>"
    + "<p>Glucose filter RC " + escapeHtml(formatMetric(f.rc_s, 4))
    + " s · fc " + escapeHtml(formatMetric(f.fc_hz, 4))
    + " Hz · dt " + escapeHtml(formatMetric(f.dt_s, 3))
    + " s · alpha " + escapeHtml(formatMetric(f.alpha, 4)) + "</p>"
    + "<h3>THEORETICAL RC RESPONSE</h3>"
    + "<p>tau " + escapeHtml(formatMetric(theo.tau_s, 4))
    + " s · t63.2 " + escapeHtml(formatMetric(theo.t63_2_s, 4))
    + " s · t90 " + escapeHtml(formatMetric(theo.t90_s, 4))
    + " s · t95 " + escapeHtml(formatMetric(theo.t95_s, 4))
    + " s · t98 " + escapeHtml(formatMetric(theo.t98_s, 4))
    + " s. Theoretical first-order RC values, not a measured sensor response.</p>"
    + "<h3>STEP EVENTS</h3>" + eventBlock
    + "<h3>CONTINUOUS TRACKING</h3>"
    + "<p>Moving samples " + escapeHtml(String(tk.moving_sample_count == null ? 0 : tk.moving_sample_count))
    + " · Tracking MAE " + escapeHtml(formatMetric(tk.mae_mgdl, 3))
    + " · Tracking RMSE " + escapeHtml(formatMetric(tk.rmse_mgdl, 3))
    + " · Max tracking error " + escapeHtml(formatMetric(tk.max_abs_error_mgdl, 3))
    + " · Best-fit lag " + escapeHtml(formatMetric(tk.best_fit_lag_s, 3))
    + " s · Lag-corrected RMSE " + escapeHtml(formatMetric(tk.lag_corrected_rmse_mgdl, 3)) + "</p>";
}

function buildHtmlReport(session, chartImages) {
  const cfg = session.configuration;
  const m = session.metrics;
  const q = session.quality;
  const images = chartImages || {};
  const stepEvents = (session.transientAnalysis && session.transientAnalysis.events) || [];
  const glucoseSvg = svgSeriesChart("Glucose estimation", [
    { label: "Actual", color: "#3cbfb4", points: downsamplePoints(session.samples, "time_s", "actual_glucose_mgdl", 800) },
    { label: "Estimated", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "estimated_glucose_mgdl", 800) }
  ], 640, 220, stepEvents);
  const oxygenSvg = svgSeriesChart("Oxygen (sim · PROVISIONAL)", [
    { label: "Level", color: "#7dcea0", points: downsamplePoints(session.samples, "time_s", "oxygen_level_sim", 800) },
    { label: "Recovered", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "oxygen_recovered_level_sim", 800) }
  ]);
  const tempSvg = svgSeriesChart("Temperature", [
    { label: "°C", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "temperature_c", 800) }
  ]);
  const voutSvg = svgSeriesChart("TIA VOUT", [
    { label: "Glucose", color: "#3cbfb4", points: downsamplePoints(session.samples, "time_s", "tia_vout_v", 800) },
    { label: "Oxygen", color: "#8eb7ef", points: downsamplePoints(session.samples, "time_s", "oxygen_tia_vout_v", 800) }
  ]);
  const imageBlock = Object.keys(images).filter((id) => images[id]).map((id) => (
    "<figure><figcaption>" + escapeHtml(id) + " · last 60 s of the live UI</figcaption>"
    + '<img alt="' + escapeHtml(id) + '" src="' + images[id] + '"></figure>'
  )).join("");
  const imageNote = imageBlock
    ? ""
    : "<p>Live canvas snapshots were not available. Full-run SVG charts above cover the complete session.</p>";
  const rows = summaryRows(session).map((row) => (
    "<tr><td>" + escapeHtml(row[0]) + "</td><td>" + escapeHtml(row[1]) + "</td><td>"
    + escapeHtml(row[2] == null ? "—" : row[2]) + "</td><td>" + escapeHtml(row[3]) + "</td></tr>"
  )).join("");
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    + "<title>BioSense Simulation Report</title><style>"
    + "body{margin:0;background:#0c1116;color:#e7eef6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;}"
    + "h1,h2{letter-spacing:.08em;} .tag{color:#e2b15a;margin-right:8px;} .muted{color:#8ea0b4;}"
    + "table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;} td,th{border-bottom:1px solid #243140;padding:6px 8px;text-align:left;}"
    + "svg,img{max-width:100%;background:#141c25;border:1px solid #243140;border-radius:8px;margin:8px 0;}"
    + "figure{margin:12px 0;} figcaption{color:#8ea0b4;font-size:12px;}"
    + "</style></head><body>"
    + "<h1>BIOSENSE SIMULATOR</h1><h2>SIMULATION REPORT</h2>"
    + "<p><span class=\"tag\">SIMULATION ONLY</span><span class=\"tag\">NOT FOR MEDICAL USE</span><span class=\"tag\">PROVISIONAL</span></p>"
    + "<p class=\"muted\">Oxygen units are sim. They are not mmHg, SpO2, or a physiological saturation.</p>"
    + "<p>ID " + escapeHtml(session.id) + "<br>Date " + escapeHtml(session.startTime)
    + "<br>Duration " + escapeHtml(formatMetric(session.duration_s, 1)) + " s"
    + "<br>Samples " + session.samples.length
    + "<br>Status " + escapeHtml(session.status === "complete" ? "SIMULATION COMPLETE" : "SIMULATION STOPPED")
    + "<br>Signal quality " + escapeHtml(q.status)
    + "<br>Reasons " + escapeHtml(q.reasons.length ? q.reasons.join(" · ") : "none") + "</p>"
    + "<h2>Configuration</h2>"
    + "<p>Glucose " + escapeHtml(cfg.glucose_sensor.initial_glucose_mgdl) + " mg/dL · Oxygen "
    + escapeHtml(cfg.oxygen_sensor.initial_oxygen_sim) + " sim · Temperature "
    + escapeHtml(cfg.temperature.initial_c) + " °C</p>"
    + "<p>ADC " + escapeHtml(cfg.adc.bits) + "-bit · VREF_ADC " + escapeHtml(cfg.adc.vref) + " V</p>"
    + "<p>Glucose TIA RF " + escapeHtml(cfg.glucose_tia.rf_ohm) + " Ω · CF " + escapeHtml(cfg.glucose_tia.cf_f)
    + " F · VREF " + escapeHtml(cfg.glucose_tia.vref) + " V</p>"
    + "<p>Oxygen TIA RF " + escapeHtml(cfg.oxygen_tia.rf_ohm) + " Ω · CF " + escapeHtml(cfg.oxygen_tia.cf_f)
    + " F · VREF " + escapeHtml(cfg.oxygen_tia.vref) + " V</p>"
    + "<p>Temperature coefficient " + escapeHtml(cfg.temperature.coefficient_percent_per_c)
    + " %/°C · O2→glucose influence " + (cfg.oxygen_glucose_influence.enabled ? "ON" : "OFF")
    + " · coefficient " + escapeHtml(cfg.oxygen_glucose_influence.coefficient) + "</p>"
    + "<h2>Glucose results</h2><p>MAE " + escapeHtml(formatMetric(m.glucose.mae_mgdl, 4))
    + " mg/dL · RMSE " + escapeHtml(formatMetric(m.glucose.rmse_mgdl, 4))
    + " mg/dL · Max |error| " + escapeHtml(formatMetric(m.glucose.max_abs_error_mgdl, 4))
    + " mg/dL · TIA sat " + m.glucose.tia_saturation_count
    + " · ADC clip " + m.glucose.adc_clipping_count + "</p>"
    + "<h2>Oxygen results</h2><p>MAE " + escapeHtml(formatMetric(m.oxygen.mae_sim, 4))
    + " sim · recovered " + escapeHtml(formatMetric(m.oxygen.mean_recovered_sim, 4))
    + " sim · TIA sat " + m.oxygen.tia_saturation_count
    + " · ADC clip " + m.oxygen.adc_clipping_count + "</p>"
    + "<h2>Temperature results</h2><p>Mean " + escapeHtml(formatMetric(m.temperature.mean_c, 3))
    + " °C · min " + escapeHtml(formatMetric(m.temperature.min_c, 3))
    + " · max " + escapeHtml(formatMetric(m.temperature.max_c, 3)) + "</p>"
    + htmlTransientReport(session)
    + "<h2>Metrics</h2><table><thead><tr><th>Section</th><th>Parameter</th><th>Value</th><th>Unit</th></tr></thead><tbody>"
    + rows + "</tbody></table>"
    + "<h2>Full-run charts</h2>" + glucoseSvg + oxygenSvg + tempSvg + voutSvg
    + "<h2>Live UI snapshots</h2>" + imageNote + imageBlock
    + "<p class=\"muted\">Generated by BioSense Simulator " + escapeHtml(session.version) + ". SIMULATED.</p>"
    + "</body></html>";
}

function pdfEscape(text) {
  return String(text == null ? "" : text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function strToPdfBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concatPdfBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) total += parts[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

function wrapPdfLine(text, maxWidth, fontSize) {
  const widthOf = (value) => value.length * fontSize * 0.5;
  const raw = String(text == null ? "" : text);
  const tokens = raw.split(/(\s+)/);
  const lines = [];
  let line = "";
  function flush() {
    if (line !== "") lines.push(line);
    line = "";
  }
  tokens.forEach((token) => {
    if (!token) return;
    if (widthOf(token) > maxWidth) {
      flush();
      let chunk = "";
      for (let i = 0; i < token.length; i += 1) {
        const next = chunk + token[i];
        if (chunk && widthOf(next) > maxWidth) {
          lines.push(chunk);
          chunk = token[i];
        } else chunk = next;
      }
      line = chunk;
      return;
    }
    if (line && widthOf(line + token) > maxWidth) flush();
    line += token;
  });
  flush();
  return lines.length ? lines : [""];
}

function dataUrlToBytes(dataUrl) {
  if (!dataUrl || dataUrl.indexOf("base64,") < 0) return null;
  const b64 = dataUrl.split("base64,")[1];
  const binary = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jpegFromCanvas(canvas) {
  if (!canvas || typeof canvas.toDataURL !== "function") return null;
  try {
    const bytes = dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.72));
    if (!bytes || !bytes.length) return null;
    return { bytes: bytes, width: canvas.width, height: canvas.height };
  } catch (error) {
    return null;
  }
}

function renderSeriesCanvas(title, series, width, height, markers) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#141c25";
  ctx.fillRect(0, 0, width, height);
  const padL = 56;
  const padR = 18;
  const padT = 36;
  const padB = 28;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  series.forEach((item) => {
    (item.points || []).forEach((point) => {
      if (point.x < xMin) xMin = point.x;
      if (point.x > xMax) xMax = point.x;
      if (point.y < yMin) yMin = point.y;
      if (point.y > yMax) yMax = point.y;
    });
  });
  ctx.fillStyle = "#8ea0b4";
  ctx.font = "14px sans-serif";
  ctx.fillText(title, padL, 22);
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return canvas;
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  function xPos(x) { return padL + ((x - xMin) / xSpan) * plotW; }
  function yPos(y) { return padT + (1 - (y - yMin) / ySpan) * plotH; }
  ctx.strokeStyle = "#243140";
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, height - padB);
  ctx.lineTo(width - padR, height - padB);
  ctx.stroke();
  ctx.fillStyle = "#8ea0b4";
  ctx.font = "11px sans-serif";
  ctx.fillText(String(yMax.toFixed(2)), 8, padT + 8);
  ctx.fillText(String(yMin.toFixed(2)), 8, height - 10);
  (markers || []).forEach((mark) => {
    const x = Number.isFinite(mark.x) ? mark.x : mark.start_time_s;
    if (!Number.isFinite(x) || x < xMin || x > xMax) return;
    ctx.save();
    ctx.strokeStyle = "rgba(226,177,90,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xPos(x), padT);
    ctx.lineTo(xPos(x), height - padB);
    ctx.stroke();
    ctx.restore();
  });
  series.forEach((item, index) => {
    const points = item.points || [];
    if (!points.length) return;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    points.forEach((point, i) => {
      const x = xPos(point.x);
      const y = yPos(point.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = item.color;
    ctx.fillText(item.label, padL + index * 160, 22);
  });
  return canvas;
}

function collectSessionPdfImages(session) {
  const images = [];
  if (typeof document === "undefined") return images;
  const stepEvents = (session.transientAnalysis && session.transientAnalysis.events) || [];
  const charts = [
    ["Glucose estimation", [
      { label: "Actual", color: "#3cbfb4", points: downsamplePoints(session.samples, "time_s", "actual_glucose_mgdl", 800) },
      { label: "Estimated", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "estimated_glucose_mgdl", 800) }
    ], stepEvents],
    ["Oxygen (sim, PROVISIONAL)", [
      { label: "Level", color: "#7dcea0", points: downsamplePoints(session.samples, "time_s", "oxygen_level_sim", 800) },
      { label: "Recovered", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "oxygen_recovered_level_sim", 800) }
    ]],
    ["Temperature", [
      { label: "C", color: "#e2b15a", points: downsamplePoints(session.samples, "time_s", "temperature_c", 800) }
    ]],
    ["TIA VOUT", [
      { label: "Glucose", color: "#3cbfb4", points: downsamplePoints(session.samples, "time_s", "tia_vout_v", 800) },
      { label: "Oxygen", color: "#8eb7ef", points: downsamplePoints(session.samples, "time_s", "oxygen_tia_vout_v", 800) }
    ]]
  ];
  charts.forEach((item) => {
    const canvas = renderSeriesCanvas(item[0], item[1], 900, 300, item[2]);
    const jpeg = jpegFromCanvas(canvas);
    if (jpeg) images.push(Object.assign({ title: item[0] }, jpeg));
  });
  return images;
}

function buildSessionPdf(session, extraImages) {
  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 48;
  const maxText = pageW - 2 * margin;
  const pages = [];
  const imageStore = [];
  let stream = "";
  let pageImages = [];
  let y = pageH - margin;

  function flushPage() {
    pages.push({ stream: stream, images: pageImages.slice() });
    stream = "";
    pageImages = [];
    y = pageH - margin;
  }

  function ensureSpace(height) {
    if (y - height < margin) flushPage();
  }

  function addText(value, size, color) {
    const fontSize = size || 10;
    const leading = fontSize + 3;
    wrapPdfLine(value, maxText, fontSize).forEach((line) => {
      ensureSpace(leading);
      stream += "BT /F1 " + fontSize + " Tf " + (color || "0 0 0") + " rg "
        + margin.toFixed(2) + " " + (y - fontSize).toFixed(2) + " Td (" + pdfEscape(line) + ") Tj ET\n";
      y -= leading;
    });
  }

  function addGap(amount) {
    y -= amount || 8;
    if (y < margin) flushPage();
  }

  function addJpeg(image) {
    if (!image || !image.bytes || !image.bytes.length) return;
    const maxW = maxText;
    const maxH = 200;
    let w = maxW;
    let h = w * (image.height / image.width);
    if (h > maxH) {
      h = maxH;
      w = h * (image.width / image.height);
    }
    ensureSpace(h + 12);
    const name = "Im" + (imageStore.length + 1);
    imageStore.push({ name: name, width: image.width, height: image.height, bytes: image.bytes });
    pageImages.push(name);
    stream += "q " + w.toFixed(2) + " 0 0 " + h.toFixed(2) + " " + margin.toFixed(2) + " "
      + (y - h).toFixed(2) + " cm /" + name + " Do Q\n";
    y -= h + 10;
  }

  const cfg = session.configuration;
  const m = session.metrics;
  const q = session.quality;
  const status = session.status === "complete" ? "SIMULATION COMPLETE" : "SIMULATION STOPPED";
  addText("BIOSENSE SIMULATOR", 18, "0.24 0.75 0.71");
  addText("SIMULATION REPORT", 13, "0.24 0.75 0.71");
  addGap(4);
  addText("SIMULATION ONLY  |  NOT FOR MEDICAL USE  |  PROVISIONAL", 9, "0.89 0.69 0.35");
  addText("Oxygen units are sim. They are not mmHg, SpO2, or physiological saturation.", 9);
  addGap(8);
  addText(status, 12);
  addText("Signal quality: " + q.status, 11);
  addText(q.reasons.length ? "Reasons: " + q.reasons.join(" | ") + " (engineering thresholds, not medical)" : "No saturation, clipping, or excessive noise.");
  addGap(6);
  addText("ID: " + session.id);
  addText("Date: " + session.startTime);
  addText("Duration: " + formatMetric(session.duration_s, 1) + " s");
  addText("Samples: " + session.samples.length);
  addText("Sampling interval: " + session.sampleIntervalS + " s");
  addGap(8);
  addText("CONFIGURATION", 12, "0.24 0.75 0.71");
  addText("Initial glucose: " + formatMetric(cfg.glucose_sensor.initial_glucose_mgdl, 2) + " mg/dL");
  addText("Initial oxygen: " + formatMetric(cfg.oxygen_sensor.initial_oxygen_sim, 2) + " sim");
  addText("Initial temperature: " + formatMetric(cfg.temperature.initial_c, 2) + " C");
  addText("ADC: " + cfg.adc.bits + " bit, VREF " + formatMetric(cfg.adc.vref, 3) + " V");
  addText("Glucose TIA: RF " + cfg.glucose_tia.rf_ohm + " ohm, CF " + cfg.glucose_tia.cf_f + " F, VREF " + formatMetric(cfg.glucose_tia.vref, 3) + " V, fc " + formatMetric(cfg.glucose_tia.fc_hz, 4) + " Hz");
  addText("Oxygen TIA: RF " + cfg.oxygen_tia.rf_ohm + " ohm, CF " + cfg.oxygen_tia.cf_f + " F, VREF " + formatMetric(cfg.oxygen_tia.vref, 3) + " V, fc " + formatMetric(cfg.oxygen_tia.fc_hz, 4) + " Hz");
  addText("Glucose sensitivity " + formatMetric(cfg.glucose_sensor.sensitivity_na_per_mgdl, 4) + " nA/(mg/dL), baseline " + formatMetric(cfg.glucose_sensor.baseline_na, 3) + " nA, noise RMS " + formatMetric(cfg.glucose_sensor.noise_rms_na, 3) + " nA, drift " + formatMetric(cfg.glucose_sensor.drift_na, 3) + " nA");
  addText("Oxygen sensitivity " + formatMetric(cfg.oxygen_sensor.sensitivity_na_per_sim, 4) + " nA/sim, baseline " + formatMetric(cfg.oxygen_sensor.baseline_na, 3) + " nA, noise RMS " + formatMetric(cfg.oxygen_sensor.noise_rms_na, 3) + " nA, drift " + formatMetric(cfg.oxygen_sensor.drift_na, 3) + " nA");
  addText("Temperature coefficient: " + formatMetric(cfg.temperature.coefficient_percent_per_c, 3) + " %/C  PROVISIONAL");
  addText("O2 -> glucose influence: " + (cfg.oxygen_glucose_influence.enabled ? "ON" : "OFF") + ", coefficient " + formatMetric(cfg.oxygen_glucose_influence.coefficient, 3) + "  PROVISIONAL");
  addGap(8);
  addText("GLUCOSE RESULTS", 12, "0.24 0.75 0.71");
  addText("Mean actual " + formatMetric(m.glucose.mean_actual_mgdl, 3) + " mg/dL, mean estimated " + formatMetric(m.glucose.mean_estimated_mgdl, 3) + " mg/dL");
  addText("MAE " + formatMetric(m.glucose.mae_mgdl, 4) + " mg/dL, RMSE " + formatMetric(m.glucose.rmse_mgdl, 4) + " mg/dL, max |error| " + formatMetric(m.glucose.max_abs_error_mgdl, 4) + " mg/dL");
  addText("Mean TIA VOUT " + formatMetric(m.glucose.mean_tia_vout_v, 4) + " V, ADC " + formatMetric(m.glucose.adc_min, 0) + " to " + formatMetric(m.glucose.adc_max, 0));
  addText("TIA saturation count " + m.glucose.tia_saturation_count + ", ADC clipping count " + m.glucose.adc_clipping_count);
  addGap(6);
  addText("OXYGEN RESULTS  PROVISIONAL", 12, "0.24 0.75 0.71");
  addText("Mean level " + formatMetric(m.oxygen.mean_level_sim, 3) + " sim, recovered " + formatMetric(m.oxygen.mean_recovered_sim, 3) + " sim, MAE " + formatMetric(m.oxygen.mae_sim, 4) + " sim");
  addText("Mean TIA VOUT " + formatMetric(m.oxygen.mean_tia_vout_v, 4) + " V, ADC " + formatMetric(m.oxygen.adc_min, 0) + " to " + formatMetric(m.oxygen.adc_max, 0));
  addText("TIA saturation count " + m.oxygen.tia_saturation_count + ", ADC clipping count " + m.oxygen.adc_clipping_count);
  addGap(6);
  addText("TEMPERATURE RESULTS", 12, "0.24 0.75 0.71");
  addText("Mean " + formatMetric(m.temperature.mean_c, 3) + " C, min " + formatMetric(m.temperature.min_c, 3) + " C, max " + formatMetric(m.temperature.max_c, 3) + " C");
  addGap(8);
  const tr = session.transientAnalysis || { summary: emptyTransientSummary(), events: [], filter: {}, interpretation: "" };
  const tk = session.trackingAnalysis || {};
  const ts = tr.summary || emptyTransientSummary();
  const tf = tr.filter || {};
  const theo = tf.theoretical || theoreticalRcTimes(null);
  addText("TRANSIENT RESPONSE", 12, "0.24 0.75 0.71");
  addText(tr.interpretation || "Step-response metrics characterize the simulated electronic/filter chain under artificial instantaneous glucose changes. Real electrochemical sensor dynamics are not yet modeled.", 9);
  addText("Step events " + ts.step_count + ", settled " + ts.settled_5mg_count + ", unsettled " + ts.unsettled_5mg_count);
  addText("Mean settle +/-5 " + formatMetric(ts.mean_settling_time_5mg_s, 3) + " s, worst " + formatMetric(ts.max_settling_time_5mg_s, 3) + " s");
  addText("Mean 10-90 rise " + formatMetric(ts.mean_rise_time_10_90_s, 3) + " s, mean 90-10 fall " + formatMetric(ts.mean_fall_time_90_10_s, 3) + " s");
  addText("Max transient error " + formatMetric(ts.max_peak_abs_error_mgdl, 2) + " mg/dL, mean event MAE " + formatMetric(ts.mean_event_transient_mae_mgdl, 2) + " mg/dL");
  addText("Steady-state MAE " + formatMetric(ts.mean_steady_state_mae_mgdl, 3) + " mg/dL, max overshoot " + formatMetric(ts.max_overshoot_mgdl, 2) + ", max undershoot " + formatMetric(ts.max_undershoot_mgdl, 2));
  addText("Glucose filter RC " + formatMetric(tf.rc_s, 4) + " s, fc " + formatMetric(tf.fc_hz, 4) + " Hz, dt " + formatMetric(tf.dt_s, 3) + " s, alpha " + formatMetric(tf.alpha, 4));
  addText("THEORETICAL RC RESPONSE  tau " + formatMetric(theo.tau_s, 4) + " s, t63.2 " + formatMetric(theo.t63_2_s, 4) + " s, t90 " + formatMetric(theo.t90_s, 4) + " s, t95 " + formatMetric(theo.t95_s, 4) + " s, t98 " + formatMetric(theo.t98_s, 4) + " s", 9);
  addText("These are theoretical first-order RC values, not a measured electrochemical sensor response.", 8, "0.56 0.63 0.71");
  addGap(4);
  addText("STEP EVENTS", 11, "0.24 0.75 0.71");
  if (!tr.events || !tr.events.length) {
    addText("No discrete glucose steps detected in this session.");
  } else {
    const shown = tr.events.slice(0, 16);
    shown.forEach((ev) => {
      const rf = ev.direction === "rising" ? formatMetric(ev.rise_time_10_90_s, 3) : formatMetric(ev.fall_time_90_10_s, 3);
      addText(
        "#" + ev.id + "  t=" + formatMetric(ev.start_time_s, 1) + "s  " + ev.direction
        + "  " + formatMetric(ev.from_mgdl, 1) + "->" + formatMetric(ev.to_mgdl, 1)
        + "  settle5=" + formatMetric(ev.settling_time_5mg_s, 3)
        + "  rf=" + rf
        + "  peak=" + formatMetric(ev.peak_abs_error_mgdl, 2)
        + "  " + ev.status,
        8
      );
    });
    if (tr.events.length > shown.length) addText("(" + (tr.events.length - shown.length) + " more events in CSV/JSON)", 8);
  }
  addGap(4);
  addText("CONTINUOUS TRACKING", 11, "0.24 0.75 0.71");
  addText("Moving samples " + (tk.moving_sample_count == null ? 0 : tk.moving_sample_count)
    + ", MAE " + formatMetric(tk.mae_mgdl, 3)
    + " mg/dL, RMSE " + formatMetric(tk.rmse_mgdl, 3)
    + " mg/dL, max " + formatMetric(tk.max_abs_error_mgdl, 3)
    + " mg/dL, best-fit lag " + formatMetric(tk.best_fit_lag_s, 3) + " s");
  addGap(8);
  addText("CHARTS  full run", 12, "0.24 0.75 0.71");
  (extraImages || []).forEach((image) => {
    if (image.title) addText(image.title, 9, "0.56 0.63 0.71");
    addJpeg(image);
  });
  if (!(extraImages && extraImages.length)) {
    addText("Charts are included when exported from the browser.");
  }
  addGap(8);
  addText("Generated by BioSense Simulator " + session.version + ". SIMULATED. NOT FOR MEDICAL USE.", 8, "0.56 0.63 0.71");
  flushPage();

  const nImages = imageStore.length;
  const nPages = pages.length;
  const fontId = 3;
  const firstImageId = 4;
  const firstPageId = 4 + nImages;
  const xref = [0];
  const parts = [strToPdfBytes("%PDF-1.4\n%\x80\x80\x80\x80\n")];
  let offset = parts[0].length;

  function writeObject(id, body) {
    const bytes = concatPdfBytes([strToPdfBytes(id + " 0 obj\n"), body, strToPdfBytes("\nendobj\n")]);
    xref[id] = offset;
    parts.push(bytes);
    offset += bytes.length;
  }

  const pageIds = [];
  for (let i = 0; i < nPages; i += 1) pageIds.push(firstPageId + i * 2);
  writeObject(1, strToPdfBytes("<< /Type /Catalog /Pages 2 0 R >>"));
  writeObject(2, strToPdfBytes("<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") + "] /Count " + nPages + " >>"));
  writeObject(fontId, strToPdfBytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  imageStore.forEach((image, index) => {
    const dict = "<< /Type /XObject /Subtype /Image /Width " + image.width + " /Height " + image.height
      + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + image.bytes.length + " >>\nstream\n";
    writeObject(firstImageId + index, concatPdfBytes([strToPdfBytes(dict), image.bytes, strToPdfBytes("\nendstream")]));
  });
  pages.forEach((page, index) => {
    const pageId = firstPageId + index * 2;
    const contentId = pageId + 1;
    const content = strToPdfBytes(page.stream);
    let xObjects = "";
    page.images.forEach((name) => {
      const imageIndex = imageStore.findIndex((item) => item.name === name);
      if (imageIndex >= 0) xObjects += "/" + name + " " + (firstImageId + imageIndex) + " 0 R ";
    });
    const resources = "<< /Font << /F1 " + fontId + " 0 R >>"
      + (xObjects ? " /XObject << " + xObjects + ">>" : "")
      + " >>";
    writeObject(pageId, strToPdfBytes("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + pageW + " " + pageH + "] /Contents " + contentId + " 0 R /Resources " + resources + " >>"));
    writeObject(contentId, concatPdfBytes([
      strToPdfBytes("<< /Length " + content.length + " >>\nstream\n"),
      content,
      strToPdfBytes("\nendstream")
    ]));
  });

  const xrefOffset = offset;
  let xrefText = "xref\n0 " + (xref.length) + "\n0000000000 65535 f \n";
  for (let i = 1; i < xref.length; i += 1) {
    xrefText += String(xref[i]).padStart(10, "0") + " 00000 n \n";
  }
  xrefText += "trailer << /Size " + xref.length + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";
  parts.push(strToPdfBytes(xrefText));
  return concatPdfBytes(parts);
}

function sessionFilenames(session) {
  const stamp = session.fileStamp || formatFileStamp(new Date());
  const base = "biosense_simulation_" + stamp;
  return {
    raw: base + "_raw.csv",
    summary: base + "_summary.csv",
    json: base + ".json",
    report: base + "_report.html",
    pdf: base + ".pdf",
    transitions: base + "_transitions.csv"
  };
}

const TRANSITION_CSV_HEADERS = [
  "simulation_id",
  "event_id",
  "start_time_s",
  "direction",
  "from_mgdl",
  "to_mgdl",
  "delta_mgdl",
  "settling_time_5mg_s",
  "settling_time_2pct_s",
  "rise_time_10_90_s",
  "fall_time_90_10_s",
  "peak_abs_error_mgdl",
  "peak_error_signed_mgdl",
  "peak_error_time_s",
  "transient_mae_mgdl",
  "transient_rmse_mgdl",
  "overshoot_mgdl",
  "undershoot_mgdl",
  "steady_state_mean_error_mgdl",
  "steady_state_mae_mgdl",
  "status"
];

function buildTransitionsCsv(session) {
  const lines = [TRANSITION_CSV_HEADERS.join(",")];
  const events = (session.transientAnalysis && session.transientAnalysis.events) || [];
  events.forEach((ev) => {
    const row = {
      simulation_id: session.id,
      event_id: ev.id,
      start_time_s: ev.start_time_s,
      direction: ev.direction,
      from_mgdl: ev.from_mgdl,
      to_mgdl: ev.to_mgdl,
      delta_mgdl: ev.delta_mgdl,
      settling_time_5mg_s: ev.settling_time_5mg_s,
      settling_time_2pct_s: ev.settling_time_2pct_s,
      rise_time_10_90_s: ev.rise_time_10_90_s,
      fall_time_90_10_s: ev.fall_time_90_10_s,
      peak_abs_error_mgdl: ev.peak_abs_error_mgdl,
      peak_error_signed_mgdl: ev.peak_error_signed_mgdl,
      peak_error_time_s: ev.peak_error_time_s,
      transient_mae_mgdl: ev.transient_mae_mgdl,
      transient_rmse_mgdl: ev.transient_rmse_mgdl,
      overshoot_mgdl: ev.overshoot_mgdl,
      undershoot_mgdl: ev.undershoot_mgdl,
      steady_state_mean_error_mgdl: ev.steady_state_mean_error_mgdl,
      steady_state_mae_mgdl: ev.steady_state_mae_mgdl,
      status: ev.status
    };
    lines.push(TRANSITION_CSV_HEADERS.map((key) => csvCell(row[key])).join(","));
  });
  return lines.join("\n");
}

function downloadTextFile(filename, contents, mime) {
  if (typeof document === "undefined") return contents;
  const blob = new Blob([contents], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return contents;
}

function downloadBinaryFile(filename, bytes, mime) {
  if (typeof document === "undefined") return bytes;
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return bytes;
}

function canExportSession(session) {
  return !!(session && session.metrics && session.samples && session.samples.length);
}

function exportSessionRaw(session) {
  if (!canExportSession(session)) return "";
  markSessionExported(session);
  return downloadTextFile(sessionFilenames(session).raw, buildRawCsv(session), "text/csv;charset=utf-8");
}

function exportSessionSummary(session) {
  if (!canExportSession(session)) return "";
  markSessionExported(session);
  return downloadTextFile(sessionFilenames(session).summary, buildSummaryCsv(session), "text/csv;charset=utf-8");
}

function exportSessionJson(session) {
  if (!canExportSession(session)) return "";
  markSessionExported(session);
  return downloadTextFile(sessionFilenames(session).json, sessionJsonString(session), "application/json;charset=utf-8");
}

function exportSessionReport(session) {
  if (!canExportSession(session)) return "";
  markSessionExported(session);
  return downloadTextFile(
    sessionFilenames(session).report,
    buildHtmlReport(session, captureLiveChartImages()),
    "text/html;charset=utf-8"
  );
}

function exportSessionPdf(session) {
  if (!canExportSession(session)) return new Uint8Array(0);
  markSessionExported(session);
  const bytes = buildSessionPdf(session, collectSessionPdfImages(session));
  return downloadBinaryFile(sessionFilenames(session).pdf, bytes, "application/pdf");
}

function exportSessionTransitions(session) {
  if (!canExportSession(session)) return "";
  markSessionExported(session);
  return downloadTextFile(sessionFilenames(session).transitions, buildTransitionsCsv(session), "text/csv;charset=utf-8");
}

function exportSessionAll(session) {
  return exportSessionPdf(session);
}

function controlParamsFromNominal(overrides) {
  const input = nominalInput(overrides);
  return sessionControlParams({
    scenario: "stable",
    sensitivity: input.sensitivity,
    baseline: input.baseline,
    drift: input.drift,
    noiseRms: 0,
    tempC: input.tempC,
    tempCoeff: input.tempCoeff,
    vref: input.vref,
    rf: input.rf,
    cf: input.cf,
    vcc: input.vcc,
    adcBits: input.adcBits,
    adcVref: input.adcVref,
    oxygenLevel: Number.isFinite(input.oxygenLevel) ? input.oxygenLevel : CONFIG.oxygen.default,
    oxygenSensitivity: input.oxygenSensitivity,
    oxygenBaseline: input.oxygenBaseline,
    oxygenDrift: input.oxygenDrift,
    oxygenNoiseRms: 0,
    oxygenVref: input.oxygenVref,
    oxygenRf: input.oxygenRf,
    oxygenCf: input.oxygenCf,
    oxygenInfluenceEnabled: input.oxygenInfluenceEnabled,
    oxygenInfluenceCoeff: input.oxygenInfluenceCoeff,
    initialGlucose: input.glucose,
    glucose: input.glucose
  });
}

function buildRecordedSession(durationS, overrides, options) {
  const dt = CONFIG.dt;
  const count = Math.round(durationS / dt) + 1;
  const params = controlParamsFromNominal(overrides);
  const input = nominalInput(overrides);
  const session = createSimulationSession(params, options || { now: new Date("2026-09-29T10:00:00") });
  const filterGlucose = freshFilter();
  const filterOxygen = freshFilter();
  for (let i = 0; i < count; i += 1) {
    const sample = runChain(Object.assign({}, input, {
      filterMode: "step",
      filterState: filterGlucose,
      filterStateOxygen: filterOxygen,
      noiseNa: 0,
      oxygenNoiseNa: 0
    }));
    sample.t = Math.round(i * dt * 10) / 10;
    recordSessionSample(session, sample, params);
  }
  return finalizeSimulationSession(session, (options && options.status) || "stopped");
}

function buildScenarioSession(scenario, durationS, options) {
  const dt = CONFIG.dt;
  const count = Math.round(durationS / dt) + 1;
  const params = controlParamsFromNominal();
  params.scenario = scenario;
  params.initialGlucose = scenarioGlucose(scenario, 0, 200);
  const input = nominalInput();
  const session = createSimulationSession(params, options || { now: new Date("2026-09-29T10:00:00") });
  const filterGlucose = freshFilter();
  const filterOxygen = freshFilter();
  for (let i = 0; i < count; i += 1) {
    const t = Math.round(i * dt * 10) / 10;
    const sample = runChain(Object.assign({}, input, {
      glucose: scenarioGlucose(scenario, t, 200),
      filterMode: "step",
      filterState: filterGlucose,
      filterStateOxygen: filterOxygen,
      noiseNa: 0,
      oxygenNoiseNa: 0
    }));
    sample.t = t;
    recordSessionSample(session, sample, params);
  }
  return finalizeSimulationSession(session, (options && options.status) || "stopped");
}

const SimulationSession = {
  create: createSimulationSession,
  record: recordSessionSample,
  finalize: finalizeSimulationSession,
  metrics: calculateSessionMetrics,
  analyzeTransient: analyzeTransientResponse,
  analyzeTracking: analyzeContinuousTracking,
  needsExportWarning: sessionNeedsExportWarning
};

function advanceSimulation(params) {
  const noiseNa = params.noiseRms > 0 ? params.noiseRms * gaussianNoise() : 0;
  const oxygenNoiseNa = params.oxygenNoiseRms > 0 ? params.oxygenNoiseRms * gaussianNoise() : 0;
  const sample = runChain(Object.assign(chainRequest(params, {
    glucose: resolveGlucose(params),
    noiseNa,
    oxygenNoiseNa
  }), {
    filterMode: "step",
    filterState: STATE.filterGlucose,
    filterStateOxygen: STATE.filterOxygen
  }));
  sample.t = STATE.time;
  if (sample.tia.saturated) {
    STATE.saturationCount += 1;
    STATE.glucoseSatCount += 1;
  }
  if (sample.oxygen.tia.saturated) STATE.oxygenSatCount += 1;
  if (sample.adc.clipped) STATE.glucoseClipCount += 1;
  if (sample.oxygen.adc.clipped) STATE.oxygenClipCount += 1;
  STATE.history.push(sample);
  trimHistory(STATE.history, sample.t, CONFIG.historySeconds);
  if (STATE.session) recordSessionSample(STATE.session, sample, params);
  STATE.time = Math.round((STATE.time + CONFIG.dt) * 10) / 10;
  return sample;
}

function previewSample(params) {
  return runChain(Object.assign(chainRequest(params, {
    glucose: resolveGlucose(params),
    noiseNa: 0,
    oxygenNoiseNa: 0
  }), {
    filterMode: "steady",
    filterState: freshFilter(),
    filterStateOxygen: freshFilter()
  }));
}

function resolveGlucose(params) {
  if (isScripted(params.scenario)) return scenarioGlucose(params.scenario, STATE.time, STATE.manualGlucose);
  return STATE.manualGlucose;
}

/* ============================================================
   CHARTS
   Instances are created once. Updates replace point arrays.
   ============================================================ */

const glucoseStepMarkerPlugin = {
  id: "glucoseStepMarkers",
  afterDraw(chart, _args, pluginOptions) {
    const events = (pluginOptions && pluginOptions.events) || [];
    if (!events.length) return;
    const area = chart.chartArea;
    const xScale = chart.scales && chart.scales.x;
    if (!area || !xScale) return;
    const ctx = chart.ctx;
    ctx.save();
    events.forEach((ev) => {
      if (!Number.isFinite(ev.start_time_s)) return;
      const x = xScale.getPixelForValue(ev.start_time_s);
      if (x < area.left || x > area.right) return;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(226, 177, 90, 0.32)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
    });
    ctx.restore();
  }
};

function sessionStepEvents(session) {
  if (!session || !session.samples || !session.samples.length) return [];
  if (session.transientAnalysis && session.transientAnalysis.events) return session.transientAnalysis.events;
  return analyzeTransientResponse(session.samples, {
    sampleIntervalS: session.sampleIntervalS,
    glucoseTia: session.configuration && session.configuration.glucose_tia
  }).events;
}

function setGlucoseStepMarkers(chart, events, xmin, xmax) {
  if (!chart) return;
  const visible = (events || []).filter((ev) => {
    if (!Number.isFinite(ev.start_time_s)) return false;
    if (Number.isFinite(xmin) && ev.start_time_s < xmin) return false;
    if (Number.isFinite(xmax) && ev.start_time_s > xmax) return false;
    return true;
  });
  if (!chart.options.plugins) chart.options.plugins = {};
  chart.options.plugins.glucoseStepMarkers = { events: visible };
  if (chart.data.datasets[2]) {
    chart.data.datasets[2].data = visible.map((ev) => ({
      x: ev.start_time_s,
      y: ev.to_mgdl,
      event: ev
    }));
  }
}

function initCharts() {
  if (typeof Chart === "undefined") {
    throw new Error("Chart.js did not load");
  }
  if (typeof Chart.register === "function" && !glucoseStepMarkerPlugin._registered) {
    Chart.register(glucoseStepMarkerPlugin);
    glucoseStepMarkerPlugin._registered = true;
  }
  if (STATE.charts) {
    Object.keys(STATE.charts).forEach((key) => STATE.charts[key].destroy());
  }
  Chart.defaults.color = "#8ea0b4";
  Chart.defaults.borderColor = "rgba(255,255,255,0.06)";
  Chart.defaults.font.family = CONFIG_FONT();

  const axisX = {
    type: "linear",
    title: { display: true, text: "Time (s)", color: "#8ea0b4" },
    ticks: { color: "#8ea0b4", maxTicksLimit: 6, callback: (value) => Number(value).toFixed(0) },
    grid: { color: "rgba(255,255,255,0.05)" }
  };
  function axisY(title) {
    return {
      title: { display: true, text: title, color: "#8ea0b4" },
      ticks: { color: "#8ea0b4", maxTicksLimit: 6 },
      grid: { color: "rgba(255,255,255,0.05)" }
    };
  }
  function baseOptions(yTitle, showLegend) {
    return {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: showLegend,
          labels: {
            boxWidth: 12,
            color: "#c5d2e0",
            filter(item) { return item.text !== "Step event"; }
          }
        },
        tooltip: {
          intersect: false,
          mode: "index",
          backgroundColor: "#1a2430",
          titleColor: "#e7eef6",
          bodyColor: "#d5dde6",
          borderColor: "#314256",
          borderWidth: 1
        }
      },
      scales: { x: Object.assign({}, axisX), y: axisY(yTitle) },
      elements: { point: { radius: 0 }, line: { tension: 0, borderWidth: 1.7 } }
    };
  }
  function line(label, color, dashed) {
    return {
      label,
      data: [],
      borderColor: color,
      backgroundColor: "transparent",
      borderDash: dashed ? [5, 4] : [],
      pointRadius: 0
    };
  }

  STATE.charts = {
    glucose: new Chart(document.getElementById("chart-glucose"), {
      type: "line",
      data: {
        datasets: [
          line("Actual glucose", "#3cbfb4", false),
          line("Estimated glucose", "#e2b15a", true),
          {
            label: "Step event",
            data: [],
            showLine: false,
            borderColor: "rgba(226,177,90,0.55)",
            backgroundColor: "rgba(226,177,90,0.4)",
            pointRadius: 3,
            pointHoverRadius: 5,
            pointHitRadius: 8
          }
        ]
      },
      options: (function () {
        const options = baseOptions("mg/dL", true);
        options.plugins.glucoseStepMarkers = { events: [] };
        options.plugins.tooltip.callbacks = {
          afterBody(items) {
            for (let i = 0; i < items.length; i += 1) {
              const ev = items[i].raw && items[i].raw.event;
              if (!ev) continue;
              return [
                formatMetric(ev.from_mgdl, 1) + " → " + formatMetric(ev.to_mgdl, 1) + " mg/dL",
                "Peak error " + formatMetric(ev.peak_abs_error_mgdl, 2) + " mg/dL",
                ev.settling_time_5mg_s != null
                  ? "Settle ±5 " + formatMetric(ev.settling_time_5mg_s, 3) + " s"
                  : "Settle ±5 —"
              ];
            }
            return [];
          }
        };
        return options;
      }())
    }),
    current: new Chart(document.getElementById("chart-current"), {
      type: "line",
      data: { datasets: [line("Sensor current", "#8eb7ef", false), line("Recovered current", "#e2b15a", true)] },
      options: baseOptions("nA", true)
    }),
    vout: new Chart(document.getElementById("chart-vout"), {
      type: "line",
      data: { datasets: [line("TIA VOUT", "#3cbfb4", false), line("Filtered VOUT", "#d2c4ff", true)] },
      options: baseOptions("volts", true)
    }),
    adc: new Chart(document.getElementById("chart-adc"), {
      type: "line",
      data: {
        datasets: [
          line("ADC CH1 glucose", "#e7eef6", false),
          line("ADC CH2 oxygen", "#8eb7ef", true)
        ]
      },
      options: baseOptions("ADC counts", true)
    }),
    oxygen: new Chart(document.getElementById("chart-oxygen"), {
      type: "line",
      data: {
        datasets: [
          line("Oxygen level", "#7dcea0", false),
          line("Recovered oxygen", "#e2b15a", true)
        ]
      },
      options: baseOptions("sim · PROVISIONAL", true)
    }),
    oxygenCurrent: new Chart(document.getElementById("chart-oxygen-current"), {
      type: "line",
      data: {
        datasets: [
          line("Oxygen sensor current", "#8eb7ef", false),
          line("Recovered oxygen current", "#e2b15a", true)
        ]
      },
      options: baseOptions("nA", true)
    }),
    oxygenVout: new Chart(document.getElementById("chart-oxygen-vout"), {
      type: "line",
      data: {
        datasets: [
          line("Oxygen TIA VOUT", "#3cbfb4", false),
          line("Filtered VOUT", "#d2c4ff", true)
        ]
      },
      options: baseOptions("volts", true)
    }),
    environment: new Chart(document.getElementById("chart-environment"), {
      type: "line",
      data: {
        datasets: [
          Object.assign(line("Oxygen", "#7dcea0", false), { yAxisID: "y" }),
          Object.assign(line("Temperature", "#e2b15a", false), { yAxisID: "y1" })
        ]
      },
      options: environmentOptions(baseOptions, axisY)
    })
  };
}

function environmentOptions(baseOptions, axisY) {
  const options = baseOptions("Oxygen (sim)", true);
  options.scales.y1 = axisY("Temperature (°C)");
  options.scales.y1.position = "right";
  options.scales.y1.grid.drawOnChartArea = false;
  return options;
}

function CONFIG_FONT() {
  return '"SF Mono", ui-monospace, Menlo, Consolas, monospace';
}

function chartPoint(x, y) {
  return { x, y: Number.isFinite(y) ? y : null };
}

function updateCharts() {
  if (!STATE.charts || !STATE.history.length) return;
  const latest = STATE.history[STATE.history.length - 1].t;
  const xmin = latest - CONFIG.chartSeconds;
  const view = STATE.history.filter((sample) => sample.t >= xmin);
  const charts = STATE.charts;
  charts.glucose.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.glucose));
  charts.glucose.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.glucoseEst));
  setGlucoseStepMarkers(charts.glucose, sessionStepEvents(STATE.session), xmin, latest);
  charts.current.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.iPhysical));
  charts.current.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.iRecovered));
  charts.vout.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.tia.saturated ? s.tia.clamped : s.tia.ideal));
  charts.vout.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.vFiltered));
  charts.adc.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.adc.count));
  charts.adc.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.oxygen.adc.count));
  charts.oxygen.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.oxygen.level));
  charts.oxygen.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.oxygen.oxygenEst));
  charts.oxygenCurrent.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.oxygen.iPhysical));
  charts.oxygenCurrent.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.oxygen.iRecovered));
  charts.oxygenVout.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.oxygen.tia.saturated ? s.oxygen.tia.clamped : s.oxygen.tia.ideal));
  charts.oxygenVout.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.oxygen.vFiltered));
  charts.environment.data.datasets[0].data = view.map((s) => chartPoint(s.t, s.oxygen.level));
  charts.environment.data.datasets[1].data = view.map((s) => chartPoint(s.t, s.tempC));

  Object.keys(charts).forEach((key) => {
    const chart = charts[key];
    chart.options.scales.x.min = xmin;
    chart.options.scales.x.max = latest;
    chart.update("none");
  });
}

function resetCharts() {
  if (!STATE.charts) return;
  Object.keys(STATE.charts).forEach((key) => {
    const chart = STATE.charts[key];
    chart.data.datasets.forEach((dataset) => { dataset.data = []; });
    if (chart.options.plugins && chart.options.plugins.glucoseStepMarkers) {
      chart.options.plugins.glucoseStepMarkers.events = [];
    }
    chart.options.scales.x.min = undefined;
    chart.options.scales.x.max = undefined;
    chart.update("none");
  });
}

/* ============================================================
   UI
   ============================================================ */

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error("Missing #" + id);
  return el;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(id, fallback, min, max) {
  const value = parseFloat($(id).value);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function fillSelect(id, options, valueOf, labelOf, isDefault) {
  const select = $(id);
  select.textContent = "";
  options.forEach((option) => {
    const node = document.createElement("option");
    node.value = String(valueOf(option));
    node.textContent = labelOf(option);
    if (isDefault(option)) node.selected = true;
    select.appendChild(node);
  });
}

function readControls() {
  const bits = parseInt($("adc-bits").value, 10);
  return {
    scenario: $("scenario").value,
    sensitivity: readNumber("sensitivity", CONFIG.sensitivity.default, CONFIG.sensitivity.min, CONFIG.sensitivity.max),
    baseline: readNumber("baseline", CONFIG.baseline.default, CONFIG.baseline.min, CONFIG.baseline.max),
    drift: readNumber("drift-num", CONFIG.drift.default, CONFIG.drift.min, CONFIG.drift.max),
    noiseRms: readNumber("noise-num", CONFIG.noise.default, CONFIG.noise.min, CONFIG.noise.max),
    tempC: readNumber("temp-num", CONFIG.temperature.default, CONFIG.temperature.min, CONFIG.temperature.max),
    tempCoeff: readNumber("temp-coeff", CONFIG.tempCoeff.default, CONFIG.tempCoeff.min, CONFIG.tempCoeff.max),
    vref: readNumber("vref", CONFIG.vref.default, CONFIG.vref.min, CONFIG.vref.max),
    rf: readNumber("rf", 1e6, 1, 1e12),
    cf: readNumber("cf", 100e-9, 1e-15, 1),
    vcc: CONFIG.vcc,
    adcBits: CONFIG.adcBits.indexOf(bits) >= 0 ? bits : CONFIG.adcBitsDefault,
    adcVref: readNumber("adc-vref", CONFIG.adcVref.default, CONFIG.adcVref.min, CONFIG.adcVref.max),
    oxygenLevel: readNumber("oxygen-num", CONFIG.oxygen.default, CONFIG.oxygen.min, CONFIG.oxygen.max),
    oxygenSensitivity: readNumber("o2-sensitivity", CONFIG.oxygen.sensitivity.default, CONFIG.oxygen.sensitivity.min, CONFIG.oxygen.sensitivity.max),
    oxygenBaseline: readNumber("o2-baseline", CONFIG.baseline.default, CONFIG.baseline.min, CONFIG.baseline.max),
    oxygenDrift: readNumber("o2-drift-num", CONFIG.drift.default, CONFIG.drift.min, CONFIG.drift.max),
    oxygenNoiseRms: readNumber("o2-noise-num", CONFIG.noise.default, CONFIG.noise.min, CONFIG.noise.max),
    oxygenVref: readNumber("o2-vref", CONFIG.vref.default, CONFIG.vref.min, CONFIG.vref.max),
    oxygenRf: readNumber("o2-rf", 1e6, 1, 1e12),
    oxygenCf: readNumber("o2-cf", 100e-9, 1e-15, 1),
    oxygenInfluenceEnabled: $("o2-influence").checked,
    oxygenInfluenceCoeff: readNumber("o2-influence-coeff", CONFIG.oxygen.influence.default, CONFIG.oxygen.influence.min, CONFIG.oxygen.influence.max)
  };
}

function bindPair(sliderId, numberId, min, max, onInput) {
  const slider = $(sliderId);
  const number = $(numberId);
  slider.addEventListener("input", () => {
    number.value = slider.value;
    onInput(parseFloat(slider.value));
  });
  number.addEventListener("input", () => {
    const value = parseFloat(number.value);
    if (!Number.isFinite(value) || value < min || value > max) return;
    slider.value = String(value);
    onInput(value);
  });
  number.addEventListener("change", () => {
    let value = parseFloat(number.value);
    if (!Number.isFinite(value)) value = parseFloat(slider.value);
    value = clamp(value, min, max);
    number.value = String(value);
    slider.value = String(value);
    onInput(value);
  });
}

function writeGlucose(value) {
  $("glucose-num").value = (Math.round(value * 100) / 100).toFixed(2);
  $("glucose-slider").value = String(value);
}

function setManualGlucose(value) {
  if (!Number.isFinite(value)) return;
  STATE.manualGlucose = clamp(value, CONFIG.glucose.min, CONFIG.glucose.max);
  if (!isScripted($("scenario").value)) writeGlucose(STATE.manualGlucose);
}

function syncScenarioControls(params) {
  const scripted = isScripted(params.scenario);
  $("glucose-slider").disabled = scripted;
  $("glucose-num").disabled = scripted;
  $("scenario-copy").textContent = CONFIG.scenarioCopy[params.scenario] || "";
  if (scripted) {
    writeGlucose(resolveGlucose(params));
    return;
  }
  const active = document.activeElement;
  if (active === $("glucose-num") || active === $("glucose-slider")) return;
  writeGlucose(STATE.manualGlucose);
}

function fmt(value, digits) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function fmtSigned(value, digits) {
  if (!Number.isFinite(value)) return "—";
  const text = value.toFixed(digits);
  return value > 0 ? "+" + text : text;
}

function trimNum(value) {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function fmtOhms(ohms) {
  if (!(ohms > 0) || !Number.isFinite(ohms)) return "—";
  if (ohms >= 1e6) return trimNum(ohms / 1e6) + " MΩ";
  if (ohms >= 1e3) return trimNum(ohms / 1e3) + " kΩ";
  return trimNum(ohms) + " Ω";
}

function fmtFarads(farads) {
  if (!(farads > 0) || !Number.isFinite(farads)) return "—";
  if (farads >= 1e-6 - 1e-18) return trimNum(farads * 1e6) + " µF";
  if (farads >= 1e-9 - 1e-21) return trimNum(farads * 1e9) + " nF";
  return trimNum(farads * 1e12) + " pF";
}

function fmtHz(hz) {
  if (!Number.isFinite(hz)) return "—";
  if (hz >= 1000) return (hz / 1000).toFixed(2) + " kHz";
  if (hz >= 10) return hz.toFixed(2) + " Hz";
  return hz.toFixed(3) + " Hz";
}

function fmtSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds >= 0.1 - 1e-9) return seconds.toFixed(3) + " s";
  if (seconds >= 1e-3) return (seconds * 1e3).toFixed(3) + " ms";
  if (seconds >= 1e-6) return (seconds * 1e6).toFixed(3) + " µs";
  return seconds.toExponential(2) + " s";
}

function fmtUv(volts) {
  if (!Number.isFinite(volts)) return "—";
  const micro = volts * 1e6;
  if (micro >= 10) return micro.toFixed(2) + " µV";
  if (micro >= 0.01) return micro.toFixed(3) + " µV";
  return micro.toExponential(2) + " µV";
}

function text(id, value) {
  $(id).textContent = value;
}

function renderSample(sample) {
  const glucoseText = fmt(sample.glucose, 2);
  const mmolText = fmt(sample.glucoseMmol, 3) + " mmol/L";
  const oxygen = sample.oxygen;
  const quality = sample.signalQuality || "—";

  text("map-g-sensor", fmt(sample.iPhysical, 2));
  text("map-g-tia", fmt(sample.tia.saturated ? sample.tia.clamped : sample.tia.ideal, 3));
  text("map-g-filter", fmt(sample.vFiltered, 3));
  text("map-g-adc", Number.isFinite(sample.adc.count) ? String(sample.adc.count) : "—");
  text("map-o-sensor", fmt(oxygen.iPhysical, 2));
  text("map-o-tia", fmt(oxygen.tia.saturated ? oxygen.tia.clamped : oxygen.tia.ideal, 3));
  text("map-o-filter", fmt(oxygen.vFiltered, 3));
  text("map-o-adc", Number.isFinite(oxygen.adc.count) ? String(oxygen.adc.count) : "—");
  text("map-t-sensor", fmt(sample.tempC, 1));
  text("map-t-ch", "CH3");
  text("map-t-adc", Number.isFinite(sample.temperature.adc.count) ? String(sample.temperature.adc.count) : "—");
  text("map-est-g", fmt(sample.glucoseEst, 2));
  text("map-est-o", fmt(oxygen.oxygenEst, 2));
  text("map-est-t", fmt(sample.tempC, 2));
  text("map-quality", quality);

  $("block-g-tia").classList.toggle("is-sat", !!sample.tia.saturated);
  $("block-o-tia").classList.toggle("is-sat", !!oxygen.tia.saturated);
  $("block-g-adc").classList.toggle("is-clip", !!sample.adc.clipped);
  $("block-o-adc").classList.toggle("is-clip", !!oxygen.adc.clipped);
  $("sat-alert").hidden = !sample.tia.saturated;
  $("alert-o-sat").hidden = !oxygen.tia.saturated;
  $("adc-alert").hidden = !sample.adc.clipped;
  $("alert-o-clip").hidden = !oxygen.adc.clipped;

  text("val-card-glucose", glucoseText);
  text("val-card-oxygen", fmt(oxygen.level, 2));
  text("val-card-temp", fmt(sample.tempC, 2));
  const badge = $("quality-badge");
  badge.textContent = quality;
  badge.className = "quality " + (quality === "GOOD" ? "q-good" : quality === "WARNING" ? "q-warn" : "q-bad");
  text("quality-reasons", sample.qualityReasons && sample.qualityReasons.length ? sample.qualityReasons.join(" · ") : "No saturation, clipping, or excessive noise.");

  text("val-actual", glucoseText);
  text("val-mmol", mmolText);
  text("val-estimated", fmt(sample.glucoseEst, 2));
  text("val-abs", fmt(sample.absError, 3));
  text("val-pct", Number.isFinite(sample.pctError) ? fmtSigned(sample.pctError, 3) + " %" : "—");

  text("d-raw", fmt(sample.iRaw, 3) + " nA");
  text("d-comp", fmt(sample.iCompensated, 3) + " nA");
  text("d-recovered", fmt(sample.iRecovered, 3) + " nA");
  text("d-current-error", fmtSigned(sample.currentError, 3) + " nA");
  text("d-vref", fmt(sample.vref, 3) + " V");
  text("d-vout", fmt(sample.tia.ideal, 4) + " V" + (sample.tia.saturated ? " · clamped " + fmt(sample.tia.clamped, 3) + " V" : ""));
  text("d-adc-count", Number.isFinite(sample.adc.count) ? String(sample.adc.count) : "—");
  text("d-adc-max", Number.isFinite(sample.adc.max) ? String(sample.adc.max) : "—");
  text("d-lsb", fmtUv(sample.adc.lsb));
  text("d-vadc", fmt(sample.vAdc, 6) + " V");
  text("d-fc", fmtHz(sample.cutoff.fc));
  text("d-rc", fmtSeconds(sample.cutoff.rc));
  text("d-o2-current", fmt(oxygen.iPhysical, 3) + " nA");
  text("d-o2-vout", fmt(oxygen.tia.ideal, 4) + " V" + (oxygen.tia.saturated ? " · clamped " + fmt(oxygen.tia.clamped, 3) + " V" : ""));
  text("d-o2-adc", Number.isFinite(oxygen.adc.count) ? String(oxygen.adc.count) : "—");
  text("d-o2-fc", fmtHz(oxygen.cutoff.fc));
  text("fc-readout", fmtHz(sample.cutoff.fc));
  text("rc-readout", fmtSeconds(sample.cutoff.rc));
  text("o2-fc", fmtHz(oxygen.cutoff.fc));
  text("o2-rc", fmtSeconds(oxygen.cutoff.rc));

  text("dbg-glucose-mg", fmt(sample.glucose, 4));
  text("dbg-glucose-mmol", fmt(sample.glucoseMmol, 6));
  text("dbg-current-a", Number.isFinite(sample.currentA) ? sample.currentA.toExponential(6) + " A" : "—");
  text("dbg-current-na", fmt(sample.iPhysical, 6) + " nA");
  text("dbg-vref", fmt(sample.vref, 6) + " V");
  text("dbg-rf", fmtOhms(sample.rf) + " (" + sample.rf.toExponential(6) + " Ω)");
  text("dbg-cf", fmtFarads(sample.cf) + " (" + sample.cf.toExponential(6) + " F)");
  text("dbg-rc", fmtSeconds(sample.cutoff.rc));
  text("dbg-fc", Number.isFinite(sample.cutoff.fc) ? sample.cutoff.fc.toFixed(6) + " Hz" : "—");
  text("dbg-tia-raw", fmt(sample.tia.ideal, 6) + " V");
  text("dbg-filtered", fmt(sample.vFiltered, 6) + " V");
  text("dbg-bits", String(sample.adcBits));
  text("dbg-lsb", fmtUv(sample.adc.lsb) + (Number.isFinite(sample.adc.lsb) ? " (" + sample.adc.lsb.toExponential(6) + " V)" : ""));
  text("dbg-count", Number.isFinite(sample.adc.count) ? String(sample.adc.count) : "—");
  text("dbg-vadc", fmt(sample.vAdc, 6) + " V");
  text("dbg-recovered", fmt(sample.iRecovered, 6) + " nA");
  text("dbg-temp", fmt(sample.tempC, 2) + " °C");
  text("dbg-temp-corr", fmtSigned(sample.tempCorrectionNa, 4) + " nA · factor " + fmt(sample.tempFactor, 4));
  text("dbg-estimated", fmt(sample.glucoseEst, 4) + " mg/dL");
  text("dbg-error", fmtSigned(sample.error, 4) + " mg/dL · " + fmtSigned(sample.pctError, 4) + " %");
  text("dbg-noise", fmtSigned(sample.noiseNa, 4) + " nA");
  text("dbg-alpha", fmt(sample.alpha, 6));
  text("dbg-o2-level", fmt(oxygen.level, 4) + " sim");
  text("dbg-o2-current", fmt(oxygen.iPhysical, 6) + " nA");
  text("dbg-o2-noise", fmtSigned(oxygen.noiseNa, 4) + " nA");
  text("dbg-o2-drift", fmtSigned(oxygen.drift, 4) + " nA");
  text("dbg-o2-tia", fmt(oxygen.tia.ideal, 6) + " V");
  text("dbg-o2-filt", fmt(oxygen.vFiltered, 6) + " V");
  text("dbg-o2-adc", Number.isFinite(oxygen.adc.count) ? String(oxygen.adc.count) : "—");
  text("dbg-o2-rec", fmt(oxygen.oxygenEst, 4) + " sim · " + fmt(oxygen.iRecovered, 4) + " nA");
  text("dbg-temp-coeff", fmt(sample.tempCoeff, 4) + " %/°C · PROVISIONAL");
  text("dbg-alg-raw", fmt(sample.iRaw, 4) + " nA");
  text("dbg-alg-o2", fmtSigned(sample.oxygenCorrectionNa, 4) + " nA · " + (sample.oxygenInfluenceActive ? "ON" : "OFF"));
  text("dbg-alg-temp", fmtSigned(sample.tempCorrectionNa, 4) + " nA");
  text("dbg-alg-est", fmt(sample.glucoseEst, 4) + " mg/dL");
  text("dbg-alg-err", fmtSigned(sample.error, 4) + " mg/dL");
  text("dbg-alg-q", quality + (sample.qualityReasons && sample.qualityReasons.length ? " · " + sample.qualityReasons.join(", ") : ""));
}

function renderPreview() {
  STATE.holdLast = false;
  const params = readControls();
  syncScenarioControls(params);
  renderSample(previewSample(params));
  updateClock();
  updateStatus();
}

function updateClock() {
  text("sim-clock", "t = " + STATE.time.toFixed(1) + " s · step 0.1 s · buffer 120 s · charts 60 s");
}

function updateStatus() {
  const params = readControls();
  const noise = fmt(params.noiseRms, 1);
  let message = "IDLE · DC steady state · noise " + noise + " nA starts with the run · SIMULATED";
  if (STATE.running) message = "RUNNING · noise and low-pass active · session recording · SIMULATED · NOT FOR MEDICAL USE";
  else if (STATE.session && (STATE.session.status === "stopped" || STATE.session.status === "complete")) {
    message = (STATE.session.status === "complete" ? "SIMULATION COMPLETE" : "SIMULATION STOPPED")
      + " · " + STATE.session.samples.length + " samples recorded · SIMULATED";
  } else if (STATE.holdLast) message = "PAUSED · last sample held · charts frozen · SIMULATED";
  else if (STATE.history.length) message = "PAUSED · DC preview of the new settings · charts frozen · SIMULATED";
  text("sim-status", message);
}

function updateRunButtons() {
  const session = STATE.session;
  const finished = session && (session.status === "stopped" || session.status === "complete");
  const exportable = canExportSession(session);
  $("btn-start").disabled = STATE.running;
  $("btn-pause").disabled = !STATE.running;
  $("btn-stop").disabled = !session || finished || (!STATE.running && !(session && session.samples.length));
  $("btn-export").disabled = STATE.sweepRows.length === 0;
  $("btn-export-exp").disabled = STATE.experimentRows.length === 0;
  $("btn-export-raw").disabled = !exportable;
  $("btn-export-summary").disabled = !exportable;
  $("btn-export-json").disabled = !exportable;
  $("btn-export-report").disabled = !exportable;
  $("btn-export-pdf").disabled = !exportable;
  $("btn-export-transitions").disabled = !exportable;
}

function bufferRms(history, read) {
  let n = 0;
  let sumSq = 0;
  history.forEach((sample) => {
    const value = read(sample);
    if (!Number.isFinite(value)) return;
    n += 1;
    sumSq += value * value;
  });
  return n ? Math.sqrt(sumSq / n) : NaN;
}

function updateMetrics() {
  const metrics = calculateMetrics(STATE.history, STATE.saturationCount);
  text("m-mean", fmtSigned(metrics.meanError, 3));
  text("m-mae", fmt(metrics.mae, 3));
  text("m-rmse", fmt(metrics.rmse, 3));
  text("m-max", fmt(metrics.maxError, 3));
  text("m-quant", Number.isFinite(metrics.meanQuantUv) ? metrics.meanQuantUv.toFixed(2) : "—");
  text("m-sat", String(STATE.glucoseSatCount));
  text("m-sat-o2", String(STATE.oxygenSatCount));
  text("m-clip-g", String(STATE.glucoseClipCount));
  text("m-clip-o2", String(STATE.oxygenClipCount));
  text("m-noise-g", fmt(bufferRms(STATE.history, (sample) => sample.noiseNa), 3));
  text("m-noise-o2", fmt(bufferRms(STATE.history, (sample) => sample.oxygen ? sample.oxygen.noiseNa : NaN), 3));
  text("m-n", metrics.n ? metrics.n + " samples in the 120 s buffer" : "No samples yet. Metrics use the 120 s history buffer.");
}

function renderSelfTest() {
  const report = STATE.selfTest;
  const badge = $("selftest-badge");
  badge.textContent = report.pass ? "SELF-TEST PASS" : "SELF-TEST FAIL";
  badge.classList.toggle("pass", report.pass);
  badge.classList.toggle("fail", !report.pass);
  const nominal = report.nominal;
  text(
    "reference-line",
    (report.pass ? "Reference case PASS" : "Reference case FAIL")
    + " · " + fmt(nominal.glucose, 0) + " mg/dL → "
    + fmt(nominal.iPhysical, 3) + " nA → "
    + nominal.tia.ideal.toFixed(3) + " V → ADC "
    + nominal.adc.count + " → "
    + fmt(nominal.glucoseEst, 3) + " mg/dL"
  );
  const failed = report.results.filter((item) => !item.pass).length;
  text("selftest-summary", report.results.length + " checks, " + failed + " failed. SIMULATED.");
  const list = $("selftest-list");
  list.textContent = "";
  report.results.forEach((item) => {
    const li = document.createElement("li");
    li.className = item.pass ? "pass" : "fail";
    li.textContent = (item.pass ? "PASS  " : "FAIL  ") + item.name + (item.detail ? " · " + item.detail : "");
    list.appendChild(li);
  });
}

function renderSweep(rows) {
  const body = $("sweep-body");
  body.textContent = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty";
    td.textContent = "No sweep yet.";
    tr.appendChild(td);
    body.appendChild(tr);
    text("sweep-summary", "");
    return;
  }
  let sat = 0;
  let maxAbs = 0;
  rows.forEach((row) => {
    if (row.tia.saturated) sat += 1;
    if (Number.isFinite(row.absError) && row.absError > maxAbs) maxAbs = row.absError;
    const tr = document.createElement("tr");
    if (row.tia.saturated || row.adc.clipped) tr.className = "is-sat";
    else if (row.glucose === 200) tr.className = "is-ref";
    const cells = [
      fmt(row.glucose, 1) + " mg/dL",
      fmt(row.iPhysical, 3) + " nA",
      fmt(row.tia.saturated ? row.tia.clamped : row.tia.ideal, 4) + " V" + (row.tia.saturated ? " SAT" : ""),
      Number.isFinite(row.adc.count) ? String(row.adc.count) : "—",
      fmt(row.glucoseEst, 3) + " mg/dL",
      fmtSigned(row.error, 3) + " mg/dL"
    ];
    cells.forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  text("sweep-summary", "Sweep summary · maximum |error| " + fmt(maxAbs, 3) + " mg/dL · TIA saturated points " + sat + " / " + rows.length + " · SIMULATED");
}

function runSweep() {
  const params = readControls();
  STATE.sweepRows = CONFIG.sweepGlucose.map((glucose) => runChain(Object.assign(chainRequest(params, {
    glucose,
    noiseNa: 0,
    oxygenNoiseNa: 0
  }), {
    filterMode: "steady",
    filterState: freshFilter(),
    filterStateOxygen: freshFilter()
  })));
  renderSweep(STATE.sweepRows);
  updateRunButtons();
}

function exportCsv() {
  if (!STATE.sweepRows.length) return;
  const header = ["actual_glucose_mg_dl", "sensor_current_nA", "vout_V", "adc_count", "estimated_glucose_mg_dl", "error_mg_dl", "tia_saturated"];
  const lines = [header.join(",")];
  STATE.sweepRows.forEach((row) => {
    const vout = row.tia.saturated ? row.tia.clamped : row.tia.ideal;
    lines.push([
      row.glucose,
      row.iPhysical,
      vout,
      row.adc.count,
      row.glucoseEst,
      row.error,
      row.tia.saturated ? "yes" : "no"
    ].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "biosense-calibration-sweep.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const EXPERIMENT_COPY = {
  exp1: "Constant glucose 200 mg/dL and 37 °C. Oxygen sweeps 0 → 100 sim. Noise and drift are held at 0.",
  exp2: "Constant glucose 200 mg/dL. Oxygen stays at the current setting. Temperature sweeps 30 → 42 °C.",
  exp3: "Oxygen and temperature stay at the current settings. Glucose sweeps 40 → 400 mg/dL.",
  exp4: "Glucose, oxygen, temperature, drift, and noise all move together. Noise samples are simulated."
};

function renderExperiment(rows, kind) {
  const body = $("exp-body");
  body.textContent = "";
  text("exp-note", EXPERIMENT_COPY[kind] || "");
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 13;
    td.className = "empty";
    td.textContent = "No experiment yet.";
    tr.appendChild(td);
    body.appendChild(tr);
    text("exp-summary", "");
    return;
  }
  let maxAbs = 0;
  rows.forEach((row) => {
    if (Number.isFinite(row.absError) && row.absError > maxAbs) maxAbs = row.absError;
    const tr = document.createElement("tr");
    if (row.tia.saturated || row.oxygen.tia.saturated || row.adc.clipped || row.oxygen.adc.clipped) tr.className = "is-sat";
    const glucoseVout = row.tia.saturated ? row.tia.clamped : row.tia.ideal;
    const oxygenVout = row.oxygen.tia.saturated ? row.oxygen.tia.clamped : row.oxygen.tia.ideal;
    const cells = [
      fmt(row.t, 0) + " s",
      fmt(row.glucose, 1),
      fmt(row.oxygen.level, 2),
      fmt(row.tempC, 2),
      fmt(row.iPhysical, 3),
      fmt(row.oxygen.iPhysical, 3),
      fmt(glucoseVout, 4),
      fmt(oxygenVout, 4),
      Number.isFinite(row.adc.count) ? String(row.adc.count) : "—",
      Number.isFinite(row.oxygen.adc.count) ? String(row.oxygen.adc.count) : "—",
      fmt(row.glucoseEst, 3),
      fmtSigned(row.error, 3),
      row.signalQuality
    ];
    cells.forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  text("exp-summary", "Experiment summary · maximum |error| " + fmt(maxAbs, 3) + " mg/dL · " + rows.length + " steady-state points · SIMULATED · PROVISIONAL");
}

function runNamedExperiment(kind) {
  const rows = ExperimentEngine.run(kind, readControls());
  STATE.experimentRows = rows;
  STATE.experimentKind = kind;
  renderExperiment(rows, kind);
  updateRunButtons();
}

function exportExperimentCsv() {
  if (!STATE.experimentRows.length) return;
  const header = [
    "time_s", "actual_glucose_mg_dl", "oxygen_sim", "temperature_C",
    "glucose_sensor_current_nA", "oxygen_sensor_current_nA",
    "glucose_vout_V", "oxygen_vout_V", "adc_ch1", "adc_ch2",
    "estimated_glucose_mg_dl", "error_mg_dl", "signal_quality"
  ];
  const lines = [header.join(",")];
  STATE.experimentRows.forEach((row) => {
    const glucoseVout = row.tia.saturated ? row.tia.clamped : row.tia.ideal;
    const oxygenVout = row.oxygen.tia.saturated ? row.oxygen.tia.clamped : row.oxygen.tia.ideal;
    lines.push([
      row.t, row.glucose, row.oxygen.level, row.tempC,
      row.iPhysical, row.oxygen.iPhysical,
      glucoseVout, oxygenVout, row.adc.count, row.oxygen.adc.count,
      row.glucoseEst, row.error, row.signalQuality
    ].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "biosense-experiment.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function applyPreset(name) {
  if (name === "ideal") {
    $("sensitivity").value = "1";
    $("baseline").value = "0";
    $("noise-num").value = "0";
    $("noise-slider").value = "0";
    $("drift-num").value = "0";
    $("drift-slider").value = "0";
    $("temp-num").value = "37";
    $("temp-slider").value = "37";
    $("temp-coeff").value = "0";
    $("o2-influence").checked = false;
    $("o2-influence-coeff").value = "0";
    syncInfluence();
  } else if (name === "low-noise") {
    $("noise-num").value = "1";
    $("noise-slider").value = "1";
  } else if (name === "high-noise") {
    $("noise-num").value = "40";
    $("noise-slider").value = "40";
  } else if (name === "drift") {
    $("drift-num").value = "20";
    $("drift-slider").value = "20";
    $("noise-num").value = "0";
    $("noise-slider").value = "0";
  } else if (name === "adc12") {
    $("adc-bits").value = "12";
  } else if (name === "adc16") {
    $("adc-bits").value = "16";
  }
  if (!STATE.running) renderPreview();
}

function primeFilter(params) {
  const dc = previewSample(params);
  if (!STATE.filterGlucose.initialized || !Number.isFinite(STATE.filterGlucose.value)) {
    STATE.filterGlucose.value = dc.tia.clamped;
    STATE.filterGlucose.initialized = Number.isFinite(dc.tia.clamped);
  }
  if (!STATE.filterOxygen.initialized || !Number.isFinite(STATE.filterOxygen.value)) {
    STATE.filterOxygen.value = dc.oxygen.tia.clamped;
    STATE.filterOxygen.initialized = Number.isFinite(dc.oxygen.tia.clamped);
  }
}

function tick() {
  const params = readControls();
  const sample = advanceSimulation(params);
  if (isScripted(params.scenario)) writeGlucose(sample.glucose);
  renderSample(sample);
  updateCharts();
  updateMetrics();
  updateClock();
  updateStatus();
}

function startSimulation() {
  if (STATE.running) return;
  const finished = STATE.session && (STATE.session.status === "stopped" || STATE.session.status === "complete");
  if (!STATE.session || finished) {
    if (finished) {
      clearLiveBuffers();
      hideSessionResults();
    }
    const params = readControls();
    params.initialGlucose = resolveGlucose(params);
    STATE.session = createSimulationSession(params);
  } else if (STATE.session.status === "paused") {
    STATE.session.status = "running";
  }
  primeFilter(readControls());
  STATE.running = true;
  STATE.holdLast = false;
  STATE.timerId = setInterval(tick, 1000 / CONFIG.sampleHz);
  updateRunButtons();
  updateStatus();
}

function pauseSimulation() {
  if (STATE.timerId !== null) {
    clearInterval(STATE.timerId);
    STATE.timerId = null;
  }
  STATE.running = false;
}

function onPause() {
  if (!STATE.running) return;
  pauseSimulation();
  if (STATE.session && STATE.session.status === "running") STATE.session.status = "paused";
  STATE.holdLast = STATE.history.length > 0;
  updateRunButtons();
  updateStatus();
}

function stopAndAnalyze() {
  const session = STATE.session;
  if (!session || session.status === "stopped" || session.status === "complete") return;
  pauseSimulation();
  STATE.holdLast = session.samples.length > 0 || STATE.history.length > 0;
  finalizeSimulationSession(session, "stopped");
  renderSessionResults(session);
  updateRunButtons();
  updateStatus();
}

function clearLiveBuffers() {
  STATE.time = 0;
  STATE.history = [];
  STATE.saturationCount = 0;
  STATE.glucoseSatCount = 0;
  STATE.oxygenSatCount = 0;
  STATE.glucoseClipCount = 0;
  STATE.oxygenClipCount = 0;
  STATE.filterGlucose = freshFilter();
  STATE.filterOxygen = freshFilter();
  STATE.holdLast = false;
  resetCharts();
}

function hideSessionResults() {
  if (typeof document === "undefined") return;
  $("results-panel").hidden = true;
}

function resultsDl(title, entries) {
  const rows = entries.map((item) => (
    "<div><dt>" + escapeHtml(item[0]) + "</dt><dd>" + escapeHtml(item[1]) + "</dd></div>"
  )).join("");
  return "<section><h3>" + escapeHtml(title) + "</h3><dl>" + rows + "</dl></section>";
}

function renderTransientResults(session) {
  if (typeof document === "undefined") return;
  const root = $("transient-block");
  const tr = session.transientAnalysis || { summary: emptyTransientSummary(), events: [], filter: {}, interpretation: "" };
  const tk = session.trackingAnalysis || {};
  const s = tr.summary || emptyTransientSummary();
  const f = tr.filter || {};
  const theo = f.theoretical || theoreticalRcTimes(null);
  const events = tr.events || [];
  const cards = [
    ["Step events", String(s.step_count), "discrete actual changes"],
    ["Settled events", String(s.settled_5mg_count), "±5 mg/dL + 1 s hold"],
    ["Mean settling time ±5 mg/dL", formatMetric(s.mean_settling_time_5mg_s, 3), "s"],
    ["Worst settling time ±5 mg/dL", formatMetric(s.max_settling_time_5mg_s, 3), "s"],
    ["Mean 10–90% rise time", formatMetric(s.mean_rise_time_10_90_s, 3), "s"],
    ["Mean 90–10% fall time", formatMetric(s.mean_fall_time_90_10_s, 3), "s"],
    ["Maximum transient error", formatMetric(s.max_peak_abs_error_mgdl, 2), "mg/dL"],
    ["Mean event transient MAE", formatMetric(s.mean_event_transient_mae_mgdl, 2), "mg/dL"],
    ["Steady-state MAE", formatMetric(s.mean_steady_state_mae_mgdl, 3), "mg/dL"],
    ["Maximum overshoot", formatMetric(s.max_overshoot_mgdl, 2), "mg/dL"],
    ["Maximum undershoot", formatMetric(s.max_undershoot_mgdl, 2), "mg/dL"]
  ].map((item) => (
    "<article><h3>" + escapeHtml(item[0]) + "</h3><p>" + escapeHtml(item[1]) + "</p><span>" + escapeHtml(item[2]) + "</span></article>"
  )).join("");
  const filterCards = [
    ["Glucose filter RC", formatMetric(f.rc_s, 4), "s"],
    ["Glucose filter fc", formatMetric(f.fc_hz, 4), "Hz"],
    ["Simulation dt", formatMetric(f.dt_s, 3), "s"],
    ["Current alpha", formatMetric(f.alpha, 4), "dt / (RC + dt)"]
  ].map((item) => (
    "<article><h3>" + escapeHtml(item[0]) + "</h3><p>" + escapeHtml(item[1]) + "</p><span>" + escapeHtml(item[2]) + "</span></article>"
  )).join("");
  const theoCards = [
    ["tau", formatMetric(theo.tau_s, 4), "RC"],
    ["t63.2", formatMetric(theo.t63_2_s, 4), "≈ tau"],
    ["t90", formatMetric(theo.t90_s, 4), "≈ 2.303 τ"],
    ["t95", formatMetric(theo.t95_s, 4), "≈ 2.996 τ"],
    ["t98", formatMetric(theo.t98_s, 4), "≈ 3.912 τ"]
  ].map((item) => (
    "<article><h3>" + escapeHtml(item[0]) + "</h3><p>" + escapeHtml(item[1]) + "</p><span>" + escapeHtml(item[2]) + "</span></article>"
  )).join("");
  let table = "<p class=\"hint\">No discrete glucose steps detected in this session.</p>";
  if (events.length) {
    table = "<div class=\"event-table-wrap\"><table class=\"event-table\"><thead><tr>"
      + "<th>#</th><th>Time</th><th>Direction</th><th>From</th><th>To</th><th>Δ</th>"
      + "<th>Settle ±5</th><th>Settle ±2%</th><th>Rise/Fall</th><th>Peak error</th>"
      + "<th>Overshoot/Undershoot</th><th>Status</th></tr></thead><tbody>"
      + events.map((ev) => (
        "<tr><td>" + escapeHtml(ev.id)
        + "</td><td>" + escapeHtml(formatMetric(ev.start_time_s, 1))
        + "</td><td>" + escapeHtml(ev.direction)
        + "</td><td>" + escapeHtml(formatMetric(ev.from_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.to_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.delta_mgdl, 1))
        + "</td><td>" + escapeHtml(formatMetric(ev.settling_time_5mg_s, 3))
        + "</td><td>" + escapeHtml(formatMetric(ev.settling_time_2pct_s, 3))
        + "</td><td>" + escapeHtml(ev.direction === "rising" ? formatMetric(ev.rise_time_10_90_s, 3) : formatMetric(ev.fall_time_90_10_s, 3))
        + "</td><td>" + escapeHtml(formatMetric(ev.peak_abs_error_mgdl, 2))
        + "</td><td>" + escapeHtml(formatMetric(ev.overshoot_mgdl, 2) + " / " + formatMetric(ev.undershoot_mgdl, 2))
        + "</td><td>" + escapeHtml(ev.status)
        + "</td></tr>"
      )).join("")
      + "</tbody></table></div>";
  }
  const trackCards = [
    ["Moving samples", String(tk.moving_sample_count == null ? 0 : tk.moving_sample_count), "> 0.25 mg/dL/s"],
    ["Tracking MAE", formatMetric(tk.mae_mgdl, 3), "mg/dL"],
    ["Tracking RMSE", formatMetric(tk.rmse_mgdl, 3), "mg/dL"],
    ["Max tracking error", formatMetric(tk.max_abs_error_mgdl, 3), "mg/dL"],
    ["Best-fit lag", formatMetric(tk.best_fit_lag_s, 3), "s · 0–5 s search"]
  ].map((item) => (
    "<article><h3>" + escapeHtml(item[0]) + "</h3><p>" + escapeHtml(item[1]) + "</p><span>" + escapeHtml(item[2]) + "</span></article>"
  )).join("");
  root.innerHTML = "<h3>TRANSIENT RESPONSE</h3>"
    + "<p class=\"provisional\">" + escapeHtml(tr.interpretation || "Step-response metrics characterize the simulated electronic/filter chain under artificial instantaneous glucose changes. Real electrochemical sensor dynamics are not yet modeled.") + "</p>"
    + "<div class=\"metric-grid results-kpis\">" + cards + "</div>"
    + "<h3>FILTER / SAMPLING</h3>"
    + "<div class=\"metric-grid results-kpis\">" + filterCards + "</div>"
    + "<h3>THEORETICAL RC RESPONSE</h3>"
    + "<p class=\"hint\">First-order continuous-time RC values. They are not a measured implant or electrochemical sensor response. Sensor dynamics are not modeled.</p>"
    + "<div class=\"metric-grid results-kpis\">" + theoCards + "</div>"
    + "<h3>STEP EVENTS</h3>"
    + table
    + "<h3>CONTINUOUS TRACKING</h3>"
    + "<div class=\"metric-grid results-kpis\">" + trackCards + "</div>";
}

function renderSessionResults(session, options) {
  if (typeof document === "undefined" || !session || !session.metrics) return;
  const cfg = session.configuration;
  const m = session.metrics;
  const q = session.quality;
  $("results-panel").hidden = false;
  const statusLabel = session.status === "complete" ? "SIMULATION COMPLETE" : "SIMULATION STOPPED";
  text("res-status", statusLabel + " · " + session.samples.length + " samples · SIMULATED");
  const badge = $("res-quality");
  badge.textContent = "SIGNAL QUALITY: " + q.status;
  badge.className = "quality " + (q.status === "GOOD" ? "q-good" : q.status === "WARNING" ? "q-warn" : "q-bad");
  text("res-reasons", q.reasons.length
    ? q.reasons.join(" · ") + " · engineering thresholds, not medical criteria"
    : "No saturation, clipping, or excessive noise.");
  text("res-id", session.id);
  text("res-datetime", session.startTime.replace("T", " ").replace("Z", " UTC"));
  text("res-duration", formatMetric(session.duration_s, 1));
  text("res-samples", String(session.samples.length));
  text("res-interval", String(session.sampleIntervalS));
  text("res-quality-kpi", q.status);
  text("res-mae", formatMetric(m.glucose.mae_mgdl, 3));
  text("res-rmse", formatMetric(m.glucose.rmse_mgdl, 3));
  text("res-max", formatMetric(m.glucose.max_abs_error_mgdl, 3));
  text("res-o-mae", formatMetric(m.oxygen.mae_sim, 3));
  text("res-temp", formatMetric(m.temperature.mean_c, 2));
  text("res-exported", session.exported ? "Exported" : "Not exported");
  $("results-full").innerHTML = [
    resultsDl("Input conditions", [
      ["Initial glucose", formatMetric(cfg.glucose_sensor.initial_glucose_mgdl, 2) + " mg/dL"],
      ["Initial oxygen", formatMetric(cfg.oxygen_sensor.initial_oxygen_sim, 2) + " sim"],
      ["Initial temperature", formatMetric(cfg.temperature.initial_c, 2) + " °C"],
      ["ADC resolution", String(cfg.adc.bits) + " bits"],
      ["ADC reference", formatMetric(cfg.adc.vref, 3) + " V"],
      ["Temperature coefficient", formatMetric(cfg.temperature.coefficient_percent_per_c, 3) + " %/°C · PROVISIONAL"],
      ["O2 → glucose influence", cfg.oxygen_glucose_influence.enabled ? "ON" : "OFF"],
      ["O2 influence coefficient", formatMetric(cfg.oxygen_glucose_influence.coefficient, 3) + " %/sim · PROVISIONAL"]
    ]),
    resultsDl("Glucose", [
      ["Sensitivity", formatMetric(cfg.glucose_sensor.sensitivity_na_per_mgdl, 4) + " nA/(mg/dL)"],
      ["Baseline", formatMetric(cfg.glucose_sensor.baseline_na, 3) + " nA"],
      ["Noise RMS setting", formatMetric(cfg.glucose_sensor.noise_rms_na, 3) + " nA"],
      ["Drift", formatMetric(cfg.glucose_sensor.drift_na, 3) + " nA"],
      ["RF", formatMetric(cfg.glucose_tia.rf_ohm, 0) + " Ω"],
      ["CF", String(cfg.glucose_tia.cf_f) + " F"],
      ["VREF", formatMetric(cfg.glucose_tia.vref, 3) + " V"],
      ["fc", formatMetric(cfg.glucose_tia.fc_hz, 4) + " Hz"],
      ["RC", formatMetric(cfg.glucose_tia.rc_s, 4) + " s"],
      ["Mean actual", formatMetric(m.glucose.mean_actual_mgdl, 3) + " mg/dL"],
      ["Mean estimated", formatMetric(m.glucose.mean_estimated_mgdl, 3) + " mg/dL"],
      ["Mean error", formatMetric(m.glucose.mean_error_mgdl, 3) + " mg/dL"],
      ["MAE", formatMetric(m.glucose.mae_mgdl, 3) + " mg/dL"],
      ["RMSE", formatMetric(m.glucose.rmse_mgdl, 3) + " mg/dL"],
      ["Max |error|", formatMetric(m.glucose.max_abs_error_mgdl, 3) + " mg/dL"],
      ["Min estimated", formatMetric(m.glucose.min_estimated_mgdl, 3) + " mg/dL"],
      ["Max estimated", formatMetric(m.glucose.max_estimated_mgdl, 3) + " mg/dL"],
      ["Std estimated", formatMetric(m.glucose.std_estimated_mgdl, 4) + " mg/dL"],
      ["Mean sensor current", formatMetric(m.glucose.mean_sensor_current_na, 3) + " nA"],
      ["Mean recovered current", formatMetric(m.glucose.mean_recovered_current_na, 3) + " nA"],
      ["Mean TIA VOUT", formatMetric(m.glucose.mean_tia_vout_v, 4) + " V"],
      ["Mean filtered VOUT", formatMetric(m.glucose.mean_filtered_vout_v, 4) + " V"],
      ["ADC min / max", formatMetric(m.glucose.adc_min, 0) + " / " + formatMetric(m.glucose.adc_max, 0)],
      ["Mean ADC", formatMetric(m.glucose.mean_adc_count, 2)],
      ["ADC quantization error", formatMetric(m.glucose.mean_quantization_error_v, 6) + " V"],
      ["TIA saturation count", String(m.glucose.tia_saturation_count)],
      ["ADC clipping count", String(m.glucose.adc_clipping_count)]
    ]),
    resultsDl("Oxygen · PROVISIONAL sim", [
      ["Sensitivity", formatMetric(cfg.oxygen_sensor.sensitivity_na_per_sim, 4) + " nA/sim"],
      ["Baseline", formatMetric(cfg.oxygen_sensor.baseline_na, 3) + " nA"],
      ["Noise RMS setting", formatMetric(cfg.oxygen_sensor.noise_rms_na, 3) + " nA"],
      ["Drift", formatMetric(cfg.oxygen_sensor.drift_na, 3) + " nA"],
      ["RF", formatMetric(cfg.oxygen_tia.rf_ohm, 0) + " Ω"],
      ["CF", String(cfg.oxygen_tia.cf_f) + " F"],
      ["VREF", formatMetric(cfg.oxygen_tia.vref, 3) + " V"],
      ["fc", formatMetric(cfg.oxygen_tia.fc_hz, 4) + " Hz"],
      ["RC", formatMetric(cfg.oxygen_tia.rc_s, 4) + " s"],
      ["Mean oxygen", formatMetric(m.oxygen.mean_level_sim, 3) + " sim"],
      ["Mean recovered", formatMetric(m.oxygen.mean_recovered_sim, 3) + " sim"],
      ["MAE", formatMetric(m.oxygen.mae_sim, 4) + " sim"],
      ["Mean sensor current", formatMetric(m.oxygen.mean_sensor_current_na, 3) + " nA"],
      ["Mean recovered current", formatMetric(m.oxygen.mean_recovered_current_na, 3) + " nA"],
      ["Mean TIA VOUT", formatMetric(m.oxygen.mean_tia_vout_v, 4) + " V"],
      ["Mean filtered VOUT", formatMetric(m.oxygen.mean_filtered_vout_v, 4) + " V"],
      ["ADC min / max", formatMetric(m.oxygen.adc_min, 0) + " / " + formatMetric(m.oxygen.adc_max, 0)],
      ["Mean ADC", formatMetric(m.oxygen.mean_adc_count, 2)],
      ["TIA saturation count", String(m.oxygen.tia_saturation_count)],
      ["ADC clipping count", String(m.oxygen.adc_clipping_count)]
    ]),
    resultsDl("Temperature", [
      ["Mean", formatMetric(m.temperature.mean_c, 3) + " °C"],
      ["Minimum", formatMetric(m.temperature.min_c, 3) + " °C"],
      ["Maximum", formatMetric(m.temperature.max_c, 3) + " °C"]
    ])
  ].join("");
  renderTransientResults(session);
  updateRunButtons();
  text("res-exported", session.exported ? "Exported" : "Not exported");
  if (!(options && options.silent)) {
    $("results-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function resetSimulation() {
  if (sessionNeedsExportWarning(STATE.session)) {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (!window.confirm("Simulation results have not been exported. Reset anyway?")) return false;
    }
  }
  pauseSimulation();
  STATE.session = null;
  clearLiveBuffers();
  hideSessionResults();
  updateMetrics();
  updateRunButtons();
  renderPreview();
  return true;
}

function onParamChanged() {
  if (!STATE.running) renderPreview();
  else updateStatus();
}

function bindAll() {
  bindPair("glucose-slider", "glucose-num", CONFIG.glucose.min, CONFIG.glucose.max, (value) => {
    if (isScripted($("scenario").value)) return;
    STATE.manualGlucose = value;
    if (!STATE.running) renderPreview();
  });
  bindPair("temp-slider", "temp-num", CONFIG.temperature.min, CONFIG.temperature.max, () => onParamChanged());
  bindPair("noise-slider", "noise-num", CONFIG.noise.min, CONFIG.noise.max, () => onParamChanged());
  bindPair("drift-slider", "drift-num", CONFIG.drift.min, CONFIG.drift.max, () => onParamChanged());
  bindPair("oxygen-slider", "oxygen-num", CONFIG.oxygen.min, CONFIG.oxygen.max, () => onParamChanged());
  bindPair("o2-noise-slider", "o2-noise-num", CONFIG.noise.min, CONFIG.noise.max, () => onParamChanged());
  bindPair("o2-drift-slider", "o2-drift-num", CONFIG.drift.min, CONFIG.drift.max, () => onParamChanged());

  [
    "sensitivity", "baseline", "temp-coeff", "vref", "rf", "cf", "adc-bits", "adc-vref",
    "o2-sensitivity", "o2-baseline", "o2-vref", "o2-rf", "o2-cf", "o2-influence-coeff"
  ].forEach((id) => {
    $(id).addEventListener("input", onParamChanged);
    $(id).addEventListener("change", onParamChanged);
  });
  $("o2-influence").addEventListener("change", () => {
    syncInfluence();
    onParamChanged();
  });

  $("scenario").addEventListener("change", () => {
    if (!STATE.running) renderPreview();
    else syncScenarioControls(readControls());
  });

  $("btn-start").addEventListener("click", startSimulation);
  $("btn-pause").addEventListener("click", onPause);
  $("btn-stop").addEventListener("click", stopAndAnalyze);
  $("btn-reset").addEventListener("click", resetSimulation);
  $("btn-sweep").addEventListener("click", runSweep);
  $("btn-export").addEventListener("click", exportCsv);
  $("btn-export-raw").addEventListener("click", () => {
    exportSessionRaw(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  $("btn-export-summary").addEventListener("click", () => {
    exportSessionSummary(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  $("btn-export-json").addEventListener("click", () => {
    exportSessionJson(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  $("btn-export-report").addEventListener("click", () => {
    exportSessionReport(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  $("btn-export-pdf").addEventListener("click", () => {
    exportSessionPdf(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  $("btn-export-transitions").addEventListener("click", () => {
    exportSessionTransitions(STATE.session);
    if (STATE.session) renderSessionResults(STATE.session, { silent: true });
  });
  ["exp1", "exp2", "exp3", "exp4"].forEach((kind) => {
    $("btn-" + kind).addEventListener("click", () => runNamedExperiment(kind));
  });
  $("btn-export-exp").addEventListener("click", exportExperimentCsv);
  $("presets").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-preset]");
    if (!button) return;
    applyPreset(button.dataset.preset);
  });

  document.querySelectorAll('input[type="number"]').forEach((input) => {
    input.addEventListener("wheel", (event) => {
      if (document.activeElement === input) event.preventDefault();
    }, { passive: false });
  });
}

function syncInfluence() {
  $("o2-influence-coeff").disabled = !$("o2-influence").checked;
}

function init() {
  fillSelect("rf", CONFIG.rfOptions, (option) => option.ohms, (option) => option.label, (option) => !!option.isDefault);
  fillSelect("cf", CONFIG.cfOptions, (option) => option.farads, (option) => option.label, (option) => !!option.isDefault);
  fillSelect("o2-rf", CONFIG.rfOptions, (option) => option.ohms, (option) => option.label, (option) => !!option.isDefault);
  fillSelect("o2-cf", CONFIG.cfOptions, (option) => option.farads, (option) => option.label, (option) => !!option.isDefault);
  fillSelect("adc-bits", CONFIG.adcBits, (bits) => bits, (bits) => bits + " bit", (bits) => bits === CONFIG.adcBitsDefault);
  fillSelect("scenario", CONFIG.scenarios, (option) => option.id, (option) => option.label, (option) => option.id === "stable");
  text("vcc-readout", CONFIG.vcc.toFixed(1) + " V");
  text("vcc-readout-o2", CONFIG.vcc.toFixed(1) + " V");
  syncInfluence();
  bindAll();
  try {
    initCharts();
  } catch (error) {
    text("charts-note", "Charts unavailable (" + error.message + "). Numeric path still runs. SIMULATED.");
  }
  STATE.selfTest = runSelfTests();
  renderSelfTest();
  updateMetrics();
  updateRunButtons();
  renderPreview();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runSelfTests,
    runChain,
    nominalInput,
    glucoseToCurrent,
    applyTemperatureCompensation,
    calculateTIAOutput,
    calculateCutoffFrequency,
    applyLowPassFilter,
    voltageToADC,
    adcToVoltage,
    recoverCurrent,
    currentToGlucose,
    calculateMetrics,
    gaussianNoise,
    scenarioGlucose,
    oxygenToCurrent,
    applyOxygenInfluence,
    applyTemperatureInfluence,
    bioSenseAlgorithm,
    runExperiment,
    createSimulationSession,
    recordSessionSample,
    finalizeSimulationSession,
    calculateSessionMetrics,
    sessionNeedsExportWarning,
    buildRawCsv,
    buildSummaryCsv,
    buildSessionJson,
    sessionJsonString,
    buildHtmlReport,
    buildSessionPdf,
    buildRecordedSession,
    buildScenarioSession,
    analyzeTransientResponse,
    analyzeContinuousTracking,
    buildTransitionsCsv,
    jsonSafe,
    jsonContainsNonFinite
  };
  if (require.main === module) {
    const report = runSelfTests();
    report.results.forEach((item) => {
      console.log((item.pass ? "PASS" : "FAIL") + "  " + item.name + (item.detail ? "  [" + item.detail + "]" : ""));
    });
    console.log(report.pass ? "ALL CHECKS PASSED" : "CHECKS FAILED");
    process.exit(report.pass ? 0 : 1);
  }
}
