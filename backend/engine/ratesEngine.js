// backend/engine/ratesEngine.js
// CommonJS port of frontend/src/utils/ratesEngine.js.
// Identical logic — kept here so backend modules (occupancyForecaster, routes)
// can call classifyCongestionState and calculateRecommendedRate without
// importing from the ESM frontend bundle.

// ─────────────────────────────────────────────────────────────────────────────
// STATE DEFINITIONS — must stay in sync with frontend version
// ─────────────────────────────────────────────────────────────────────────────
const STATES = {
  SLACK:    { name: 'SLACK',    label: 'Slack',    color: '#22c55e' },
  NORMAL:   { name: 'NORMAL',   label: 'Normal',   color: '#3b82f6' },
  ELEVATED: { name: 'ELEVATED', label: 'Elevated', color: '#f59e0b' },
  HIGH:     { name: 'HIGH',     label: 'High',     color: '#f97316' },
  CRITICAL: { name: 'CRITICAL', label: 'Critical', color: '#ef4444' },
};

const MULTIPLIERS = {
  SLACK:    0.75,
  NORMAL:   1.00,
  ELEVATED: 1.25,
  HIGH:     1.60,
  CRITICAL: 2.00,
};

// Clamp a value to [min, max]
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * classifyCongestionState(yardOccupancy, gateThroughput, vesselsAtBerth, config)
 * Normalises three inputs into a weighted composite score and classifies state.
 */
function classifyCongestionState(yardOccupancy, gateThroughput, vesselsAtBerth, config) {
  const { baselineGateThroughput, totalBerths } = config;

  // Yard score — occupancy is already 0-100
  const yardScore = clamp(yardOccupancy, 0, 100);

  // Gate score — how far below baseline (congestion signal)
  const rawGateScore = ((baselineGateThroughput - gateThroughput) / baselineGateThroughput) * 100;
  const gateScore    = clamp(rawGateScore, 0, 100);

  // Berth score — fraction of total berths occupied, scaled to 0-100
  const rawBerthScore = (vesselsAtBerth / totalBerths) * 100;
  const berthScore    = clamp(rawBerthScore, 0, 100);

  // Composite: yard 50%, gate 30%, berth 20%
  const composite      = (yardScore * 0.5) + (gateScore * 0.3) + (berthScore * 0.2);
  const compositeScore = Math.round(composite * 100) / 100;

  // Classify into named state
  let stateKey;
  if      (compositeScore < 30) stateKey = 'SLACK';
  else if (compositeScore < 50) stateKey = 'NORMAL';
  else if (compositeScore < 65) stateKey = 'ELEVATED';
  else if (compositeScore < 80) stateKey = 'HIGH';
  else                          stateKey = 'CRITICAL';

  return {
    state:          STATES[stateKey].name,
    label:          STATES[stateKey].label,
    color:          STATES[stateKey].color,
    compositeScore,
    scores: {
      yard:  Math.round(yardScore  * 100) / 100,
      gate:  Math.round(gateScore  * 100) / 100,
      berth: Math.round(berthScore * 100) / 100,
    },
  };
}

/**
 * calculateRecommendedRate(congestionResult, baselineRate)
 * Applies state multiplier to produce a recommended daily storage rate.
 */
function calculateRecommendedRate(congestionResult, baselineRate) {
  const multiplier        = MULTIPLIERS[congestionResult.state];
  const recommendedRate   = Math.round(baselineRate * multiplier * 100) / 100;
  const percentageChange  = Math.round((multiplier - 1) * 100 * 100) / 100;

  return { recommendedRate, multiplier, baselineRate, percentageChange };
}

module.exports = { classifyCongestionState, calculateRecommendedRate };
