// backend/engine/aisService.js
// AIS (Automatic Identification System) vessel position fetcher.
//
// Section 5.1 of the manual specifies VesselFinder/VesselTracker API for dev/demo.
// This module:
//   1. Attempts a live API fetch if AIS_API_KEY is set in environment.
//   2. Falls back to realistic mock data for Hamburg (demo mode) if no key.
//
// The architecture is identical for any AIS source — only URL and auth change.
// Mock data uses realistic vessels that actually call Hamburg so demos look real.

const { getDb }          = require('../db/db');
const { getVesselSpecs } = require('./equasisCache');

// ─────────────────────────────────────────────────────────────────────────────
// PORT BOUNDING BOXES — Appendix B of the manual
// Define the geographic rectangle around each port for AIS queries.
// Only vessels inside the box (or heading toward it) are relevant.
// ─────────────────────────────────────────────────────────────────────────────
const PORT_BOUNDS = {
  demo_hamburg: { minLat: 53.3, maxLat: 53.7, minLon: 9.5,    maxLon: 10.2  },
  hamburg:      { minLat: 53.3, maxLat: 53.7, minLon: 9.5,    maxLon: 10.2  },
  rotterdam:    { minLat: 51.7, maxLat: 52.0, minLon: 3.8,    maxLon: 4.6   },
  antwerp:      { minLat: 51.1, maxLat: 51.4, minLon: 4.2,    maxLon: 4.6   },
  savannah:     { minLat: 31.8, maxLat: 32.2, minLon: -81.3,  maxLon: -80.8 },
  houston:      { minLat: 29.5, maxLat: 29.9, minLon: -95.2,  maxLon: -94.7 },
  los_angeles:  { minLat: 33.5, maxLat: 34.0, minLon: -118.6, maxLon: -117.9},
};

// AIS vessel type codes for container ships.
// Types 70-79 are cargo vessels; 80-89 are tankers (excluded).
const CONTAINER_SHIP_TYPES = [71, 72, 73, 74, 79];

// Hamburg port entrance coordinates — used as the arrival target for ETA calc.
const PORT_COORDINATES = {
  demo_hamburg: { lat: 53.5415, lon: 9.9979 },
  hamburg:      { lat: 53.5415, lon: 9.9979 },
  rotterdam:    { lat: 51.8900, lon: 4.2400 },
  antwerp:      { lat: 51.2600, lon: 4.4000 },
  savannah:     { lat: 32.0800, lon: -81.10 },
  houston:      { lat: 29.7300, lon: -95.10 },
  los_angeles:  { lat: 33.7400, lon: -118.25},
};

// ─────────────────────────────────────────────────────────────────────────────
// HAVERSINE DISTANCE — great-circle distance between two lat/lon points
// Returns distance in nautical miles.
// Used to compute ETA from current position + vessel speed.
// ─────────────────────────────────────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 3440.1; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * calculateETA(vessel, portCoordinates)
 * Computes a more accurate ETA than the captain-entered AIS field.
 * Uses current position + speed + haversine distance to port entrance.
 * Falls back to 12 knots as the default steaming speed for stopped/slow vessels.
 */
function calculateETA(vessel, portCoords) {
  const distanceNM   = haversineDistance(vessel.latitude, vessel.longitude, portCoords.lat, portCoords.lon);
  const speedKnots   = vessel.speedKnots > 2 ? vessel.speedKnots : 12; // 12kn default if at anchor/slow
  const hoursToArrival = distanceNM / speedKnots;
  const eta          = new Date(Date.now() + hoursToArrival * 3_600_000);
  return { eta, hoursToArrival: Math.round(hoursToArrival) };
}

/**
 * parseAISVessel(raw, portId)
 * Normalises a raw AIS API record into the standard internal format.
 */
