// CongestionPressureIndex.jsx — Section 8.3
// A widget showing whether the next 7 days look light, normal, heavy, or critical
// based on peak forecast occupancy. Shows the peak number prominently plus the
// key driver (vessel arrivals / seasonal event).

// Pressure level config based on peak forecast occupancy
function getPressureLevel(peakOccupancy) {
  if (peakOccupancy >= 80) return {
    level: 'CRITICAL',
    label: 'Critical Pressure',
    description: 'Yard is forecast to reach or exceed critical capacity.',
    barColor: 'bg-red-500',
    ringColor: 'ring-red-300',
    textColor: 'text-red-700',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-300',
    emoji: '🔴',
  }
  if (peakOccupancy >= 65) return {
    level: 'HIGH',
    label: 'High Pressure',
    description: 'Significant congestion expected. Pre-emptive action recommended.',
    barColor: 'bg-orange-500',
    ringColor: 'ring-orange-300',
    textColor: 'text-orange-700',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-300',
    emoji: '🟠',
  }
  if (peakOccupancy >= 50) return {
    level: 'ELEVATED',
    label: 'Elevated Pressure',
    description: 'Above-normal activity expected. Monitor closely.',
    barColor: 'bg-amber-400',
    ringColor: 'ring-amber-200',
    textColor: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-300',
    emoji: '🟡',
  }
  if (peakOccupancy >= 30) return {
    level: 'NORMAL',
    label: 'Normal Conditions',
    description: 'Traffic within expected operating range.',
    barColor: 'bg-blue-400',
    ringColor: 'ring-blue-200',
    textColor: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-300',
    emoji: '🔵',
  }
  return {
    level: 'LIGHT',
    label: 'Light Activity',
    description: 'Low throughput. Consider discount rates to attract volume.',
    barColor: 'bg-green-400',
    ringColor: 'ring-green-200',
    textColor: 'text-green-700',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-300',
    emoji: '🟢',
  }
}

// Build a human-readable driver string from the forecast data
function buildDriverText(forecastData, incomingVessels) {
  if (!forecastData) return null
  const vesselCount = incomingVessels?.length ?? 0
  const peakHorizon = (() => {
    const occ = forecastData.forecast
    if (!occ) return null
    const values = [
      { h: 24, occ: occ.h24?.occupancy ?? 0 },
      { h: 48, occ: occ.h48?.occupancy ?? 0 },
      { h: 72, occ: occ.h72?.occupancy ?? 0 },
    ]
    return values.reduce((max, v) => v.occ > max.occ ? v : max, { h: 0, occ: 0 })
  })()

  const parts = []
  if (vesselCount > 0) parts.push(`${vesselCount} vessel${vesselCount > 1 ? 's' : ''} arriving in next 72h`)
  if (peakHorizon && peakHorizon.h > 0) parts.push(`peak projected at +${peakHorizon.h}h`)
  if (forecastData.seasonalIndex && forecastData.seasonalIndex > 1.1) parts.push('seasonal high-volume period active')
  if (forecastData.weatherMultiplier && forecastData.weatherMultiplier < 0.9) parts.push('weather disruption forecast')

  return parts.length > 0 ? parts.join(' · ') : 'Standard operating conditions'
}

export default function CongestionPressureIndex({ forecastData, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow p-5">
        <h3 className="font-semibold text-gray-800 mb-4">Congestion Pressure Index</h3>
        <div className="h-32 bg-gray-100 rounded-lg animate-pulse" />
      </div>
    )
  }

  const peakOccupancy  = forecastData?.peakOccupancy ?? forecastData?.currentOccupancy ?? 0
  const pressure       = getPressureLevel(peakOccupancy)
  const driverText     = buildDriverText(forecastData, forecastData?.incomingVessels)
  const weatherOk      = (forecastData?.weatherMultiplier ?? 1) >= 0.9
  const isSeasonal     = (forecastData?.seasonalIndex ?? 1) > 1.1

  return (
    <div className={`rounded-xl shadow p-5 border ${pressure.bgColor} ${pressure.borderColor}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800">Congestion Pressure Index</h3>
        <span className="text-xs text-gray-400">Next 72h window</span>
      </div>

      {/* Main indicator */}
      <div className="flex items-center gap-4 mb-4">
        {/* Large peak number */}
        <div className={`ring-4 ${pressure.ringColor} rounded-full w-20 h-20 flex flex-col items-center justify-center bg-white`}>
          <div className={`text-2xl font-extrabold ${pressure.textColor}`}>{peakOccupancy}%</div>
          <div className="text-xs text-gray-400">peak</div>
        </div>

        <div className="flex-1">
          <div className={`text-lg font-bold ${pressure.textColor} flex items-center gap-2`}>
            {pressure.emoji} {pressure.label}
          </div>
          <p className="text-sm text-gray-600 mt-1">{pressure.description}</p>
        </div>
      </div>

      {/* Pressure bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>0%</span><span>50%</span><span>85%</span><span>100%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3 relative">
          {/* Critical zone marker */}
          <div className="absolute right-[15%] top-0 bottom-0 w-0.5 bg-red-400 opacity-50" />
          {/* Fill bar */}
          <div
            className={`${pressure.barColor} h-3 rounded-full transition-all duration-700`}
            style={{ width: `${peakOccupancy}%` }}
          />
        </div>
      </div>

      {/* Key driver text */}
      {driverText && (
        <div className="text-xs text-gray-600 bg-white bg-opacity-60 rounded-lg px-3 py-2">
          <span className="font-medium">Key driver: </span>{driverText}
        </div>
      )}

      {/* Signal pills */}
      <div className="flex gap-2 mt-3 flex-wrap">
        {!weatherOk && (
          <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-200">
            ⛈ Weather disruption ({Math.round((1 - (forecastData?.weatherMultiplier ?? 1)) * 100)}% throughput loss)
          </span>
        )}
        {isSeasonal && (
          <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 border border-purple-200">
            📅 Seasonal high-volume period
          </span>
        )}
        {weatherOk && !isSeasonal && (
          <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-500">
            ✓ No weather disruption · Standard season
          </span>
        )}
      </div>
    </div>
  )
}
