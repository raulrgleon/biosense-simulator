"use strict";

function normalizeSeed(seed) {
  if (!Number.isFinite(seed)) return 0;
  return Math.abs(Math.floor(seed)) >>> 0;
}

function createSeededRng(seed) {
  let a = normalizeSeed(seed);
  if (a === 0) a = 0x9e3779b9;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

function driftNaFromRatePerMin(rateNaPerMin, timeS) {
  if (!Number.isFinite(rateNaPerMin) || rateNaPerMin === 0) return 0;
  if (!Number.isFinite(timeS)) return 0;
  return rateNaPerMin * (timeS / 60);
}

module.exports = {
  normalizeSeed,
  createSeededRng,
  generateSeed,
  driftNaFromRatePerMin
};
