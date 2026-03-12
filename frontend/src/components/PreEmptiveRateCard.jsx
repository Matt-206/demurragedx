// PreEmptiveRateCard.jsx — Section 8.4
// Shows two rate recommendations side by side:
//   NOW RATE    — based on current occupancy (from RateCalculator)
//   FORECAST RATE — based on peak forecast occupancy (from occupancyForecaster)
// A toggle lets the port manager switch between the two views.
// Clearly labeled as "Pre-emptive" to distinguish from the reactive calculator.

import { useState } from 'react'
import { classifyCongestionState, calculateRecommendedRate } from '../utils/ratesEngine'

// State label styles — matches RateCalculator.jsx
const STATE_STYLES = {
  SLACK:    { ring: 'ring-green-400',  text: 'text-green-800',  bg: 'bg-green-50'  },
  NORMAL:   { ring: 'ring-blue-400',   text: 'text-blue-800',   bg: 'bg-blue-50'   },
  ELEVATED: { ring: 'ring-amber-400',  text: 'text-amber-800',  bg: 'bg-amber-50'  },
  HIGH:     { ring: 'ring-orange-500', text: 'text-orange-800', bg: 'bg-orange-50' },
  CRITICAL: { ring: 'ring-red-500',    text: 'text-red-800',    bg: 'bg-red-50'    },
}

// Format rate change as "+25%" or "−25%"
function formatChange(pct) {
  if (pct > 0) return `+${pct}%`
  if (pct < 0) return `${pct}%`
  return 'No change'
}

