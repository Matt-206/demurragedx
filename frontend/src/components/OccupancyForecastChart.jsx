// OccupancyForecastChart.jsx — Section 8.1
// A line chart showing current occupancy and the 72-hour forecast.
// Three elements on the same chart:
//   - Solid teal line: forecast occupancy at each horizon
//   - Shaded area: uncertainty band (low estimate to high estimate)
//   - Red dashed reference line at 85% (critical threshold)
// Uses Recharts AreaChart as the base (supports both Area + Line layers).

import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, ComposedChart, Legend,
} from 'recharts'

// ─────────────────────────────────────────────────────────────────────────────
// buildChartData(currentOccupancy, forecast)
// Converts the API forecast object into the array shape Recharts expects.
// Each point has: time label, central occupancy, and ±uncertainty band.
// ─────────────────────────────────────────────────────────────────────────────
function buildChartData(currentOccupancy, forecast) {
  if (!forecast) return []

  const { h24, h48, h72 } = forecast

  // Uncertainty band widens at each horizon (per manual Section 3.3):
  //   ±10% at 24h, ±18% at 48h, ±25% at 72h
  const band = (occ, spread) => ({
    low:  Math.max(0,   Math.round(occ - occ * spread)),
    high: Math.min(100, Math.round(occ + occ * spread)),
  })

  return [
    { time: 'Now',   occupancy: currentOccupancy,  ...band(currentOccupancy, 0.00) },
    { time: '+12h',  occupancy: Math.round((currentOccupancy + (h24?.occupancy ?? currentOccupancy)) / 2),
                                ...band(Math.round((currentOccupancy + (h24?.occupancy ?? currentOccupancy)) / 2), 0.05) },
    { time: '+24h',  occupancy: h24?.occupancy ?? currentOccupancy, ...band(h24?.occupancy ?? currentOccupancy, 0.10) },
    { time: '+48h',  occupancy: h48?.occupancy ?? currentOccupancy, ...band(h48?.occupancy ?? currentOccupancy, 0.18) },
    { time: '+72h',  occupancy: h72?.occupancy ?? currentOccupancy, ...band(h72?.occupancy ?? currentOccupancy, 0.25) },
  ]
}

// Custom tooltip shown on hover — displays occupancy and uncertainty range
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold text-gray-700 mb-1">{label}</p>
      <p className="text-teal-700">Forecast: <strong>{d.occupancy}%</strong></p>
      {d.low !== d.high && (
        <p className="text-gray-500">Range: {d.low}% – {d.high}%</p>
      )}
    </div>
  )
}

export default function OccupancyForecastChart({ currentOccupancy, forecast }) {
  const data = buildChartData(currentOccupancy, forecast)

  // Determine the peak value for the summary text above the chart
  const peak = forecast
    ? Math.max(currentOccupancy, forecast.h24?.occupancy ?? 0, forecast.h48?.occupancy ?? 0, forecast.h72?.occupancy ?? 0)
    : currentOccupancy

  return (
    <div className="bg-white rounded-xl shadow p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-800">72-Hour Occupancy Forecast</h3>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-0.5 bg-teal-600" />
            Forecast
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-3 bg-amber-100 border border-amber-300 rounded-sm" />
            Uncertainty band
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 border-t-2 border-red-500 border-dashed" />
            Critical (85%)
          </span>
        </div>
      </div>

      {/* Peak summary pill */}
      {peak >= 80 && (
        <div className="mb-3 inline-flex items-center gap-2 bg-red-50 border border-red-200 rounded-full px-3 py-1 text-xs text-red-700 font-medium">
          ⚠ Peak forecast: {peak}% — Critical threshold may be breached
        </div>
      )}

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
          <XAxis dataKey="time" tick={{ fontSize: 12 }} />
          <YAxis
            domain={[0, 100]}
            tickFormatter={v => `${v}%`}
            tick={{ fontSize: 12 }}
            width={40}
          />

          {/* Critical threshold line */}
          <ReferenceLine
            y={85}
            stroke="#E05252"
            strokeDasharray="4 4"
            label={{ value: 'Critical', fill: '#E05252', fontSize: 11, position: 'insideTopRight' }}
          />

          {/* Uncertainty band — high is the ceiling, low overwrites bottom portion white */}
          <Area
            type="monotone"
            dataKey="high"
            stroke="none"
            fill="#FEF3C7"          // amber-100
            fillOpacity={0.8}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="low"
            stroke="none"
            fill="#FFFFFF"          // white — cuts out the bottom of the band
            fillOpacity={1}
            isAnimationActive={false}
          />

          {/* Forecast occupancy line */}
          <Line
            type="monotone"
            dataKey="occupancy"
            stroke="#0B7A8A"        // teal-700
            strokeWidth={3}
            dot={{ fill: '#0B7A8A', r: 5, strokeWidth: 0 }}
            activeDot={{ r: 7 }}
            isAnimationActive={true}
          />

          <Tooltip content={<CustomTooltip />} />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Inflow / outflow summary table */}
      {forecast && (
        <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs">
          {[
            { horizon: '+24h', occ: forecast.h24?.occupancy, inflow: forecast.h24?.inflow, outflow: forecast.h24?.outflow },
            { horizon: '+48h', occ: forecast.h48?.occupancy, inflow: forecast.h48?.inflow, outflow: forecast.h48?.outflow },
            { horizon: '+72h', occ: forecast.h72?.occupancy, inflow: forecast.h72?.inflow, outflow: forecast.h72?.outflow },
          ].map(({ horizon, occ, inflow, outflow }) => (
            <div key={horizon} className="bg-gray-50 rounded-lg p-2">
              <div className="font-semibold text-gray-600 mb-1">{horizon}</div>
              <div className="text-lg font-bold text-gray-800">{occ ?? '—'}%</div>
              <div className="text-green-600">▲ {inflow?.toLocaleString() ?? 0} TEU in</div>
              <div className="text-blue-600">▼ {outflow?.toLocaleString() ?? 0} TEU out</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
