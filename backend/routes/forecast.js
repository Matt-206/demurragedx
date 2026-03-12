// backend/routes/forecast.js
// GET  /api/forecast/:portId  — returns latest stored forecast for a port
// POST /api/forecast/trigger  — manually triggers a fresh forecast recalculation

const express            = require('express');
const { getDb }          = require('../db/db');
const { generateForecast } = require('../engine/occupancyForecaster');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forecast/:portId
// Returns the most recently generated occupancy forecast.
// The frontend polls this every 5 minutes (Section 8 of manual).
// If no forecast exists yet, triggers an immediate generation.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:portId', async (req, res) => {
  const { portId } = req.params;
  const db = getDb();

  // Load port configuration from DB — needed for forecast generation
  const portRow = db.prepare('SELECT * FROM port_config WHERE port_id = ?').get(portId);
  if (!portRow) {
    return res.status(404).json({ error: `Port '${portId}' not found in port_config table` });
  }

  // Check for a stored forecast generated in the last 90 minutes
  const stored = db.prepare(`
    SELECT * FROM occupancy_forecasts
    WHERE port_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(portId);

  // If the stored forecast is recent enough, return it quickly without recalculating
  const isRecent = stored && (Date.now() - new Date(stored.generated_at).getTime()) < 90 * 60_000;

  if (isRecent) {
    // Also fetch the incoming vessels for the response (stored separately in ais_positions)
    const vessels = db.prepare(`
      SELECT * FROM ais_positions
      WHERE port_id = ? AND hours_to_arrival <= 72
      ORDER BY hours_to_arrival ASC
    `).all(portId);

    // Return the stored forecast in the same shape as a fresh generateForecast() result
    return res.json({
      portId:           stored.port_id,
      portName:         portRow.port_name,
      generatedAt:      stored.generated_at,
      currentOccupancy: stored.current_occupancy,
      forecast: {
        h24: { occupancy: stored.forecast_24h, inflow: stored.inflow_24h, outflow: stored.outflow_24h },
        h48: { occupancy: stored.forecast_48h, inflow: stored.inflow_48h, outflow: stored.outflow_48h },
        h72: { occupancy: stored.forecast_72h, inflow: stored.inflow_72h, outflow: stored.outflow_72h },
      },
      peakOccupancy:    stored.peak_forecast,
      weatherMultiplier: stored.weather_multiplier,
      seasonalIndex:    stored.seasonal_index,
      recommendedRate: {
        basedOnPeak:     true,
        recommendedRate: stored.recommended_rate,
        baselineRate:    portRow.baseline_rate,
      },
      incomingVessels:  vessels.map(v => ({
        vesselName:    v.vessel_name,
        mmsi:          v.mmsi,
        etaHours:      v.hours_to_arrival,
        eta:           v.eta_calculated,
        draught:       v.draught,
        // Full discharge estimates are stored in the forecast — vessel row only has position data
      })),
    });
  }

  // No recent forecast — generate one now
  try {
    const portConfig = buildPortConfig(portRow);
    // Default current occupancy to 65% if not provided — port manager will override
    const currentOccupancy = req.query.occupancy ? parseFloat(req.query.occupancy) : 65;
    const forecast = await generateForecast(portConfig, currentOccupancy);
    res.json(forecast);
  } catch (err) {
    console.error('[Route /forecast] Error:', err);
    res.status(500).json({ error: 'Forecast generation failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forecast/trigger
// Manually triggers a fresh forecast. Used during demos to refresh live.
// Body: { portId: string, currentOccupancy: number }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/trigger', async (req, res) => {
  const { portId = 'demo_hamburg', currentOccupancy = 65 } = req.body;
  const db = getDb();

  const portRow = db.prepare('SELECT * FROM port_config WHERE port_id = ?').get(portId);
  if (!portRow) {
    return res.status(404).json({ error: `Port '${portId}' not found` });
  }

  try {
    const portConfig = buildPortConfig(portRow);
    const forecast   = await generateForecast(portConfig, currentOccupancy);
    res.json({ message: 'Forecast regenerated', forecast });
  } catch (err) {
    console.error('[Route /forecast/trigger] Error:', err);
    res.status(500).json({ error: 'Forecast trigger failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPortConfig(row)
// Maps a DB port_config row (snake_case) to the portConfig shape expected
// by the forecaster and rates engine (camelCase).
// ─────────────────────────────────────────────────────────────────────────────
function buildPortConfig(row) {
  return {
    portId:                 row.port_id,
    portName:               row.port_name,
    totalBerths:            row.total_berths,
    totalYardCapacity:      row.total_yard_capacity,
    baselineGateThroughput: row.baseline_gate_throughput,
    baselineRate:           row.baseline_rate,
    portId:                 row.port_id,
    coordinates:            { lat: row.lat, lon: row.lon },
  };
}

module.exports = router;