function parseAISVessel(raw, portId) {
  return {
    mmsi:          raw.mmsi,
    imo:           raw.imo,
    vesselName:    raw.name || raw.vesselName || 'Unknown',
    latitude:      raw.lat  || raw.latitude,
    longitude:     raw.lng  || raw.lon || raw.longitude,
    speedKnots:    raw.speed || raw.speedKnots || 0,
    courseDegrees: raw.course || 0,
    draught:       raw.draught || 0,    // CRITICAL: feeds the TEU estimator
    destination:   raw.destination || '', // captain-entered, often abbreviated
    etaRaw:        raw.eta || '',         // captain-entered, often inaccurate
    portId,
    fetchedAt:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — realistic Hamburg vessel traffic for demo mode
// These are real vessel names and realistic draught values for the vessel class.
// Used when AIS_API_KEY is not configured.
// ─────────────────────────────────────────────────────────────────────────────
function getMockVessels(portId) {
  const now = Date.now();

  // Simulate vessels at various distances from Hamburg (different ETAs)
  return [
    {
      mmsi: '636019926', imo: '9839345', name: 'MSC ANNA',
      lat: 54.12, lng: 8.80, // ~65 NM from Hamburg
      speed: 14.2, course: 120, draught: 14.2,
      destination: 'DEHAM', eta: new Date(now + 4.6 * 3_600_000).toISOString(),
    },
    {
      mmsi: '255806300', imo: '9703291', name: 'MSC ZOE',
      lat: 55.40, lng: 7.20, // ~130 NM from Hamburg
      speed: 13.8, course: 135, draught: 15.1,
      destination: 'DEHAM', eta: new Date(now + 9.5 * 3_600_000).toISOString(),
    },
    {
      mmsi: '228337400', imo: '9454448', name: 'CMA CGM MARCO POLO',
      lat: 56.10, lng: 5.50, // ~200 NM from Hamburg
      speed: 15.5, course: 100, draught: 13.8,
      destination: 'DEHAM', eta: new Date(now + 13.0 * 3_600_000).toISOString(),
    },
    {
      mmsi: '477309600', imo: '9783534', name: 'COSCO SHIPPING UNI',
      lat: 57.20, lng: 3.80, // ~280 NM from Hamburg
      speed: 16.0, course: 110, draught: 14.9,
      destination: 'DEHAM', eta: new Date(now + 17.5 * 3_600_000).toISOString(),
    },
    {
      mmsi: '211349360', imo: '9141060', name: 'BERLIN EXPRESS',
      lat: 53.80, lng: 8.30, // ~50 NM, intra-Europe feeder
      speed: 12.0, course: 95, draught: 9.8,
      destination: 'DEHAM', eta: new Date(now + 4.0 * 3_600_000).toISOString(),
    },
  ].map(v => parseAISVessel(v, portId));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE API FETCH — VesselFinder/VesselTracker API (Section 5.1)
// Only called when AIS_API_KEY is set in the environment.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLiveVessels(portId, apiKey) {
  const bounds = PORT_BOUNDS[portId];
  if (!bounds) throw new Error(`Unknown port: ${portId}`);

  // VesselFinder API endpoint with bounding box filter
  const url = `https://api.vesseltracker.com/api/v1/vessels?` +
    `userkey=${apiKey}` +
    `&lat1=${bounds.minLat}&lon1=${bounds.minLon}` +
    `&lat2=${bounds.maxLat}&lon2=${bounds.maxLon}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`AIS API error: ${response.status} ${response.statusText}`);

  const data = await response.json();

  // Filter to container ship types only — exclude tankers, bulk, passenger, etc.
  return data.vessels
    .filter(v => CONTAINER_SHIP_TYPES.includes(v.type))
    .map(v => parseAISVessel(v, portId));
}

/**
 * fetchAndStoreVessels(portId)
 * Main public function called by the cron job and /api/forecast/trigger.
 *
 * 1. Fetches vessels (live or mock).
 * 2. Computes ETA for each vessel using haversine.
 * 3. Stores in ais_positions table (replaces positions older than 48h).
 * 4. Returns the enriched vessel list.
 */
async function fetchAndStoreVessels(portId) {
  const db        = getDb();
  const apiKey    = process.env.AIS_API_KEY;
  const portCoords = PORT_COORDINATES[portId] || PORT_COORDINATES['demo_hamburg'];

  // ── Fetch raw vessel data (live or mock) ─────────────────────────────────
  let rawVessels;
  if (apiKey) {
    console.log(`[AIS] Fetching live vessels for ${portId} from VesselFinder API`);
    rawVessels = await fetchLiveVessels(portId, apiKey);
  } else {
    console.log(`[AIS] No AIS_API_KEY set — using mock vessels for ${portId} (demo mode)`);
    rawVessels = getMockVessels(portId);
  }

  // ── Enrich each vessel with computed ETA ─────────────────────────────────
  const enriched = rawVessels.map(vessel => {
    const { eta, hoursToArrival } = calculateETA(vessel, portCoords);
    return { ...vessel, etaCalculated: eta.toISOString(), hoursToArrival };
  });

  // ── Delete stale positions (older than 48 hours) ──────────────────────────
  db.prepare(`DELETE FROM ais_positions WHERE fetched_at < datetime('now', '-48 hours')`).run();

  // ── Store enriched positions ──────────────────────────────────────────────
  const insertStmt = db.prepare(`
    INSERT INTO ais_positions
      (mmsi, vessel_name, latitude, longitude, speed_knots, draught,
       destination, eta_raw, eta_calculated, hours_to_arrival, port_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(vessels => {
    for (const v of vessels) {
      insertStmt.run(
        v.mmsi, v.vesselName, v.latitude, v.longitude, v.speedKnots,
        v.draught, v.destination, v.etaRaw, v.etaCalculated, v.hoursToArrival, v.portId
      );
    }
  });

  insertAll(enriched);
  console.log(`[AIS] Stored ${enriched.length} vessels for ${portId}`);
  return enriched;
}

/**
 * getRecentVessels(portId, maxHours)
 * Returns AIS positions stored in the last maxHours (default 2) for a port.
 * Called by the forecaster to get the current vessel picture.
 */
function getRecentVessels(portId, maxHours = 2) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM ais_positions
    WHERE port_id = ?
      AND fetched_at > datetime('now', ? || ' hours')
    ORDER BY hours_to_arrival ASC
  `).all(portId, `-${maxHours}`);
}

module.exports = { fetchAndStoreVessels, getRecentVessels, haversineDistance, calculateETA };
