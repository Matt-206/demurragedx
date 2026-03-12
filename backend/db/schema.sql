-- schema.sql — DemurrageDX full database schema
-- Phase 1 tables first, then Phase 2 additions.
-- Run with: db.exec(fs.readFileSync('schema.sql', 'utf8'))
-- All CREATE TABLE statements use IF NOT EXISTS so this is safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 1: Core recommendations table
-- Stores every rate recommendation made by the engine.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id             TEXT    DEFAULT 'manual',       -- which port this is for
  yard_occupancy      REAL    NOT NULL,               -- raw input %
  gate_throughput     REAL    NOT NULL,               -- raw input moves/hr
  vessels_at_berth    INTEGER NOT NULL,               -- raw input count
  composite_score     REAL    NOT NULL,               -- 0-100 weighted score
  congestion_state    TEXT    NOT NULL,               -- SLACK/NORMAL/ELEVATED/HIGH/CRITICAL
  recommended_rate    REAL    NOT NULL,               -- output USD/day
  multiplier          REAL    NOT NULL,               -- e.g. 1.6
  baseline_rate       REAL    NOT NULL,               -- terminal baseline USD/day
  explanation         TEXT,                           -- plain English reason
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 TABLE 1: vessel_specs
-- Cache of vessel technical specifications fetched from Equasis.
-- Do NOT re-fetch if record is less than 30 days old (queried in equasisCache.js).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vessel_specs (
  mmsi               TEXT PRIMARY KEY,               -- Maritime Mobile Service Identity (9 digits)
  imo                TEXT,                            -- IMO number (7 digits)
  vessel_name        TEXT,                            -- vessel name as registered
  teu_capacity       INTEGER,                         -- maximum TEU at full load
  dwt                REAL,                            -- deadweight tonnage in metric tonnes
  lightship_draught  REAL,                            -- draught when empty (metres)
  max_draught        REAL,                            -- draught at full DWT (metres)
  vessel_length      REAL,                            -- overall length in metres
  gross_tonnage      REAL,                            -- gross tonnage (volumetric)
  trade_lane         TEXT    DEFAULT 'default',       -- e.g. asia_europe, trans_pacific
  fetched_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  source             TEXT    DEFAULT 'equasis'        -- equasis / manual / default_specs
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 TABLE 2: ais_positions
-- Live AIS vessel positions updated on each fetch cycle.
-- Keeps last 48 hours only — older rows deleted by the forecaster job.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ais_positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi             TEXT    NOT NULL,                  -- vessel identifier
  vessel_name      TEXT,
  latitude         REAL,
  longitude        REAL,
  speed_knots      REAL,
  draught          REAL,                              -- current draught in metres — feeds TEU estimator
  destination      TEXT,                              -- captain-entered, often abbreviated
  eta_raw          TEXT,                              -- captain-entered ETA string (often inaccurate)
  eta_calculated   DATETIME,                          -- computed from position + speed (more reliable)
  hours_to_arrival REAL,                              -- hours until ETA at target port
  port_id          TEXT    NOT NULL,                  -- which port this vessel is heading toward
  fetched_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast port + time queries used in the forecaster
CREATE INDEX IF NOT EXISTS idx_ais_port_time ON ais_positions (port_id, fetched_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 TABLE 3: vessel_discharge_observations
-- Records actual observed discharge volumes to train the historical ratio model.
-- Populated manually or from TOS exports when available.
-- After 20+ observations per service+port, confidence rises from LOW to HIGH.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vessel_discharge_observations (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi                     TEXT    NOT NULL,
  vessel_name              TEXT,
  port_id                  TEXT    NOT NULL,
  service_string           TEXT,                      -- shipping service code e.g. 'AEX-1'
  arrival_date             DATE,
  estimated_teus_onboard   INTEGER,                   -- what the model predicted
  actual_discharge         INTEGER,                   -- what actually happened (entered manually)
  discharge_ratio          REAL,                      -- actual / estimated_onboard
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 TABLE 4: occupancy_forecasts
-- Stored output from each hourly forecast run.
-- The frontend polls the latest row for each port.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS occupancy_forecasts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id            TEXT    NOT NULL,
  generated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_occupancy  REAL,                            -- occupancy at time of forecast
  forecast_24h       REAL,                            -- projected occupancy in 24 hours
  forecast_48h       REAL,                            -- projected occupancy in 48 hours
  forecast_72h       REAL,                            -- projected occupancy in 72 hours
  peak_forecast      REAL,                            -- max of 24/48/72 projections
  inflow_24h         INTEGER,                         -- projected TEU arrivals 0-24h
  inflow_48h         INTEGER,                         -- projected TEU arrivals 0-48h
  inflow_72h         INTEGER,                         -- projected TEU arrivals 0-72h
  outflow_24h        INTEGER,                         -- projected TEU pickups 0-24h
  outflow_48h        INTEGER,                         -- projected TEU pickups 0-48h
  outflow_72h        INTEGER,                         -- projected TEU pickups 0-72h
  weather_multiplier REAL    DEFAULT 1.0,             -- 0.2-1.0 based on forecast weather
  seasonal_index     REAL    DEFAULT 1.0,             -- 0.55-1.45 based on time of year
  vessels_incoming   INTEGER DEFAULT 0,               -- count of vessels in forecast window
  recommended_rate   REAL                             -- pre-emptive rate based on peak forecast
);

-- Index for fast latest-forecast lookup
CREATE INDEX IF NOT EXISTS idx_forecasts_port_time
  ON occupancy_forecasts (port_id, generated_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 2 TABLE 5: port_config
-- Terminal configuration. Replaces hardcoded values in the rules engine.
-- Each customer gets one row per terminal they operate.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS port_config (
  port_id                  TEXT PRIMARY KEY,
  port_name                TEXT NOT NULL,
  country                  TEXT,
  lat                      REAL,                      -- decimal degrees for bounding box + weather
  lon                      REAL,
  total_berths             INTEGER DEFAULT 4,
  total_yard_capacity      INTEGER DEFAULT 50000,     -- max TEUs the yard can hold
  baseline_gate_throughput INTEGER DEFAULT 500,       -- normal moves per 24 hours
  baseline_rate            REAL    DEFAULT 150,       -- standard daily storage rate USD
  total_teu_annual         INTEGER,                   -- annual throughput for seasonal model
  created_at               DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA: Demo Hamburg port
-- Pre-populated so the app runs without any configuration.
-- Real coordinates and realistic capacity figures for Port of Hamburg.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO port_config VALUES (
  'demo_hamburg',
  'Port of Hamburg (Demo)',
  'Germany',
  53.5415,    -- latitude: Hamburg Harbour
  9.9979,     -- longitude
  8,          -- berths: Hamburg has multiple large container terminals
  80000,      -- yard capacity: realistic for a major EU hub
  1200,       -- baseline gate: moves per 24 hours
  175,        -- baseline rate: USD per container per day
  8700000,    -- annual TEU: Hamburg processes ~8.7M TEU/year
  CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED DATA: 10 common container vessels with real Equasis data
-- Used as the initial vessel_specs cache so the demo works immediately
-- without any Equasis lookups. Real vessels that frequently call Hamburg.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO vessel_specs
  (mmsi, imo, vessel_name, teu_capacity, dwt, lightship_draught, max_draught, vessel_length, gross_tonnage, trade_lane, source)
VALUES
  -- MSC ANNA — Ultra-large container ship
  ('636019926','9839345','MSC ANNA',         23756, 228206, 4.5, 16.5, 399.9, 232000, 'asia_europe',   'manual'),
  -- EVER ACE — Evergreen ultra-large
  ('352003000','9811000','EVER ACE',          23992, 222000, 4.6, 16.0, 400.0, 235000, 'trans_pacific', 'manual'),
  -- CMA CGM MARCO POLO — large container ship
  ('228337400','9454448','CMA CGM MARCO POLO',16020, 187581, 4.2, 15.5, 396.0, 187558, 'asia_europe',   'manual'),
  -- MAERSK MC-KINNEY MOLLER
  ('220024000','9619907','MAERSK MC-KINNEY',  18270, 194849, 4.4, 16.0, 399.0, 194849, 'asia_europe',   'manual'),
  -- MSC ZOE — large container ship
  ('255806300','9703291','MSC ZOE',           19224, 199023, 4.5, 16.0, 396.0, 190813, 'asia_europe',   'manual'),
  -- COSCO SHIPPING UNIVERSE
  ('477309600','9783534','COSCO SHIPPING UNI',21237, 202995, 4.6, 16.0, 399.9, 210000, 'trans_pacific', 'manual'),
  -- ONE INNOVATION — medium container ship
  ('477543700','9820895','ONE INNOVATION',    14000, 140000, 3.9, 14.5, 366.0, 140000, 'trans_pacific', 'manual'),
  -- HAPAG-LLOYD BERLIN EXPRESS — feeder/regional
  ('211349360','9141060','BERLIN EXPRESS',     4422,  42961, 2.8, 11.0, 215.5,  36430, 'intra_europe',  'manual'),
  -- ANTJE — small feeder, calls Hamburg regularly
  ('211477410','9337849','ANTJE',              1036,   7100, 2.2,  8.0, 134.0,   5200, 'intra_europe',  'manual'),
  -- MSC HAMBURG — medium container ship, named for the port
  ('255847000','9400605','MSC HAMBURG',        9178,  85000, 3.5, 13.5, 299.9,  90000, 'north_south',   'manual');
