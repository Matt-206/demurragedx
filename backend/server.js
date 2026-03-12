// backend/server.js
// DemurrageDX Express server — Phase 1 + Phase 2.
// Initialises the database, mounts all routes, and starts the hourly
// forecast cron job.

const express  = require('express');
const cron     = require('node-cron');
const { getDb } = require('./db/db');

// ── Routes ────────────────────────────────────────────────────────────────────
const forecastRouter = require('./routes/forecast');
const vesselsRouter  = require('./routes/vessels');
const portsRouter    = require('./routes/ports');

const app  = express();
// Railway injects PORT automatically. Fall back to 3001 for local dev.
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());

// ── CORS ───────────────────────────────────────────────────────────────────────
// In production, Vercel's edge rewrites /api/* server-side, so the browser
// never directly hits Railway — CORS isn't strictly needed for that path.
// We still set it correctly for:
//   - Local Vite dev server (port 5173)
//   - Any direct API calls (Postman, mobile, future integrations)
//   - Safety: if the Vercel rewrite ever changes to a client-side redirect
//
// Set ALLOWED_ORIGIN in Railway to your Vercel URL, e.g.:
//   https://demurragedx.vercel.app
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',           // Vite dev
  'http://localhost:4173',           // Vite preview
  process.env.ALLOWED_ORIGIN,        // Set in Railway → your Vercel URL
].filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Reflect the request origin back only if it is on the allow-list.
  // This avoids sending a wildcard while still supporting all legitimate origins.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin'); // required when reflecting dynamic origins
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Database initialisation ────────────────────────────────────────────────────
// Calling getDb() here on startup creates the file and runs schema.sql.
// All subsequent calls return the same singleton connection.
getDb();

// ── Mount routes ───────────────────────────────────────────────────────────────
app.use('/api/forecast',         forecastRouter);
app.use('/api/vessels',          vesselsRouter);
app.use('/api',                  portsRouter);    // /api/ports, /api/calculate, /api/recommendations

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Hourly forecast cron job ───────────────────────────────────────────────────
// Runs at minute 0 of every hour.
// Iterates all configured ports and regenerates their occupancy forecast.
// Uses 65% as the default current occupancy — in production the port manager
// either enters the real figure in the Rate Calculator or the TOS pushes it.
cron.schedule('0 * * * *', async () => {
  const db = getDb();
  console.log('[Cron] Running hourly forecast update...');

  const ports = db.prepare('SELECT * FROM port_config').all();

  for (const port of ports) {
    try {
      const { generateForecast } = require('./engine/occupancyForecaster');
      const portConfig = {
        portId:                 port.port_id,
        portName:               port.port_name,
        totalBerths:            port.total_berths,
        totalYardCapacity:      port.total_yard_capacity,
        baselineGateThroughput: port.baseline_gate_throughput,
        baselineRate:           port.baseline_rate,
        coordinates:            { lat: port.lat, lon: port.lon },
      };

      // Pull the most recent manual occupancy reading (or default to 65%)
      const latestRec = db.prepare(
        'SELECT yard_occupancy FROM recommendations WHERE port_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(port.port_id);

      const currentOccupancy = latestRec?.yard_occupancy ?? 65;
      await generateForecast(portConfig, currentOccupancy);
      console.log(`[Cron] Forecast updated for ${port.port_id}`);

    } catch (err) {
      // Log but do not crash — one port failing should not affect others.
      console.error(`[Cron] Forecast failed for ${port.port_id}:`, err.message);
    }
  }

  console.log('[Cron] Hourly update complete.');
});

// ── Start server ────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  // Bind to 0.0.0.0 so Railway's internal network can reach it (not just localhost).
  console.log(`DemurrageDX backend running on http://0.0.0.0:${PORT}`);
  console.log('  GET  /health');
  console.log('  GET  /api/ports');
  console.log('  POST /api/calculate');
  console.log('  POST /api/recommendations');
  console.log('  GET  /api/recommendations');
  console.log('  GET  /api/forecast/:portId');
  console.log('  POST /api/forecast/trigger');
  console.log('  GET  /api/vessels/:portId');
  console.log('  POST /api/vessels/observe');
});
