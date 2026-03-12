// vesselEstimator.test.js — CommonJS unit tests for the backend estimator
// Tests the four functions from Section 3.2 of the manual.
// Run with: node vesselEstimator.test.js

const {
  estimateCargoWeight,
  cargoWeightToTEU,
  estimateDischargeAtPort,
  estimateVesselDischarge,
} = require('./vesselEstimator')

let passed = 0, failed = 0

function assert(desc, actual, expected, tolerance = 0) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (ok) {
    console.log(`  ✅ ${desc}: ${actual}`)
    passed++
  } else {
    console.log(`  ❌ ${desc}: got ${actual}, expected ~${expected} (±${tolerance})`)
    failed++
  }
}

console.log('\n══════════════════════════════════════════════════')
console.log('  vesselEstimator.js — Unit Tests')
console.log('══════════════════════════════════════════════════\n')

// ── estimateCargoWeight ────────────────────────────────────────────────────
console.log('── estimateCargoWeight ──')
// MSC ANNA: max 16.5m, lightship 4.5m, DWT 228206, current draught 14.2m
// loadFraction = (14.2 - 4.5) / (16.5 - 4.5) = 9.7/12.0 = 0.8083
// totalLoad = 228206 * 0.8083 = 184,549t
// cargoWeight = 184549 * 0.9 = 166,094t
assert('MSC ANNA cargo weight (tonnes)', estimateCargoWeight(14.2, 4.5, 16.5, 228206), 166094, 5000)

// Fully loaded vessel: draught = maxDraught
assert('Fully loaded load fraction = 100%', estimateCargoWeight(16.0, 4.5, 16.0, 185000), Math.round(185000 * 0.9), 500)

// Empty vessel: draught = lightshipDraught → 0 cargo
assert('Empty vessel cargo = 0', estimateCargoWeight(4.5, 4.5, 16.5, 228206), 0, 1)

// Clamping: draught above max → clamp to full load (not negative or infinite)
assert('Over-max draught clamped to full', estimateCargoWeight(17.0, 4.5, 16.5, 100000), Math.round(100000 * 0.9), 500)

// ── cargoWeightToTEU ───────────────────────────────────────────────────────
console.log('\n── cargoWeightToTEU ──')
assert('100,000t at default (14.0t/TEU)',     cargoWeightToTEU(100000, 'default'),       7143, 50)
assert('100,000t asia_europe (15.5t/TEU)',    cargoWeightToTEU(100000, 'asia_europe'),   6452, 50)
assert('100,000t intra_europe (11.2t/TEU)',   cargoWeightToTEU(100000, 'intra_europe'),  8929, 50)
assert('Unknown lane → falls back to default', cargoWeightToTEU(50000, 'mystery_lane'), 3571, 50)

// ── estimateDischargeAtPort ────────────────────────────────────────────────
console.log('\n── estimateDischargeAtPort ──')

// No history: 3 remaining ports → equal distribution = 1/3 = 33.3%
const noHistory = estimateDischargeAtPort(10000, 'AEX-1', 'hamburg', ['rotterdam', 'antwerp', 'hamburg'], {})
assert('No history: 3 ports → ~3333 TEUs discharged', noHistory.estimatedTEUs, 3333, 50)
assert('No history → LOW confidence', noHistory.confidence === 'LOW' ? 1 : 0, 1, 0)
assert('No history → equal_distribution_fallback method', noHistory.method === 'equal_distribution_fallback' ? 1 : 0, 1, 0)

// With history: ratio=0.42, stdDev=0.06 → 4200 TEUs
const withHistory = estimateDischargeAtPort(10000, 'AEX-1', 'hamburg', [], { 'AEX-1_hamburg': { avgRatio: 0.42, stdDev: 0.06 } })
assert('With history: 10000 * 0.42 = 4200 TEUs', withHistory.estimatedTEUs, 4200, 10)
assert('With history → HIGH confidence', withHistory.confidence === 'HIGH' ? 1 : 0, 1, 0)
assert('Low estimate = 10000 * (0.42-0.06) = 3600', withHistory.lowEstimate, 3600, 10)
assert('High estimate = 10000 * (0.42+0.06) = 4800', withHistory.highEstimate, 4800, 10)

// ── estimateVesselDischarge (master function) ─────────────────────────────
console.log('\n── estimateVesselDischarge (master function) ──')
const aisData = {
  vesselName: 'MSC ANNA', mmsi: '636019926',
  draught: 14.2, tradeLane: 'asia_europe',
  serviceString: 'AEX-1', remainingPortCalls: ['rotterdam'], eta: '2026-03-13T03:00:00Z',
}
const equasisData = { lightshipDraught: 4.5, maxDraught: 16.5, dwt: 228206 }
const result = estimateVesselDischarge(aisData, equasisData, 'hamburg', {})

assert('MSC ANNA load fraction 80%',       result.loadFraction, 80, 5)
assert('MSC ANNA cargo weight ~166k t',    result.estimatedCargoWeightTonnes, 166094, 5000)
assert('MSC ANNA total TEUs (asia_eu)',     result.estimatedTotalTEUs, Math.round(166094 / 15.5), 500)
assert('Returns vessel name',              result.vesselName === 'MSC ANNA' ? 1 : 0, 1, 0)
assert('Returns ETA',                      result.eta === '2026-03-13T03:00:00Z' ? 1 : 0, 1, 0)

// Manual accuracy check: published MSC ANNA TEU capacity = 23,756
// Our total TEU estimate with ~81% load should be < max capacity
assert('TEU estimate below max capacity (23756)', result.estimatedTotalTEUs < 23756 ? 1 : 0, 1, 0)
// Weight-based expected: DWT(228206) * loadFraction(0.8083) * non-cargo(0.9) / asia_europe_weight(15.5t/TEU)
// = 228206 * 0.8083 * 0.9 / 15.5 ≈ 10,715 TEUs
const expected = Math.round(228206 * 0.8083 * 0.9 / 15.5)
assert('Within ±15% of DWT-based estimate for MSC ANNA', result.estimatedTotalTEUs, expected, expected * 0.15)

console.log(`\n══════════════════════════════════════════════════`)
console.log(`  Results: ${passed} passed, ${failed} failed`)
console.log('══════════════════════════════════════════════════')
if (failed > 0) process.exit(1)
