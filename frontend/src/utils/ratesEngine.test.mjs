// ratesEngine.test.mjs
// Runs five test cases — one for each congestion state — with known inputs.
// Execute with: node ratesEngine.test.mjs
// (Must be .mjs so Node treats it as ES module, matching ratesEngine.js "export" syntax.)

import {
  classifyCongestionState,
  calculateRecommendedRate,
  generateExplanation,
} from "./ratesEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// Terminal configuration shared across all test cases.
// A fictional mid-size container terminal.
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  baselineGateThroughput: 100, // expected moves per hour under normal conditions
  totalBerths: 10,             // total berths available at this terminal
};

const BASELINE_RATE = 200; // USD per container per day at normal conditions

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASES
// Each case is crafted so the composite score falls clearly within one band:
//   SLACK    < 30
//   NORMAL   30–49
//   ELEVATED 50–64
//   HIGH     65–79
//   CRITICAL 80+
//
// Composite = (yard * 0.5) + (gate * 0.3) + (berth * 0.2)
// ─────────────────────────────────────────────────────────────────────────────
const TEST_CASES = [
  {
    label: "SLACK",
    // yard=15 → score=15 | gate=(100-110)/100*100=−10→0 | berth=1/10*100=10
    // composite = (15*0.5)+(0*0.3)+(10*0.2) = 7.5+0+2 = 9.5  → SLACK ✓
    inputs: {
      yardOccupancy:   15,   // 15 % full — very quiet
      gateThroughput:  110,  // above baseline — gate is clearing cargo fast
      vesselsAtBerth:  1,    // only one vessel in port
    },
  },
  {
    label: "NORMAL",
    // yard=35 → score=35 | gate=(100-90)/100*100=10 | berth=4/10*100=40
    // composite = (35*0.5)+(10*0.3)+(40*0.2) = 17.5+3+8 = 28.5
    // Adjust: yard=40 → (40*0.5)+(10*0.3)+(40*0.2) = 20+3+8 = 31 → NORMAL ✓
    inputs: {
      yardOccupancy:   40,   // 40 % full — comfortable
      gateThroughput:  90,   // slightly below baseline — minor slowdown
      vesselsAtBerth:  4,    // 40 % of berths occupied
    },
  },
  {
    label: "ELEVATED",
    // yard=60 | gate=(100-70)/100*100=30 | berth=6/10*100=60
    // composite = (60*0.5)+(30*0.3)+(60*0.2) = 30+9+12 = 51 → ELEVATED ✓
    inputs: {
      yardOccupancy:   60,   // 60 % full — above comfortable threshold
      gateThroughput:  70,   // 30 % below baseline — noticeable slowdown
      vesselsAtBerth:  6,    // 60 % of berths occupied
    },
  },
  {
    label: "HIGH",
    // yard=75 | gate=(100-50)/100*100=50 | berth=8/10*100=80
    // composite = (75*0.5)+(50*0.3)+(80*0.2) = 37.5+15+16 = 68.5 → HIGH ✓
    inputs: {
      yardOccupancy:   75,   // 75 % — getting congested
      gateThroughput:  50,   // half of baseline — significant backlog
      vesselsAtBerth:  8,    // 80 % of berths occupied
    },
  },
  {
    label: "CRITICAL",
    // yard=95 | gate=(100-20)/100*100=80 | berth=10/10*100=100
    // composite = (95*0.5)+(80*0.3)+(100*0.2) = 47.5+24+20 = 91.5 → CRITICAL ✓
    inputs: {
      yardOccupancy:   95,   // 95 % — nearly full
      gateThroughput:  20,   // only 20 % of normal — gate almost at standstill
      vesselsAtBerth:  10,   // every berth occupied
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════");
console.log("  DemurrageDX — Rates Engine Test Suite");
console.log("══════════════════════════════════════════════════════════════════\n");

let passed = 0;
let failed = 0;

for (const tc of TEST_CASES) {
  const { inputs, label } = tc;

  // Merge terminal config into inputs object so generateExplanation can access it.
  const fullInputs = { ...inputs, ...CONFIG };

  // Run the three engine functions in sequence.
  const congestion = classifyCongestionState(
    inputs.yardOccupancy,
    inputs.gateThroughput,
    inputs.vesselsAtBerth,
    CONFIG,
  );

  const rate = calculateRecommendedRate(congestion, BASELINE_RATE);
  const explanation = generateExplanation(congestion, rate, fullInputs);

  // Check: did we get the expected state?
  const ok = congestion.state === label;
  if (ok) passed++; else failed++;

  const marker = ok ? "✅ PASS" : `❌ FAIL (expected ${label}, got ${congestion.state})`;

  console.log(`─── Test: ${label} ${marker}`);
  console.log(`    Inputs        : yard=${inputs.yardOccupancy}%, gate=${inputs.gateThroughput} moves/hr, berths=${inputs.vesselsAtBerth}/${CONFIG.totalBerths}`);
  console.log(`    Sub-scores    : yard=${congestion.scores.yard}  gate=${congestion.scores.gate}  berth=${congestion.scores.berth}`);
  console.log(`    Composite     : ${congestion.compositeScore} / 100`);
  console.log(`    State         : ${congestion.state} (${congestion.label})  ${congestion.color}`);
  console.log(`    Rate          : $${rate.baselineRate} × ${rate.multiplier} = $${rate.recommendedRate}/day  (${rate.percentageChange >= 0 ? "+" : ""}${rate.percentageChange}%)`);
  console.log(`    Explanation   :`);
  console.log(`      "${explanation}"`);
  console.log();
}

console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed out of ${TEST_CASES.length} tests`);
console.log("══════════════════════════════════════════════════════════════════");
if (failed > 0) process.exit(1);
