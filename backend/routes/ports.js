// backend/routes/ports.js
// GET  /api/ports             — list all configured ports with latest forecast summary
// POST /api/calculate         — Phase 1 rate calculator (manual inputs)
// POST /api/recommendations   — save and retrieve recommendation history

const express = require('express');
const { getDb } = require('../db/db');
const { classifyCongestionState, calculateRecommendedRate } = require('../engine/ratesEngine');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ports
// Returns all configured ports with their current occupancy and latest
// forecast summary. Feeds the port selector in the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ports', (req, res) => {
  const db = getDb();

  // Get all ports
  const ports = db.prepare('SELECT * FROM port_config ORDER BY port_name ASC').all();

  // For each port, attach the most recent forecast summary
  const portsWithForecast = ports.map(port => {
    const latestForecast = db.prepare(`
      SELECT current_occupancy, peak_forecast, forecast_24h, forecast_48h, forecast_72h,
             vessels_incoming, recommended_rate, weather_multiplier, generated_at
      FROM occupancy_forecasts
      WHERE port_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(port.port_id);

    return {
      portId:          port.port_id,
      portName:        port.port_name,
      country:         port.country,
      coordinates:     { lat: port.lat, lon: port.lon },
      totalBerths:     port.total_berths,
      baselineRate:    port.baseline_rate,
      totalYardCapacity: port.total_yard_capacity,
      forecast: latestForecast
        ? {
            currentOccupancy:  latestForecast.current_occupancy,
            peakForecast:      latestForecast.peak_forecast,
            forecast24h:       latestForecast.forecast_24h,
            forecast48h:       latestForecast.forecast_48h,
            forecast72h:       latestForecast.forecast_72h,
            vesselsIncoming:   latestForecast.vessels_incoming,
            recommendedRate:   latestForecast.recommended_rate,
            weatherMultiplier: latestForecast.weather_multiplier,
            generatedAt:       latestForecast.generated_at,
          }
        : null, // no forecast run yet for this port
    };
  });

  res.json({ ports: portsWithForecast });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/calculate
// Phase 1 rate calculator — accepts manual inputs, returns rate recommendation.
// Does NOT save to DB — use /api/recommendations to persist.
// Body: { yardOccupancy, gateThroughput, vesselsAtBerth,
//         baselineGateThroughput, totalBerths, baselineRate, portId? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/calculate', (req, res) => {
  const {
    yardOccupancy,
    gateThroughput,
    vesselsAtBerth,
    baselineGateThroughput,
    totalBerths,
    baselineRate,
    portId = 'manual',
  } = req.body;

  // Validate all required numeric inputs
  const required = { yardOccupancy, gateThroughput, vesselsAtBerth, baselineGateThroughput, totalBerths, baselineRate };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || isNaN(Number(val))) {
      return res.status(400).json({ error: `Missing or invalid field: ${key}` });
    }
  }

  const config = {
    baselineGateThroughput: Number(baselineGateThroughput),
    totalBerths:            Number(totalBerths),
  };

  const congestion = classifyCongestionState(
    Number(yardOccupancy),
    Number(gateThroughput),
    Number(vesselsAtBerth),
    config
  );

  const rateResult = calculateRecommendedRate(congestion, Number(baselineRate));

  res.json({ congestion, rate: rateResult });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/recommendations
// Saves a rate recommendation to the DB with full audit trail.
// Body: same as /api/calculate plus optional { explanation }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/recommendations', (req, res) => {
  const {
    yardOccupancy, gateThroughput, vesselsAtBerth,
    baselineGateThroughput, totalBerths, baselineRate,
    portId = 'manual', explanation = null,
  } = req.body;

  const config = {
    baselineGateThroughput: Number(baselineGateThroughput),
    totalBerths:            Number(totalBerths),
  };

  const congestion = classifyCongestionState(
    Number(yardOccupancy), Number(gateThroughput), Number(vesselsAtBerth), config
  );
  const rateResult = calculateRecommendedRate(congestion, Number(baselineRate));

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO recommendations
      (port_id, yard_occupancy, gate_throughput, vessels_at_berth,
       composite_score, congestion_state, recommended_rate, multiplier, baseline_rate, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    portId, yardOccupancy, gateThroughput, vesselsAtBerth,
    congestion.compositeScore, congestion.state,
    rateResult.recommendedRate, rateResult.multiplier, baselineRate, explanation
  );

  res.json({ id: result.lastInsertRowid, congestion, rate: rateResult });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/recommendations
// Returns recent recommendation history for the dashboard audit trail.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/recommendations', (req, res) => {
  const db    = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100); // max 100 rows
  const rows  = db.prepare(
    'SELECT * FROM recommendations ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json({ recommendations: rows });
});

module.exports = router;
