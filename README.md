# DemurrageDX

Dynamic storage pricing dashboard for port terminal operators. Recommends
demurrage rates in real time based on yard congestion, and forecasts occupancy
72 hours ahead using live AIS vessel data.

---

## Local Development

### Prerequisites
- Node.js 18+  |  npm 9+

### Start the backend
```bash
cd backend
npm install
node server.js
# Runs on http://localhost:3001
```

### Start the frontend
```bash
cd frontend
npm install
npm run dev
# Runs on http://localhost:5173
# /api/* is proxied to localhost:3001 via vite.config.js — no env vars needed
```

---

## Deployment

Deploy **backend first** — you need its URL to configure the frontend.

---

### Step 1 — Deploy Backend to Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select this repo. Set **Root Directory** to `backend`
3. Railway auto-detects Node and runs `npm start` → `node server.js`

#### Set environment variables (Railway → Variables tab)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ALLOWED_ORIGIN` | *(leave blank for now — fill in after Step 2)* |
| `DB_PATH` | `/data/demurragedx.db` |
| `AIS_API_KEY` | *(optional — leave blank for demo mock data)* |

> **Do not set PORT** — Railway injects it automatically.

#### Add a persistent volume (keeps the DB across deploys)

Railway service → **Volumes** tab → **Add Volume** → Mount path: `/data`

#### Copy your Railway URL

**Settings → Domains** → e.g. `https://demurragedx-production.up.railway.app`

---

### Step 2 — Deploy Frontend to Vercel

#### 2a. Put your Railway URL in vercel.json

Edit `frontend/vercel.json` — replace `RAILWAY_APP_URL` with the URL from Step 1:

```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://demurragedx-production.up.railway.app/api/:path*"
    },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

Commit and push.

#### 2b. Create the Vercel project

1. [vercel.com](https://vercel.com) → **Add New Project** → import this repo
2. **Root Directory:** `frontend`
3. **Framework:** Vite
4. **Build command:** `npm run build`
5. **Output directory:** `dist`
6. Click **Deploy**

#### Copy your Vercel URL

e.g. `https://demurragedx.vercel.app`

---

### Step 3 — Wire CORS back to Railway

Railway service → **Variables** → add:

| Variable | Value |
|---|---|
| `ALLOWED_ORIGIN` | `https://demurragedx.vercel.app` |

Railway redeploys automatically. That's it — the app is live.

---

## Environment Variables Reference

### Backend (Railway)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | — | Set to `production` |
| `PORT` | Auto | — | Injected by Railway — do not set |
| `ALLOWED_ORIGIN` | Yes | — | Your Vercel URL e.g. `https://demurragedx.vercel.app` |
| `DB_PATH` | Yes | `./db/demurragedx.db` | Set to `/data/demurragedx.db` in Railway |
| `AIS_API_KEY` | No | — | VesselFinder key — blank = 5 mock vessels (demo) |

### Frontend (Vercel)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | No | `""` | Leave blank — `vercel.json` rewrites handle routing |

---

## How the proxy works

```
Browser
  └─ GET /api/forecast/demo_hamburg
       │
       ▼
  Vercel edge (vercel.json rewrite — server-side, invisible to browser)
       │
       ▼
  Railway  https://demurragedx-production.up.railway.app/api/forecast/demo_hamburg
       │
       ▼
  Express → SQLite + Open-Meteo + AIS (mock or live)
```

The browser always talks to your Vercel domain. Railway is never exposed in
the browser's network panel. CORS is not required for the proxied path but is
configured anyway for direct API access (Postman, future mobile app, etc.).

---

## Running Tests

```bash
# vesselEstimator unit tests (22 assertions)
node backend/engine/vesselEstimator.test.js

# ratesEngine unit tests — all 5 congestion states (5/5 pass)
node frontend/src/utils/ratesEngine.test.mjs
```

---

## Project Structure

```
demurragedx/
├── frontend/                    Vite + React 19 + Tailwind 4 + Recharts 3
│   ├── src/
│   │   ├── components/
│   │   │   ├── RateCalculator.jsx        Phase 1 — manual rate input
│   │   │   ├── OccupancyForecastChart.jsx Phase 2 — 72h Recharts line chart
│   │   │   ├── VesselArrivalTimeline.jsx  Phase 2 — AIS vessel timeline
│   │   │   ├── CongestionPressureIndex.jsx Phase 2 — pressure widget
│   │   │   └── PreEmptiveRateCard.jsx     Phase 2 — now/forecast toggle
│   │   └── utils/
│   │       ├── ratesEngine.js             Core pricing logic (pure functions)
│   │       └── api.js                     Base URL helper for fetch calls
│   ├── vercel.json               Vercel deploy config + API proxy rewrites
│   └── .env.example
│
├── backend/                     Node 24 + Express 5 + better-sqlite3
│   ├── db/
│   │   ├── schema.sql             6 tables + 10 seed vessels + demo port
│   │   └── db.js                  SQLite singleton with env-aware path
│   ├── engine/
│   │   ├── ratesEngine.js         CommonJS port of frontend rules engine
│   │   ├── vesselEstimator.js     Draught → TEU pipeline (Section 3.2)
│   │   ├── equasisCache.js        Vessel spec cache (30-day TTL)
│   │   ├── aisService.js          VesselFinder API + mock fallback
│   │   └── occupancyForecaster.js 72h forecast orchestrator
│   ├── routes/
│   │   ├── forecast.js            GET /api/forecast/:portId, POST /trigger
│   │   ├── vessels.js             GET /api/vessels/:portId, POST /observe
│   │   └── ports.js               GET /api/ports, POST /calculate, /recommendations
│   ├── server.js                  Entry point — PORT env, CORS, cron job
│   └── .env.example
│
└── README.md
```
