// ratesEngine.js
// Core pricing logic for DemurrageDX.
// All functions are pure (no side effects, no I/O).

// ─────────────────────────────────────────────────────────────────────────────
// CONGESTION STATE DEFINITIONS
// Each state has a name (machine key), a human-readable label, and a hex color
// for use in the dashboard UI.
// ─────────────────────────────────────────────────────────────────────────────
const STATES = {
  SLACK:    { name: "SLACK",    label: "Slack",    color: "#22c55e" }, // green
  NORMAL:   { name: "NORMAL",   label: "Normal",   color: "#3b82f6" }, // blue
  ELEVATED: { name: "ELEVATED", label: "Elevated", color: "#f59e0b" }, // amber
  HIGH:     { name: "HIGH",     label: "High",     color: "#f97316" }, // orange
  CRITICAL: { name: "CRITICAL", label: "Critical", color: "#ef4444" }, // red
};

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLIERS
// The rate multiplier applied to the baseline daily storage rate for each
// congestion state.
// ─────────────────────────────────────────────────────────────────────────────
const MULTIPLIERS = {
  SLACK:    0.75, // yard is underutilised — discount to attract volume
  NORMAL:   1.00, // steady-state — charge the baseline rate
  ELEVATED: 1.25, // moderate pressure — 25 % premium
  HIGH:     1.60, // significant pressure — 60 % premium
  CRITICAL: 2.00, // yard near capacity — double rate to accelerate cargo removal
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: clamp(value, min, max)
// Ensures a numeric value stays within [min, max].
// Used to prevent scores from going negative or exceeding 100 due to
// extreme real-world inputs (e.g. gate throughput higher than baseline).
// ─────────────────────────────────────────────────────────────────────────────
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — classifyCongestionState
//
// Converts three raw operational metrics into a single composite congestion
// score and maps that score to one of five named states.
//
// Parameters
// ──────────
// yardOccupancy        {number}  Percentage of yard capacity currently in use (0–100).
// gateThroughput       {number}  Trucks/containers processed per hour right now.
// vesselsAtBerth       {number}  Number of vessels currently occupying berths.
// config               {object}  Terminal-specific constants:
//   .baselineGateThroughput {number}  Normal/expected gate throughput (same unit as gateThroughput).
//   .totalBerths            {number}  Total number of berths at this terminal.
//
// Returns {object}
//   .state         {string}  Machine key, e.g. "ELEVATED"
//   .label         {string}  Human label, e.g. "Elevated"
//   .color         {string}  Hex color for UI rendering
//   .compositeScore {number} Weighted score 0–100 (two decimal places)
// ─────────────────────────────────────────────────────────────────────────────
export function classifyCongestionState(yardOccupancy, gateThroughput, vesselsAtBerth, config) {
  const { baselineGateThroughput, totalBerths } = config;

  // ── Yard Score ─────────────────────────────────────────────────────────────
  // Yard occupancy is already expressed as a percentage (0–100), so it maps
  // directly to a 0–100 score. Clamp for safety in case of sensor over-reads.
  const yardScore = clamp(yardOccupancy, 0, 100);

  // ── Gate Score ─────────────────────────────────────────────────────────────
  // A drop in gate throughput signals congestion — trucks can't move cargo out.
  // Formula: how far below baseline are we, as a percentage of baseline?
  // A throughput AT or ABOVE baseline scores 0 (no congestion from this signal).
  // A throughput of 0 scores 100 (complete gate stoppage — maximum pressure).
  const rawGateScore = ((baselineGateThroughput - gateThroughput) / baselineGateThroughput) * 100;
  const gateScore = clamp(rawGateScore, 0, 100); // clamp: throughput above baseline → 0, not negative

  // ── Berth Score ────────────────────────────────────────────────────────────
  // Fraction of total berths occupied, scaled to 0–100.
  // More vessels at berth means more cargo is waiting to be discharged,
  // increasing yard pressure in the near term.
  const rawBerthScore = (vesselsAtBerth / totalBerths) * 100;
  const berthScore = clamp(rawBerthScore, 0, 100); // clamp: can't exceed 100 %

  // ── Composite Score ────────────────────────────────────────────────────────
  // Weighted average of the three signals.
  // Yard occupancy carries the most weight (50 %) because it is the most
  // direct indicator of storage pressure.
  // Gate throughput (30 %) is the primary leading indicator of relief.
  // Berth occupancy (20 %) is a forward-pressure signal — vessels bring more cargo.
  const composite = (yardScore * 0.5) + (gateScore * 0.3) + (berthScore * 0.2);

  // Round to two decimal places for display consistency.
  const compositeScore = Math.round(composite * 100) / 100;

  // ── State Classification ───────────────────────────────────────────────────
  // Map the composite score to a named congestion state using fixed thresholds.
  let stateKey;
  if (compositeScore < 30)      stateKey = "SLACK";    // 0–29.99  : yard well below capacity
  else if (compositeScore < 50) stateKey = "NORMAL";   // 30–49.99 : typical operating conditions
  else if (compositeScore < 65) stateKey = "ELEVATED"; // 50–64.99 : above-normal pressure
  else if (compositeScore < 80) stateKey = "HIGH";     // 65–79.99 : significant congestion
  else                          stateKey = "CRITICAL"; // 80+      : near or at capacity

  // Retrieve the full state descriptor and attach the computed score.
  const stateDescriptor = STATES[stateKey];

  return {
    state:          stateDescriptor.name,   // machine key
    label:          stateDescriptor.label,  // human-readable label
    color:          stateDescriptor.color,  // hex color for UI
    compositeScore,                         // weighted score 0–100
    // Also expose the individual sub-scores for transparency / debugging.
    scores: {
      yard:  Math.round(yardScore  * 100) / 100,
      gate:  Math.round(gateScore  * 100) / 100,
      berth: Math.round(berthScore * 100) / 100,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — calculateRecommendedRate
//
// Applies the state-specific multiplier to the terminal's baseline storage rate
// to produce a recommended daily demurrage rate.
//
// Parameters
// ──────────
// congestionResult  {object}  The return value of classifyCongestionState().
// baselineRate      {number}  The terminal's standard daily storage rate in USD.
//
// Returns {object}
//   .recommendedRate    {number}  Calculated daily rate, rounded to 2 dp.
//   .multiplier         {number}  The multiplier applied (e.g. 1.60 for HIGH).
//   .baselineRate       {number}  The unmodified baseline rate, echoed back.
//   .percentageChange   {number}  Change vs baseline as a percentage (e.g. 60 for HIGH).
// ─────────────────────────────────────────────────────────────────────────────
export function calculateRecommendedRate(congestionResult, baselineRate) {
  // Look up the multiplier for the current congestion state.
  const multiplier = MULTIPLIERS[congestionResult.state];

  // Apply the multiplier to the baseline rate.
  const rawRate = baselineRate * multiplier;

  // Round to two decimal places (cents precision for USD rates).
  const recommendedRate = Math.round(rawRate * 100) / 100;

  // Calculate percentage change relative to the baseline.
  // Positive = premium above baseline; negative = discount below baseline.
  const percentageChange = Math.round((multiplier - 1) * 100 * 100) / 100; // two dp

  return {
    recommendedRate,  // the price to display / apply
    multiplier,       // raw multiplier for audit trails
    baselineRate,     // original rate, echoed for convenience
    percentageChange, // e.g. -25, 0, 25, 60, 100
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — generateExplanation
//
// Produces a plain-English sentence explaining why the engine chose a
// particular rate, citing the actual input numbers.
//
// Parameters
// ──────────
// congestionResult  {object}  Return value of classifyCongestionState().
// rateResult        {object}  Return value of calculateRecommendedRate().
// inputs            {object}  The original raw inputs for reference:
//   .yardOccupancy          {number}
//   .gateThroughput         {number}
//   .vesselsAtBerth         {number}
//   .baselineGateThroughput {number}
//   .totalBerths            {number}
//
// Returns {string}  A single human-readable explanation paragraph.
// ─────────────────────────────────────────────────────────────────────────────
export function generateExplanation(congestionResult, rateResult, inputs) {
  const { state, compositeScore } = congestionResult;
  const { recommendedRate, percentageChange } = rateResult;
  const { yardOccupancy, gateThroughput, vesselsAtBerth, baselineGateThroughput, totalBerths } = inputs;

  // Format the percentage change as a human-friendly string, e.g. "+60%" or "–25%".
  const changeStr = percentageChange >= 0
    ? `+${percentageChange}%`
    : `${percentageChange}%`;

  // Each state gets a tailored explanation that references the dominant signals
  // driving the recommendation, so operators understand the reasoning.
  switch (state) {

    case "SLACK":
      // Yard is well below capacity — encourage more cargo with a discount.
      return (
        `The yard is operating well below capacity at ${yardOccupancy}% occupancy, ` +
        `with gate throughput at ${gateThroughput} moves/hr (baseline: ${baselineGateThroughput}) ` +
        `and only ${vesselsAtBerth} of ${totalBerths} berths in use. ` +
        `The composite congestion score is ${compositeScore}/100 (Slack). ` +
        `A discounted rate of $${recommendedRate}/day (${changeStr} vs baseline) ` +
        `is recommended to attract volume and improve asset utilisation.`
      );

    case "NORMAL":
      // Steady-state — no adjustment needed.
      return (
        `Yard occupancy is ${yardOccupancy}%, gate throughput is ${gateThroughput} moves/hr ` +
        `against a baseline of ${baselineGateThroughput}, and ${vesselsAtBerth} of ${totalBerths} berths are occupied. ` +
        `The composite congestion score is ${compositeScore}/100 (Normal). ` +
        `Conditions are within the expected operating range, so the standard baseline rate ` +
        `of $${recommendedRate}/day applies (${changeStr} change).`
      );

    case "ELEVATED":
      // Moderate pressure — apply a moderate premium to begin encouraging cargo pickup.
      return (
        `Yard occupancy has reached ${yardOccupancy}% and gate throughput has slowed to ` +
        `${gateThroughput} moves/hr (${Math.round((1 - gateThroughput / baselineGateThroughput) * 100)}% below baseline). ` +
        `With ${vesselsAtBerth} of ${totalBerths} berths occupied, the composite score is ${compositeScore}/100 (Elevated). ` +
        `A moderate premium of $${recommendedRate}/day (${changeStr}) is recommended ` +
        `to signal elevated storage costs and encourage faster cargo collection.`
      );

    case "HIGH":
      // Significant congestion — strong premium to drive cargo movement.
      return (
        `Significant congestion detected: yard occupancy is ${yardOccupancy}%, gate throughput ` +
        `has dropped to ${gateThroughput} moves/hr against a baseline of ${baselineGateThroughput}, ` +
        `and ${vesselsAtBerth} of ${totalBerths} berths are in use. ` +
        `The composite score of ${compositeScore}/100 places the terminal in a High congestion state. ` +
        `A strong premium rate of $${recommendedRate}/day (${changeStr}) is recommended ` +
        `to accelerate cargo removal and restore operational headroom.`
      );

    case "CRITICAL":
      // Near or at capacity — maximum rate to urgently free up space.
      return (
        `CRITICAL congestion: yard occupancy is at ${yardOccupancy}%, gate throughput has fallen ` +
        `to just ${gateThroughput} moves/hr (baseline: ${baselineGateThroughput}), and ` +
        `${vesselsAtBerth} of ${totalBerths} berths are occupied. ` +
        `The composite score of ${compositeScore}/100 indicates the terminal is at or near capacity. ` +
        `The maximum rate of $${recommendedRate}/day (${changeStr}) is applied immediately ` +
        `to urgently incentivise cargo collection and prevent a full yard lockout.`
      );

    default:
      // Fallback — should never be reached given the defined state set.
      return `Congestion state "${state}" is unrecognised. No explanation available.`;
  }
}
