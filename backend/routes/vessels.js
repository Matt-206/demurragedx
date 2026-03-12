// backend/routes/vessels.js
// GET  /api/vessels/:portId   — returns all AIS vessels currently in range of a port
// POST /api/vessels/observe   — records an actual discharge observation

const express                    = require('express');
const { getDb }                  = require('../db/db');
const { fetchAndStoreVessels }   = require('../engine/aisService');
const { getVesselSpecs }         = require('../engine/equasisCache');
const { estimateVesselDischarge } = require('../engine/vesselEstimator');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vessels/:portId
// Returns all AIS vessel positions currently in range, enriched with TEU
// discharge estimates. Used by VesselArrivalTimeline.jsx (Section 8.2).
// Forces a fresh AIS fetch so the data is always live.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:portId', async (req, res) => {
  const { portId } = req.params;
  const db = getDb();

  try {
    // Refresh AIS data for this port (live API or mock fallback)
    const rawVessels = await fetchAndStoreVessels(portId);

    // Enrich each vessel with TEU discharge estimate
    const enriched = await Promise.all(
      rawVessels.map(async (v) => {
        try {
          const equasisData = await getVesselSpecs(v.mmsi, v.draught);

          const aisData = {
            vesselName:         v.vesselName,
            mmsi:               v.mmsi,
            draught:            v.draught || equasisData.maxDraught * 0.7,
            tradeLane:          equasisData.tradeLane || 'default',
            serviceString:      'UNKNOWN',
            remainingPortCalls: [],
            eta:                v.etaCalculated,
          };

          const estimate = estimateVesselDischarge(aisData, equasisData, portId, {});

          return {
            vesselName:      v.vesselName,
            mmsi:            v.mmsi,
            latitude:        v.latitude,
            longitude:       v.longitude,
            speedKnots:      v.speedKnots,
            draught:         v.draught,
            destination:     v.destination,
            etaHours:        v.hoursToArrival,
            eta:             v.etaCalculated,
            loadFraction:    estimate.loadFraction,
            estimatedTotalTEUs:  estimate.estimatedTotalTEUs,
            estimatedDischarge:  estimate.estimatedDischarge,
            confidence:      estimate.confidence,
            vesselSpecs: {
              teuCapacity:  equasisData.teuCapacity,
              maxDraught:   equasisData.maxDraught,
              tradeLane:    equasisData.tradeLane,
            },
          };
        } catch (err) {
          // Return vessel without estimate if specs lookup fails
          return {
            vesselName:  v.vesselName,
            mmsi:        v.mmsi,
            draught:     v.draught,
            etaHours:    v.hoursToArrival,
            eta:         v.etaCalculated,
            confidence:  'UNKNOWN',
            error:       err.message,
          };
        }
      })
    );

    res.json({ portId, vesselCount: enriched.length, vessels: enriched });

  } catch (err) {
    console.error('[Route /vessels] Error:', err);
    res.status(500).json({ error: 'Vessel fetch failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vessels/observe
// Records an actual vessel discharge observation to improve the historical
// ratio model over time (Section 7, manual).
// Body: { mmsi, vesselName, portId, serviceString, arrivalDate,
//         estimatedTEUsOnboard, actualDischarge }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/observe', (req, res) => {
  const { mmsi, vesselName, portId, serviceString, arrivalDate, estimatedTEUsOnboard, actualDischarge } = req.body;

  // Validate required fields
  if (!mmsi || !portId || !actualDischarge) {
    return res.status(400).json({ error: 'mmsi, portId, and actualDischarge are required' });
  }

  const db = getDb();

  // Calculate discharge ratio: what fraction of estimated onboard TEUs actually discharged?
  const dischargeRatio = estimatedTEUsOnboard > 0
    ? Math.round((actualDischarge / estimatedTEUsOnboard) * 1000) / 1000
    : null;

  db.prepare(`
    INSERT INTO vessel_discharge_observations
      (mmsi, vessel_name, port_id, service_string, arrival_date,
       estimated_teus_onboard, actual_discharge, discharge_ratio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mmsi, vesselName, portId, serviceString, arrivalDate,
    estimatedTEUsOnboard, actualDischarge, dischargeRatio
  );

  res.json({ message: 'Observation recorded', dischargeRatio });
});

module.exports = router;
