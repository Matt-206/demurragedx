// backend/engine/equasisCache.js
// Vessel technical specification cache backed by SQLite.
//
// Equasis (equasis.org) maintains the official EU register of vessel specs.
// It has no public REST API — data is accessed via web UI or screen scraping.
// This module provides a caching layer:
//   1. Check DB for a record fetched within the last 30 days → return it.
//   2. Attempt fetchFromEquasis() → placeholder, requires scraper implementation.
//   3. Fall back to getDefaultSpecsForSize() using gross tonnage size category.
//
// The 10 seed vessels in schema.sql (source='manual') mean the demo works
// immediately without any Equasis lookups.

const { getDb } = require('../db/db');

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SPECS BY VESSEL SIZE CATEGORY
// Used when Equasis lookup fails. Covers ~85% of cases adequately for the
// TEU estimation model (per manual Section 5.2).
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SPECS = {
  // Very large container ships (VLCS): 18,000+ TEU
  large: {
    teuCapacity:      18000,
    dwt:             185000,
    lightshipDraught:   4.5,
    maxDraught:        16.0,
    vesselLength:      400.0,
    grossTonnage:    190000,
    tradeLane:       'asia_europe',
  },
  // Large container ships: 8,000–17,999 TEU
  medium: {
    teuCapacity:      10000,
    dwt:             115000,
    lightshipDraught:   3.8,
    maxDraught:        14.5,
    vesselLength:      335.0,
    grossTonnage:    115000,
    tradeLane:       'trans_pacific',
  },
  // Medium container ships: 2,000–7,999 TEU
  small: {
    teuCapacity:       4500,
    dwt:              50000,
    lightshipDraught:   3.2,
    maxDraught:        12.5,
    vesselLength:      250.0,
    grossTonnage:     50000,
    tradeLane:       'north_south',
  },
  // Feeder vessels: under 2,000 TEU
  feeder: {
    teuCapacity:       1500,
    dwt:              18000,
    lightshipDraught:   2.5,
    maxDraught:         9.5,
    vesselLength:      160.0,
    grossTonnage:     18000,
    tradeLane:       'intra_europe',
  },
};

/**
 * classifyVesselByDraught(draught)
 * Infers a size category from the observed AIS draught when no DB record exists.
 * Draught is the single most reliable indicator of vessel size available from AIS.
 */
function classifyVesselByDraught(draught) {
  if (draught >= 14.0) return 'large';  // very large container ship
  if (draught >= 11.0) return 'medium'; // large container ship
  if (draught >= 8.0)  return 'small';  // medium container ship
  return 'feeder';                       // small feeder
}

/**
 * fetchFromEquasis(mmsi)
 * Placeholder for an Equasis web scraper or manual data entry pipeline.
 * Returns null — triggering the fallback default specs.
 *
 * To implement: scrape equasis.org/EquasisWeb/restricted/textSearch
 * using a headless browser after registration. Cache aggressively — specs
 * don't change (vessels don't rebuild). Re-fetch only every 30+ days.
 */
async function fetchFromEquasis(mmsi) {
  // NOT IMPLEMENTED: Equasis has no REST API.
  // Implement scraper here if/when required by a paying customer.
  // For demo purposes, the 10 seeded vessels in schema.sql are sufficient.
  return null;
}

/**
 * getVesselSpecs(mmsi, draughtHint)
 * Main public function. Returns vessel specs from cache or falls back to defaults.
 *
 * @param {string} mmsi         9-digit MMSI from AIS
 * @param {number} draughtHint  Current AIS draught, used to classify size if no record found
 * @returns {object}            Vessel spec object with all fields needed by vesselEstimator
 */
async function getVesselSpecs(mmsi, draughtHint = 12.0) {
  const db = getDb();

  // ── Check cache: record must be less than 30 days old ───────────────────
  const cached = db.prepare(`
    SELECT * FROM vessel_specs
    WHERE mmsi = ?
      AND fetched_at > datetime('now', '-30 days')
  `).get(mmsi);

  if (cached) {
    // Normalise DB column names to camelCase for use in the estimator
    return {
      mmsi:             cached.mmsi,
      imo:              cached.imo,
      vesselName:       cached.vessel_name,
      teuCapacity:      cached.teu_capacity,
      dwt:              cached.dwt,
      lightshipDraught: cached.lightship_draught,
      maxDraught:       cached.max_draught,
      vesselLength:     cached.vessel_length,
      grossTonnage:     cached.gross_tonnage,
      tradeLane:        cached.trade_lane || 'default',
      source:           cached.source,
    };
  }

  // ── Cache miss: attempt Equasis lookup ───────────────────────────────────
  const equasisData = await fetchFromEquasis(mmsi);

  // ── Fall back to size-category defaults ─────────────────────────────────
  const category = classifyVesselByDraught(draughtHint);
  const specs    = equasisData || { ...DEFAULT_SPECS[category], source: 'default_specs' };
  specs.mmsi     = mmsi;

  // ── Store in cache so the next call is a fast DB hit ─────────────────────
  db.prepare(`
    INSERT OR REPLACE INTO vessel_specs
      (mmsi, teu_capacity, dwt, lightship_draught, max_draught,
       vessel_length, gross_tonnage, trade_lane, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    specs.mmsi,
    specs.teuCapacity,
    specs.dwt,
    specs.lightshipDraught,
    specs.maxDraught,
    specs.vesselLength,
    specs.grossTonnage,
    specs.tradeLane,
    specs.source || 'default_specs'
  );

  return specs;
}

/**
 * storeVesselSpec(spec)
 * Manually upsert a vessel spec (e.g. from manual Equasis lookup or CSV import).
 * Use this to add real data for vessels that are in the demo port bounding box.
 */
function storeVesselSpec(spec) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO vessel_specs
      (mmsi, imo, vessel_name, teu_capacity, dwt, lightship_draught,
       max_draught, vessel_length, gross_tonnage, trade_lane, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.mmsi, spec.imo, spec.vesselName, spec.teuCapacity, spec.dwt,
    spec.lightshipDraught, spec.maxDraught, spec.vesselLength,
    spec.grossTonnage, spec.tradeLane || 'default', spec.source || 'manual'
  );
}

module.exports = { getVesselSpecs, storeVesselSpec };
