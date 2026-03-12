// RateCalculator.jsx — Phase 1 MVP tab
// Manual input form. Port manager enters current readings and gets an
// immediate rate recommendation from the rules engine.
// All computation is client-side (ratesEngine.js) — no network call needed.

import { useState } from 'react'
import {
  classifyCongestionState,
  calculateRecommendedRate,
  generateExplanation,
} from '../utils/ratesEngine'
import { api } from '../utils/api'

// Default values matching the demo_hamburg port configuration in schema.sql
const DEFAULTS = {
  yardOccupancy:          65,
  gateThroughput:         900,
  vesselsAtBerth:         4,
  baselineGateThroughput: 1200,
  totalBerths:            8,
  baselineRate:           175,
}

// Color classes for each congestion state (Tailwind)
const STATE_STYLES = {
  SLACK:    { bg: 'bg-green-100',  border: 'border-green-400',  text: 'text-green-800'  },
  NORMAL:   { bg: 'bg-blue-100',   border: 'border-blue-400',   text: 'text-blue-800'   },
  ELEVATED: { bg: 'bg-amber-100',  border: 'border-amber-400',  text: 'text-amber-800'  },
  HIGH:     { bg: 'bg-orange-100', border: 'border-orange-500', text: 'text-orange-800' },
  CRITICAL: { bg: 'bg-red-100',    border: 'border-red-500',    text: 'text-red-800'    },
}

export default function RateCalculator() {
  const [inputs, setInputs]   = useState(DEFAULTS)
  const [result, setResult]   = useState(null)

  // Update a single input field by name
  function handleChange(e) {
    setInputs(prev => ({ ...prev, [e.target.name]: parseFloat(e.target.value) || 0 }))
  }

  // Run the rules engine with current inputs
  function handleCalculate() {
    const config = {
      baselineGateThroughput: inputs.baselineGateThroughput,
      totalBerths:            inputs.totalBerths,
    }
    const congestion   = classifyCongestionState(
      inputs.yardOccupancy, inputs.gateThroughput, inputs.vesselsAtBerth, config
    )
    const rate         = calculateRecommendedRate(congestion, inputs.baselineRate)
    const explanation  = generateExplanation(congestion, rate, {
      ...inputs,
      baselineGateThroughput: inputs.baselineGateThroughput,
      totalBerths:            inputs.totalBerths,
    })
    setResult({ congestion, rate, explanation })
  }

  // Save the recommendation to the backend audit log
  async function handleSave() {
    if (!result) return
    try {
      await fetch(api('/api/recommendations'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...inputs, explanation: result.explanation }),
      })
    } catch (err) {
      console.error('Save failed:', err)
    }
  }

  const styles = result ? STATE_STYLES[result.congestion.state] : null

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-xl font-bold text-gray-800">Rate Calculator</h2>

      {/* ── Input form ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl shadow p-6 space-y-4">
        <h3 className="font-semibold text-gray-700 mb-2">Current Terminal Readings</h3>
        <div className="grid grid-cols-2 gap-4">
          <InputField label="Yard Occupancy (%)"       name="yardOccupancy"          value={inputs.yardOccupancy}          min={0}  max={100} onChange={handleChange} />
          <InputField label="Gate Throughput (moves/hr)" name="gateThroughput"        value={inputs.gateThroughput}         min={0}           onChange={handleChange} />
          <InputField label="Vessels at Berth"          name="vesselsAtBerth"          value={inputs.vesselsAtBerth}         min={0}           onChange={handleChange} />
          <InputField label="Baseline Gate (moves/hr)"  name="baselineGateThroughput" value={inputs.baselineGateThroughput} min={1}           onChange={handleChange} />
          <InputField label="Total Berths"              name="totalBerths"             value={inputs.totalBerths}            min={1}           onChange={handleChange} />
          <InputField label="Baseline Rate (USD/day)"   name="baselineRate"            value={inputs.baselineRate}           min={1}           onChange={handleChange} />
        </div>
        <button
          onClick={handleCalculate}
          className="mt-2 w-full bg-teal-600 hover:bg-teal-700 text-white font-semibold py-3 rounded-lg transition-colors"
        >
          Calculate Rate
        </button>
      </div>

      {/* ── Result card ───────────────────────────────────────────────── */}
      {result && (
        <div className={`rounded-xl shadow border-2 p-6 ${styles.bg} ${styles.border}`}>
          {/* State badge + score */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span
                className={`inline-block px-4 py-1 rounded-full text-sm font-bold ${styles.bg} ${styles.text} border ${styles.border}`}
              >
                {result.congestion.label}
              </span>
              <span className="text-gray-500 text-sm">
                Composite score: <strong>{result.congestion.compositeScore}</strong>/100
              </span>
            </div>
            <div className="text-right">
              <div className="text-3xl font-bold text-gray-900">
                ${result.rate.recommendedRate}<span className="text-base font-normal text-gray-500">/day</span>
              </div>
              <div className={`text-sm font-semibold ${result.rate.percentageChange >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                {result.rate.percentageChange >= 0 ? '+' : ''}{result.rate.percentageChange}% vs baseline
              </div>
            </div>
          </div>

          {/* Sub-score breakdown */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: 'Yard Score',  value: result.congestion.scores.yard,  weight: '50%' },
              { label: 'Gate Score',  value: result.congestion.scores.gate,  weight: '30%' },
              { label: 'Berth Score', value: result.congestion.scores.berth, weight: '20%' },
            ].map(s => (
              <div key={s.label} className="bg-white bg-opacity-70 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-500">{s.label} ({s.weight})</div>
                <div className="text-xl font-bold text-gray-800">{s.value}</div>
                <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                  <div className="bg-teal-500 h-1.5 rounded-full" style={{ width: `${s.value}%` }} />
                </div>
              </div>
            ))}
          </div>

          {/* Explanation */}
          <p className="text-sm text-gray-700 leading-relaxed bg-white bg-opacity-60 rounded-lg p-3">
            {result.explanation}
          </p>

          {/* Save button */}
          <button
            onClick={handleSave}
            className="mt-4 text-sm text-teal-700 underline hover:text-teal-900"
          >
            Save to history →
          </button>
        </div>
      )}
    </div>
  )
}

// Reusable labeled number input
function InputField({ label, name, value, min, max, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="number"
        name={name}
        value={value}
        min={min}
        max={max}
        onChange={onChange}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
      />
    </div>
  )
}
