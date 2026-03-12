// db.js — Database initialisation helper
// Exports a singleton better-sqlite3 instance.
// On first call it reads schema.sql and executes all CREATE TABLE statements.
// Subsequent calls return the already-open connection (no re-init).

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Singleton instance — created once, reused forever
let db = null;

/**
 * getDb()
 * Returns the open database connection, initialising it on first call.
 * The database file lives in the same db/ directory as this file.
 */
function getDb() {
  if (db) return db; // already initialised — return immediately

  // DB_PATH env var lets Railway point to a persistent volume mount.
  // In Railway: set DB_PATH=/data/demurragedx.db and mount a volume at /data.
  // Locally: falls back to ./db/demurragedx.db (next to this file).
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'demurragedx.db');

  // Ensure the directory exists — critical if /data hasn't been created yet.
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  // WAL mode: allows concurrent reads while a write is in progress.
  // Critical for a server that reads forecasts while the cron job writes them.
  db.pragma('journal_mode = WAL');

  // Foreign key enforcement (good practice even if not used yet)
  db.pragma('foreign_keys = ON');

  // Execute the full schema — all statements are IF NOT EXISTS so this is
  // safe to run on every startup without wiping existing data.
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema     = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  console.log(`[DB] Opened: ${dbPath}`);
  return db;
}

module.exports = { getDb };
