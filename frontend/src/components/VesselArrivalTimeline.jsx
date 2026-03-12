// VesselArrivalTimeline.jsx — Section 8.2
// Visual timeline of incoming vessels ordered by ETA.
// For each vessel shows: name, ETA in hours, estimated TEU discharge,
// load fraction bar, and confidence level.
// Color coded: green = 48+ hours, amber = 24-48 hours, red = under 24 hours.

// Color scheme based on ETA urgency
function etaColor(hoursToArrival) {
  if (hoursToArrival <= 24) return { dot: 'bg-red-500', badge: 'bg-red-100 text-red-700 border-red-300', bar: 'bg-red-500', label: 'ARRIVING SOON' }
  if (hoursToArrival <= 48) return { dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700 border-amber-300', bar: 'bg-amber-400', label: 'IN 24-48H' }
  return { dot: 'bg-green-500', badge: 'bg-green-100 text-green-700 border-green-300', bar: 'bg-green-500', label: 'IN 48-72H' }
}

// Confidence badge colors
function confidenceStyle(confidence) {
  if (confidence === 'HIGH') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-500'
}

// Format ETA hours as "18h 30m" or "2d 5h"
function formatETA(hours) {
  if (!hours && hours !== 0) return '—'
  const h = Math.round(hours)
  if (h < 48) return `${h}h`
  const days = Math.floor(h / 24)
  const rem  = h % 24
  return `${days}d ${rem}h`
}

export default function VesselArrivalTimeline({ vessels, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow p-5">
        <h3 className="font-semibold text-gray-800 mb-4">Vessel Arrival Timeline</h3>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (!vessels || vessels.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow p-5">
        <h3 className="font-semibold text-gray-800 mb-2">Vessel Arrival Timeline</h3>
        <p className="text-gray-400 text-sm">No vessels in AIS range. Set AIS_API_KEY for live data.</p>
      </div>
    )
  }

  // Sort by ETA hours ascending — nearest first
  const sorted = [...vessels].sort((a, b) => (a.etaHours ?? 999) - (b.etaHours ?? 999))

  return (
    <div className="bg-white rounded-xl shadow p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-800">Vessel Arrival Timeline</h3>
        <span className="text-xs text-gray-400">{vessels.length} vessel{vessels.length !== 1 ? 's' : ''} in range</span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical timeline line */}
        <div className="absolute left-[1.1rem] top-2 bottom-2 w-0.5 bg-gray-200" />

        <div className="space-y-4">
          {sorted.map((vessel, i) => {
            const colors      = etaColor(vessel.etaHours ?? 99)
            const teus        = vessel.estimatedDischarge?.estimatedTEUs ?? vessel.estimatedTotalTEUs ?? 0
            const lowTEUs     = vessel.estimatedDischarge?.lowEstimate  ?? 0
            const highTEUs    = vessel.estimatedDischarge?.highEstimate ?? 0
            const load        = vessel.loadFraction ?? 0
            const confidence  = vessel.confidence ?? vessel.estimatedDischarge?.confidence ?? 'LOW'

            return (
              <div key={vessel.mmsi ?? i} className="flex gap-4 items-start">
                {/* Timeline dot */}
                <div className="relative z-10 mt-1 flex-shrink-0">
                  <div className={`w-[1.4rem] h-[1.4rem] rounded-full ${colors.dot} flex items-center justify-center`}>
                    <div className="w-2 h-2 rounded-full bg-white" />
                  </div>
                </div>

                {/* Vessel card */}
                <div className="flex-1 bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-semibold text-gray-800 text-sm">{vessel.vesselName || 'Unknown Vessel'}</div>
                      <div className="text-xs text-gray-400">MMSI {vessel.mmsi}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {/* ETA badge */}
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${colors.badge}`}>
                        ETA {formatETA(vessel.etaHours)}
                      </span>
                      {/* Confidence badge */}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${confidenceStyle(confidence)}`}>
                        {confidence} confidence
                      </span>
                    </div>
                  </div>

                  {/* TEU discharge estimate */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-bold text-gray-800">{teus.toLocaleString()}</span>
                        <span className="text-xs text-gray-500">TEUs est. discharge</span>
                      </div>
                      {lowTEUs !== highTEUs && (
                        <div className="text-xs text-gray-400">
                          Range: {lowTEUs.toLocaleString()} – {highTEUs.toLocaleString()}
                        </div>
                      )}
                    </div>

                    {/* Load fraction mini bar */}
                    <div className="flex flex-col items-end w-24">
                      <div className="text-xs text-gray-500 mb-1">Load {load}%</div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className={`${colors.bar} h-2 rounded-full transition-all`}
                          style={{ width: `${load}%` }}
                        />
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {vessel.draught ? `${vessel.draught}m draught` : ''}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
