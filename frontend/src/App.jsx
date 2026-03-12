// App.jsx — DemurrageDX root component
// Two tabs: Rate Calculator (Phase 1) and Forecast (Phase 2).
// Forecast tab polls /api/forecast/demo_hamburg every 5 minutes.

import { useState, useEffect, useCallback } from 'react'
import RateCalculator            from './components/RateCalculator'
import OccupancyForecastChart   from './components/OccupancyForecastChart'
import VesselArrivalTimeline    from './components/VesselArrivalTimeline'
import CongestionPressureIndex  from './components/CongestionPressureIndex'
import PreEmptiveRateCard       from './components/PreEmptiveRateCard'
import { api }                  from './utils/api'

// Demo port — matches the seed row in schema.sql
const PORT_ID = 'demo_hamburg'

// Poll interval for the forecast tab: 5 minutes in milliseconds
const POLL_INTERVAL_MS = 5 * 60 * 1000

export default function App() {
  const [activeTab, setActiveTab]     = useState('calculator')
  const [forecastData, setForecastData] = useState(null)
  const [vessels, setVessels]         = useState([])
  const [loading, setLoading]         = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [error, setError]             = useState(null)

  // ── Fetch forecast + vessels from backend ──────────────────────────────────
  const fetchForecast = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch forecast (includes vessel TEU estimates embedded in incomingVessels)
      const [forecastRes, vesselsRes] = await Promise.all([
        fetch(api(`/api/forecast/${PORT_ID}`)),
        fetch(api(`/api/vessels/${PORT_ID}`)),
      ])

      if (!forecastRes.ok) throw new Error(`Forecast API ${forecastRes.status}`)
      if (!vesselsRes.ok)  throw new Error(`Vessels API ${vesselsRes.status}`)

      const forecastJson = await forecastRes.json()
      const vesselsJson  = await vesselsRes.json()

      setForecastData(forecastJson)
      setVessels(vesselsJson.vessels ?? [])
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.message)
      console.error('[App] Fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch on first mount and whenever the Forecast tab is opened
  useEffect(() => {
    if (activeTab === 'forecast') {
      fetchForecast()
      const timer = setInterval(fetchForecast, POLL_INTERVAL_MS)
      return () => clearInterval(timer)
    }
  }, [activeTab, fetchForecast])

  // Manual refresh trigger (calls POST /api/forecast/trigger for fresh data)
  async function handleManualRefresh() {
    setLoading(true)
    try {
      await fetch(api('/api/forecast/trigger'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ portId: PORT_ID, currentOccupancy: forecastData?.currentOccupancy ?? 65 }),
      })
      await fetchForecast()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Top navigation bar ───────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* Logo + wordmark */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">DX</span>
            </div>
            <div>
              <div className="font-bold text-gray-900 leading-tight">DemurrageDX</div>
              <div className="text-xs text-gray-400 leading-tight">Dynamic Storage Pricing</div>
            </div>
          </div>

          {/* Port badge */}
          <div className="hidden sm:flex items-center gap-2 text-sm text-gray-500">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse" />
            Port of Hamburg (Demo)
          </div>
        </div>

        {/* Tab bar */}
        <div className="max-w-6xl mx-auto px-6 flex gap-0">
          {[
            { id: 'calculator', label: '⚡ Rate Calculator' },
            { id: 'forecast',   label: '📡 Forecast' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-teal-600 text-teal-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-6 py-8">

        {/* ── Rate Calculator tab (Phase 1) ───────────────────────── */}
        {activeTab === 'calculator' && <RateCalculator />}

        {/* ── Forecast tab (Phase 2) ──────────────────────────────── */}
        {activeTab === 'forecast' && (
          <div className="space-y-6">
            {/* Forecast header + refresh */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-800">72-Hour Occupancy Forecast</h2>
                <p className="text-sm text-gray-400">
                  {lastUpdated
                    ? `Updated ${lastUpdated.toLocaleTimeString()} · auto-refreshes every 5 min`
                    : 'Loading forecast data…'}
                </p>
              </div>
              <button
                onClick={handleManualRefresh}
                disabled={loading}
                className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-teal-300 text-teal-700 hover:bg-teal-50 disabled:opacity-50 transition-colors"
              >
                {loading ? (
                  <span className="inline-block w-4 h-4 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                ) : '↻'}
                Refresh Now
              </button>
            </div>

            {/* Error banner */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
                <strong>Backend error:</strong> {error}.
                {import.meta.env.DEV ? ' Make sure the backend is running on port 3001.' : ' Check Railway logs.'}
              </div>
            )}

            {/* Top row: Forecast chart + Pressure index */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <OccupancyForecastChart
                  currentOccupancy={forecastData?.currentOccupancy ?? 65}
                  forecast={forecastData?.forecast}
                />
              </div>
              <div>
                <CongestionPressureIndex
                  forecastData={forecastData}
                  loading={loading && !forecastData}
                />
              </div>
            </div>

            {/* Bottom row: Vessel timeline + Rate card */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <VesselArrivalTimeline
                vessels={vessels.length > 0 ? vessels : forecastData?.incomingVessels}
                loading={loading && !forecastData}
              />
              <PreEmptiveRateCard
                forecastData={forecastData}
                nowOccupancy={forecastData?.currentOccupancy}
                baselineRate={175}
                baselineGate={1200}
                totalBerths={8}
                loading={loading && !forecastData}
              />
            </div>

            {/* Data sources footnote */}
            <p className="text-xs text-center text-gray-400 pt-2">
              Vessel positions: AIS (demo mode — set AIS_API_KEY for live data) ·
              Weather: Open-Meteo · Specs: Equasis cache
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
