// backend/engine/vesselEstimator.js
// Estimates TEU count on a vessel from AIS draught + Equasis vessel specs.
// This is the core innovation described in Section 3 of the manual.
// All functions are pure — no I/O, no side effects.
// Accuracy expectations per manual Section 3.3:
//   Load fraction:             ±5-8%
//   Total TEU estimate:        ±10-15%
//   Port discharge (history):  ±15%
//   Port discharge (no hist):  ±25-30%
//   Combined forecast:         ±20-25% — sufficient to classify light/normal/heavy

// Global average weight of one loaded 20-foot equivalent unit in metric tonnes.
// Source: industry consensus, varies ±2t by trade lane (handled in cargoWeightToTEU).
const AVERAGE_TEU_WEIGHT_TONNES = 14.0;

// Fraction of deadweight tonnage consumed by fuel, ballast water, and stores.
// Typical range 8-12%. Manual specifies 10% as the working assumption.
const NON_CARGO_WEIGHT_FACTOR = 0.10;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — estimateCargoWeight
//
// Derives cargo weight in tonnes from the vessel's current draught reading
// and its known empty/full draught values from Equasis.
//
// Physics: the vessel floats deeper as it gets heavier (Archimedes' principle).
// The difference between loaded and lightship draught, expressed as a fraction
// of the vessel's full draught range, tells us how full the hold is.
// ─────────────────────────────────────────────────────────────────────────────
function estimateCargoWeight(currentDraught, lightshipDraught, maxDraught, dwt) {
  // Fraction of the vessel's maximum DWT capacity that is currently loaded.
  // Formula: how far is current draught above empty, relative to the full range?
  const loadFraction = (currentDraught - lightshipDraught) / (maxDraught - lightshipDraught);

  // Clamp to [0, 1] to handle AIS rounding errors.
  // AIS draught is manually entered by the crew — often rounded to nearest 0.5m.
  // Values can slightly exceed max or fall below lightship — clamp prevents nonsense outputs.
  const clampedFraction = Math.max(0, Math.min(1, loadFraction));

  // Total weight on board = DWT × load fraction.
  // This includes cargo, fuel, ballast water, stores, and crew supplies.
  const totalLoad = dwt * clampedFraction;

  // Subtract estimated non-cargo weight (fuel, ballast, stores).
  // The manual specifies 10% of DWT as the working assumption.
  const estimatedCargoWeight = totalLoad * (1 - NON_CARGO_WEIGHT_FACTOR);

  // Round to whole tonnes — sub-tonne precision is not achievable from AIS data.
  return Math.round(estimatedCargoWeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — cargoWeightToTEU
//
// Converts estimated cargo weight in tonnes to a TEU count.
// Different trade lanes carry different average container weights:
//   Asia-Europe: heavy electronics, machinery (15.5t/TEU)
//   Trans-Pacific: mixed retail and industrial (14.8t/TEU)
//   Intra-Europe: lighter mixed cargo, more empties (11.2t/TEU)
//   North-South: commodities and industrial goods (13.0t/TEU)
//   Default: global average (14.0t/TEU)
// ─────────────────────────────────────────────────────────────────────────────
function cargoWeightToTEU(cargoWeightTonnes, tradeLane = 'default') {
  // Per-lane average TEU weight in metric tonnes.
  // These are calibrated averages from industry data — not exact for any single vessel.
  const weightByLane = {
    'asia_europe':   15.5, // Heavy consumer goods, electronics, machinery
    'trans_pacific': 14.8, // Mixed retail and industrial
    'intra_europe':  11.2, // Lighter mixed cargo, higher proportion of empty containers
    'north_south':   13.0, // Commodities and industrial goods
    'default':       14.0, // Global average when trade lane is unknown
  };

  // Use the lane-specific weight, falling back to global average if lane is unknown.
  const avgWeight = weightByLane[tradeLane] || weightByLane['default'];

  // Divide cargo weight by average TEU weight and round to whole TEUs.
  return Math.round(cargoWeightTonnes / avgWeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — estimateDischargeAtPort
//
// Estimates how many of the vessel's total TEUs will be discharged at a
// specific target port — not all containers are destined for the same port.
//
// Two methods:
//   1. Historical ratio (HIGH confidence): uses observed discharge/onboard ratios
//      from previous calls of the same shipping service at this port.
//   2. Equal distribution fallback (LOW confidence): divides total TEUs equally
//      across remaining ports in the rotation. Crude but directional.
// ─────────────────────────────────────────────────────────────────────────────
function estimateDischargeAtPort(
  totalTEUsOnBoard,
  vesselService,
  targetPort,
  portCallSequence,
  historicalRatios
) {
  // Build the lookup key: shipping service + port combination.
  // Example: 'AEX-1_demo_hamburg'
  const serviceKey = vesselService + '_' + targetPort;

  // ── Method 1: Historical ratio ───────────────────────────────────────────
  // If we have 20+ observations for this service at this port, use the
  // learned average ratio and its standard deviation for confidence bounds.
  if (historicalRatios[serviceKey]) {
    const ratio  = historicalRatios[serviceKey].avgRatio; // average fraction discharged
    const stdDev = historicalRatios[serviceKey].stdDev;   // variability of that fraction

    return {
      estimatedTEUs: Math.round(totalTEUsOnBoard * ratio),
      lowEstimate:   Math.round(totalTEUsOnBoard * Math.max(0, ratio - stdDev)),
      highEstimate:  Math.round(totalTEUsOnBoard * Math.min(1, ratio + stdDev)),
      confidence:    'HIGH',
      method:        'historical_ratio',
    };
  }

  // ── Method 2: Equal distribution fallback ────────────────────────────────
  // When no historical data exists, assume equal discharge across remaining ports.
  // portCallSequence = remaining ports after current position in the rotation.
  const portsRemaining = portCallSequence.length;

  // If we have no remaining ports (data quality issue), assume 30% — a rough
  // average for a mid-rotation call at a major hub port.
  const fallbackRatio = portsRemaining > 0 ? 1 / portsRemaining : 0.3;

  return {
    estimatedTEUs: Math.round(totalTEUsOnBoard * fallbackRatio),
    lowEstimate:   Math.round(totalTEUsOnBoard * fallbackRatio * 0.6),  // -40% uncertainty band
    highEstimate:  Math.round(totalTEUsOnBoard * fallbackRatio * 1.4),  // +40% uncertainty band
    confidence:    'LOW',
    method:        'equal_distribution_fallback',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER FUNCTION — estimateVesselDischarge
//
// Full pipeline: AIS draught reading → Equasis specs → cargo weight → TEU count
// → port-specific discharge estimate with confidence bounds.
//
// Parameters
// ──────────
// aisData       {object}  Live AIS record for this vessel:
//   .vesselName, .mmsi, .draught, .tradeLane, .serviceString,
//   .remainingPortCalls (array), .eta (ISO string)
// equasisData   {object}  Vessel specs from Equasis/cache:
//   .lightshipDraught, .maxDraught, .dwt
// targetPort    {string}  Port ID we are forecasting for (e.g. 'demo_hamburg')
// historicalRatios {object} Learned discharge ratios — keyed by 'service_port'
// ─────────────────────────────────────────────────────────────────────────────
function estimateVesselDischarge(aisData, equasisData, targetPort, historicalRatios = {}) {
  // Step 1: derive cargo weight from draught delta
  const cargoWeight = estimateCargoWeight(
    aisData.draught,
    equasisData.lightshipDraught,
    equasisData.maxDraught,
    equasisData.dwt
  );

  // Step 2: convert cargo weight to TEU count using trade-lane weight
  const totalTEUs = cargoWeightToTEU(cargoWeight, aisData.tradeLane);

  // Step 3: estimate how many of those TEUs discharge at the target port
  const discharge = estimateDischargeAtPort(
    totalTEUs,
    aisData.serviceString,
    targetPort,
    aisData.remainingPortCalls,
    historicalRatios
  );

  // Calculate the load fraction for display (0-100 integer percentage)
  const rawLoadFraction =
    (aisData.draught - equasisData.lightshipDraught) /
    (equasisData.maxDraught - equasisData.lightshipDraught);
  const loadFraction = Math.round(Math.max(0, Math.min(1, rawLoadFraction)) * 100);

  return {
    vesselName:                  aisData.vesselName,
    mmsi:                        aisData.mmsi,
    currentDraught:              aisData.draught,
    maxDraught:                  equasisData.maxDraught,
    loadFraction,                // % of capacity loaded, 0-100
    estimatedCargoWeightTonnes:  cargoWeight,
    estimatedTotalTEUs:          totalTEUs,
    estimatedDischarge:          discharge,  // { estimatedTEUs, low, high, confidence, method }
    eta:                         aisData.eta,
    confidence:                  discharge.confidence,
  };
}

module.exports = {
  estimateCargoWeight,
  cargoWeightToTEU,
  estimateDischargeAtPort,
  estimateVesselDischarge,
};