// Single rate display card (used for both Now and Forecast modes)
function RateDisplay({ label, sublabel, rate, congestion, rationale, isForecast }) {
  if (!congestion || !rate) return (
    <div className="flex-1 flex items-center justify-center h-40 text-gray-400 text-sm">
      No data available
    </div>
  )

  const styles = STATE_STYLES[congestion.state] || STATE_STYLES.NORMAL

  return (
    <div className={`flex-1 rounded-xl p-5 ring-2 ${styles.ring} ${styles.bg}`}>
      {/* Label */}
      <div className="flex items-center gap-2 mb-3">
        {isForecast && (
          <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium border border-purple-200">
            PRE-EMPTIVE
          </span>
        )}
        <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{sublabel}</span>
      </div>

      {/* Rate */}
      <div className="mb-3">
        <div className="text-4xl font-extrabold text-gray-900">
          ${rate.recommendedRate}
          <span className="text-base font-normal text-gray-500">/day</span>
        </div>
        <div className={`text-sm font-semibold mt-0.5 ${rate.percentageChange > 0 ? 'text-red-600' : rate.percentageChange < 0 ? 'text-green-600' : 'text-gray-500'}`}>
          {formatChange(rate.percentageChange)} vs baseline (${rate.baselineRate}/day)
        </div>
      </div>

      {/* State badge */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-sm font-bold ${styles.text}`}>{congestion.label} state</span>
        <span className="text-xs text-gray-500">
          score {congestion.compositeScore}/100 · {rate.multiplier}× multiplier
        </span>
      </div>

      {/* Sub-score bars */}
      <div className="space-y-1 mb-3">
        {[
          { name: 'Yard',  value: congestion.scores?.yard  ?? 0, weight: '50%' },
          { name: 'Gate',  value: congestion.scores?.gate  ?? 0, weight: '30%' },
          { name: 'Berth', value: congestion.scores?.berth ?? 0, weight: '20%' },
        ].map(s => (
          <div key={s.name} className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-16">{s.name} ({s.weight})</span>
            <div className="flex-1 bg-white bg-opacity-60 rounded-full h-1.5">
              <div className={`h-1.5 rounded-full ${congestion.state === 'CRITICAL' ? 'bg-red-500' : congestion.state === 'HIGH' ? 'bg-orange-500' : 'bg-teal-500'}`}
                   style={{ width: `${s.value}%` }} />
            </div>
            <span className="text-xs font-mono text-gray-500 w-8 text-right">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Rationale */}
      {rationale && (
        <p className="text-xs text-gray-600 bg-white bg-opacity-60 rounded-lg px-3 py-2 leading-relaxed">
          {rationale}
        </p>
      )}
    </div>
  )
}

export default function PreEmptiveRateCard({
  forecastData,      // full forecast API response
  nowOccupancy,      // current occupancy (from port manager input or last reading)
  baselineRate,      // terminal baseline rate
  baselineGate,      // baseline gate throughput
  totalBerths,       // total berths
  loading,
}) {
  // Toggle: false = show NOW rate, true = show FORECAST rate
  const [showForecast, setShowForecast] = useState(true)

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow p-5">
        <h3 className="font-semibold text-gray-800 mb-4">Rate Recommendation</h3>
        <div className="h-48 bg-gray-100 rounded-lg animate-pulse" />
      </div>
    )
  }

  // ── NOW rate — based on current occupancy ──────────────────────────────────
  const nowOcc     = nowOccupancy ?? forecastData?.currentOccupancy ?? 65
  const nowVessels = forecastData?.incomingVessels?.filter(v => (v.etaHours ?? 99) <= 6).length ?? 0
  const nowConfig  = { baselineGateThroughput: baselineGate ?? 1200, totalBerths: totalBerths ?? 8 }
  const nowCong    = classifyCongestionState(nowOcc, baselineGate ?? 1200, nowVessels, nowConfig)
  const nowRate    = calculateRecommendedRate(nowCong, baselineRate ?? 175)

  // ── FORECAST rate — based on peak forecast occupancy ──────────────────────
  const peakOcc       = forecastData?.peakOccupancy ?? nowOcc
  const forecastCong  = forecastData?.recommendedRate?.peakCongestionState
    ? {
        state:          forecastData.recommendedRate.peakCongestionState,
        label:          forecastData.recommendedRate.peakCongestionState.charAt(0) + forecastData.recommendedRate.peakCongestionState.slice(1).toLowerCase(),
        compositeScore: peakOcc, // approximate
        scores: { yard: peakOcc, gate: 30, berth: 40 }, // approximate for display
      }
    : classifyCongestionState(peakOcc, baselineGate ?? 1200, nowVessels, nowConfig)

  const forecastRate = forecastData?.recommendedRate
    ? {
        recommendedRate:  forecastData.recommendedRate.recommendedRate,
        multiplier:       forecastData.recommendedRate.multiplier,
        baselineRate:     forecastData.recommendedRate.baselineRate ?? baselineRate ?? 175,
        percentageChange: Math.round((forecastData.recommendedRate.multiplier - 1) * 100),
      }
    : calculateRecommendedRate(forecastCong, baselineRate ?? 175)

  return (
    <div className="bg-white rounded-xl shadow p-5">
      {/* Header + toggle */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-800">Rate Recommendation</h3>

        {/* Toggle pill */}
        <div className="flex items-center bg-gray-100 rounded-full p-0.5 text-xs font-medium">
          <button
            onClick={() => setShowForecast(false)}
            className={`px-3 py-1.5 rounded-full transition-all ${!showForecast ? 'bg-white shadow text-gray-800' : 'text-gray-500'}`}
          >
            Now Rate
          </button>
          <button
            onClick={() => setShowForecast(true)}
            className={`px-3 py-1.5 rounded-full transition-all ${showForecast ? 'bg-white shadow text-purple-700' : 'text-gray-500'}`}
          >
            Forecast Rate
          </button>
        </div>
      </div>

      {/* Rate card */}
      <div className="flex gap-4">
        {showForecast ? (
          <RateDisplay
            label="Forecast"
            sublabel={`Based on ${peakOcc}% peak forecast occupancy`}
            rate={forecastRate}
            congestion={forecastCong}
            rationale={forecastData?.recommendedRate?.rationale}
            isForecast={true}
          />
        ) : (
          <RateDisplay
            label="Now"
            sublabel={`Based on current ${nowOcc}% occupancy`}
            rate={nowRate}
            congestion={nowCong}
            rationale={`Current occupancy is ${nowOcc}%. This rate reflects live conditions only. Switch to Forecast Rate for a pre-emptive recommendation based on the next 72 hours.`}
            isForecast={false}
          />
        )}
      </div>

      {/* Comparison footer — always visible */}
      <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
        <div>
          <span className="font-medium">Now:</span> ${nowRate.recommendedRate}/day
          <span className="mx-2 text-gray-300">|</span>
          <span className="font-medium text-purple-700">Forecast peak:</span> ${forecastRate.recommendedRate}/day
        </div>
        {forecastRate.recommendedRate > nowRate.recommendedRate && (
          <span className="text-orange-600 font-medium">
            ↑ ${forecastRate.recommendedRate - nowRate.recommendedRate}/day pre-emptive premium
          </span>
        )}
        {forecastRate.recommendedRate < nowRate.recommendedRate && (
          <span className="text-green-600 font-medium">
            ↓ Forecast shows easing conditions
          </span>
        )}
      </div>
    </div>
  )
}
