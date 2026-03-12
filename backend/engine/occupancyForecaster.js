// backend/engine/occupancyForecaster.js
// Master 72-hour occupancy forecast orchestrator.
//
// Implements the core equation from Section 4 of the manual:
//   ForecastOccupancy(T) = CurrentOccupancy
//                        + ExpectedInflow(T)
//                        - ExpectedOutflow(T)
//                        × WeatherMultiplier(T)
//                        × SeasonalIndex(T)
//
// Called by the cron job (every 60 min) and by POST /api/forecast/trigger.
// Stores results in occupancy_forecasts table.
// Frontend polls GET /api/forecast/:portId for the latest stored row.

const { getDb }                                          = require('../db/db');
const { estimateVesselDischarge }                        = require('./vesselEstimator');
const { getVesselSpecs }                                 = require('./equasisCache');
const { fetchAndStoreVessels, getRecentVessels }         = require('./aisService');
const { classifyCongestionState, calculateRecommendedRate } = require('./ratesEngine');

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: getWeekNumber(date)
// Returns ISO week number (1-53) for a given date.
// Used by the seasonal index and calendar multiplier functions.
// ─────────────────────────────────────────────────────────────────────────────
function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Shift to nearest Thursday (ISO week rule: week belongs to the Thursday's year)
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  // Jan 4 is always in week 1 (ISO 8601)
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(
    ((d.getTime() - week1.getTime()) / 86_400_000 - 3 + (week1.getDay() + 6) % 7) / 7
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getSeasonalIndex(portId, date)
// A multiplier (0.55–1.45) that adjusts the forecast for known annual patterns.
// Applied at the occupancy level — not the same as the outflow calendar multiplier,
// which affects pickup rate. This adjusts the overall occupancy projection.
// ─────────────────────────────────────────────────────────────────────────────
function getSeasonalIndex(portId, date) {
  const week = getWeekNumber(date);

  // Pre-Christmas import surge (US retail peak, weeks 40-46)
  if (week >= 40 && week <= 46) return 1.20;

  // Post-Chinese-New-Year surge (vessels resume after holiday, weeks 7-9)
  if (week >= 7  && week <= 9)  return 1.25;

  // Christmas/New Year shutdown — minimal port activity (weeks 51-1)
  if (week >= 51 || week <= 1)  return 0.80;

  // European summer slowdown (manufacturing holidays, weeks 28-34)
  if (portId.includes('europe') && week >= 28 && week <= 34) return 0.90;

  return 1.0; // Normal week
}

// ─────────────────────────────────────────────────────────────────────────────
// getDayOfWeekIndex(date)
// A mild occupancy-level adjustment for the day of the week.
// Complements the outflow day-of-week multiplier in calculateExpectedOutflow.
// Monday spikes slightly because weekend backlog is still in the yard.
// ─────────────────────────────────────────────────────────────────────────────
function getDayOfWeekIndex(date) {
  const dow = date.getDay(); // 0=Sunday, 6=Saturday
  const indices = {
    0: 0.97, // Sunday — very low activity, yard slightly emptier
    1: 1.03, // Monday — weekend backlog still in yard
    2: 1.01, // Tuesday — slightly above average
    3: 1.00, // Wednesday — baseline
    4: 1.00, // Thursday — baseline
    5: 0.99, // Friday — afternoon slowdown starts
    6: 0.98, // Saturday — very low gate, yard fills slightly
  };
  return indices[dow] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// getCalendarMultiplier(date, portId)
// Applies known annual cargo volume patterns to expected outflow.
// Different from the seasonal index — this affects how fast cargo is PICKED UP.
// ─────────────────────────────────────────────────────────────────────────────
function getCalendarMultiplier(date, portId) {
  const week = getWeekNumber(date);

  // Pre-Christmas import surge — consignees pick up urgently
  if (week >= 40 && week <= 46) return 1.35;

  // Post-Chinese-New-Year surge — vessels have been queuing, now arrive fast
  if (week >= 7  && week <= 9)  return 1.45;

  // Christmas/New Year shutdown — almost no gate movement
  if (week >= 51 || week <= 1)  return 0.55;

  // European summer slowdown — factories on holiday, pickups slow
  if (portId && portId.includes('europe') && week >= 28 && week <= 34) return 0.85;

  return 1.0; // Normal week
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateExpectedOutflow(currentOccupancy, portConfig, hoursAhead, fromDate)
// Models how many TEUs will leave the yard in the next N hours.
// Uses publicly observable patterns — day of week, calendar, occupancy pressure.
// No TOS access required.
// ─────────────────────────────────────────────────────────────────────────────
function calculateExpectedOutflow(currentOccupancy, portConfig, hoursAhead, fromDate) {
  const { totalYardCapacity, baselineGateThroughput, portId } = portConfig;

  // Base outflow: assume the baseline gate throughput runs continuously.
  // baselineGateThroughput is containers per 24 hours → convert to hoursAhead window.
  const baseOutflow = (baselineGateThroughput / 24) * hoursAhead;

  // Day of week multiplier for the TARGET date (not today).
  // We are forecasting the pickup rate at time T, not right now.
  const targetDate = new Date(fromDate.getTime() + hoursAhead * 3_600_000);
  const dow        = targetDate.getDay();
  const dowMultipliers = {
    0: 0.30, // Sunday — very low
    1: 1.40, // Monday — peak, clearing weekend backlog
    2: 1.10, // Tuesday — above average
    3: 1.00, // Wednesday — baseline
    4: 1.00, // Thursday — baseline
    5: 0.90, // Friday — drops in afternoon
    6: 0.40, // Saturday — low
  };
  const dowMult = dowMultipliers[dow] ?? 1.0;

  // Occupancy pressure multiplier.
  // When the yard is very full, cargo owners respond faster to storage charges —
  // the terminal also prioritises certain containers for removal.
  let occupancyPressure = 1.0;
  if      (currentOccupancy > 85) occupancyPressure = 1.25; // urgent pickup pressure
  else if (currentOccupancy > 75) occupancyPressure = 1.10; // elevated pickup pressure
  else if (currentOccupancy < 40) occupancyPressure = 0.85; // less urgency to pick up

  // Calendar multiplier — encode known annual volume patterns.
  const calendarMult = getCalendarMultiplier(targetDate, portId);

  // Combine all multipliers and round to whole containers.
  const adjustedOutflow = baseOutflow * dowMult * occupancyPressure * calendarMult;
  return Math.round(adjustedOutflow);
}

// ─────────────────────────────────────────────────────────────────────────────
// getWeatherMultiplier(portConfig, fromDate)
// Fetches a 72-hour weather forecast from Open-Meteo (free, no API key).
// Returns a throughput suppression factor (0.2–1.0).
// A weather event that closes the terminal does not reduce yard occupancy —
// it PREVENTS outflow, so occupancy rises faster.
// ─────────────────────────────────────────────────────────────────────────────
async function getWeatherMultiplier(portConfig, fromDate) {
  const { lat, lon } = portConfig.coordinates || {};

  // If coordinates are missing, return neutral — do not crash the forecast.
  if (!lat || !lon) return 1.0;

  try {
    // Open-Meteo: completely free, no API key, global coverage.
    // hourly=windspeed_10m,weathercode gives wind and WMO weather codes.
    const url = `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${lat}&longitude=${lon}` +
      `&hourly=windspeed_10m,weathercode` +
      `&forecast_days=3`;

    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) }); // 8s timeout
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    // Inspect the next 72 hourly readings (3 × 24).
    const winds   = data.hourly.windspeed_10m.slice(0, 72);
    const codes   = data.hourly.weathercode.slice(0, 72);
    const maxWind = Math.max(...winds);

    // WMO code 65+ = heavy rain, 71+ = snow, 80+ = violent showers/thunderstorm.
    const hasSevereWeather = codes.some(c => c >= 65);

    // WMO wind thresholds for container terminal operations.
    if (maxWind > 60) return 0.20; // Port likely fully closed (gale force 10+)
    if (maxWind > 45) return 0.50; // Significant disruption (gale force 8+)
    if (maxWind > 35) return 0.75; // Some disruption (near-gale)
    if (hasSevereWeather) return 0.85; // Heavy rain slows gate operations
    return 1.0; // Normal conditions

  } catch (error) {
    // Fail open — do not let a weather API outage crash the forecast.
    console.warn('[Weather] Fetch failed, using neutral multiplier:', error.message);
    return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getHistoricalRatios(portId)
// Builds the discharge ratio lookup table from accumulated observations.
// Only service+port combinations with 5+ observations are included
// (below that threshold the average is too noisy to trust over equal-distribution).
// ─────────────────────────────────────────────────────────────────────────────
function getHistoricalRatios(portId) {
  const db = getDb();

  // Aggregate by service+port: compute mean and stddev of discharge_ratio.
  const rows = db.prepare(`
    SELECT
      service_string || '_' || port_id  AS service_key,
      AVG(discharge_ratio)              AS avg_ratio,
      -- SQLite has no STDDEV — use variance-from-mean approximation
      AVG(ABS(discharge_ratio - (SELECT AVG(discharge_ratio) FROM vessel_discharge_observations
               WHERE service_string = o.service_string AND port_id = o.port_id))) AS std_dev,
      COUNT(*)                          AS observations
    FROM vessel_discharge_observations o
    WHERE port_id = ?
    GROUP BY service_string, port_id
    HAVING COUNT(*) >= 5
  `).all(portId);

  // Convert array to keyed lookup object for fast access in estimateDischargeAtPort.
  const ratios = {};
  for (const row of rows) {
    ratios[row.service_key] = {
      avgRatio:     row.avg_ratio,
      stdDev:       row.std_dev || 0.1, // default to 10% if stddev calc returns null
      observations: row.observations,
    };
  }
  return ratios;
}

// ─────────────────────────────────────────────────────────────────────────────
// getVesselArrivalForecast(portConfig, now)
// Retrieves recent AIS vessel positions and enriches each with:
//   - Vessel specs from equasis cache
//   - TEU discharge estimate from vesselEstimator
//   - ETA in hours from now
// ─────────────────────────────────────────────────────────────────────────────
async function getVesselArrivalForecast(portConfig, now) {
  const db              = getDb();
  const historicalRatios = getHistoricalRatios(portConfig.portId);

  // Pull vessels fetched in the last 2 hours for this port.
  // The aisService cron runs every hour — 2h window ensures we always have data.
  const recentVessels = getRecentVessels(portConfig.portId, 2);

  if (recentVessels.length === 0) {
    console.warn(`[Forecaster] No recent AIS data for ${portConfig.portId} — forecast uses zero inflow`);
    return [];
  }

  // Enrich each vessel asynchronously (equasisCache lookup may be async)
  const enrichedVessels = await Promise.all(
    recentVessels.map(async (v) => {
      try {
        // Get vessel specs (from DB cache or fallback defaults)
        const equasisData = await getVesselSpecs(v.mmsi, v.draught);

        // Build AIS data object in the shape vesselEstimator expects
        const aisData = {
          vesselName:         v.vessel_name,
          mmsi:               v.mmsi,
          draught:            v.draught || equasisData.maxDraught * 0.7, // fallback to 70% if AIS missing
          tradeLane:          equasisData.tradeLane || 'default',
          serviceString:      'UNKNOWN',   // not available from AIS — uses fallback ratio
          remainingPortCalls: [],           // unknown without manifest — equal distribution used
          eta:                v.eta_calculated,
        };

        // Run the full discharge estimation pipeline
        const dischargeEstimate = estimateVesselDischarge(
          aisData, equasisData, portConfig.portId, historicalRatios
        );

        return {
          ...dischargeEstimate,
          etaHours:      v.hours_to_arrival,
          eta:           v.eta_calculated,
          portId:        v.port_id,
        };

      } catch (err) {
        // If a single vessel fails, skip it rather than crashing the whole forecast
        console.warn(`[Forecaster] Skipping vessel ${v.mmsi} — estimator error:`, err.message);
        return null;
      }
    })
  );

  // Filter out any failed vessels (nulls from catch blocks above)
  return enrichedVessels.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — generateForecast(portConfig, currentOccupancy, db?)
//
// Orchestrates all modules to produce a complete 72-hour forecast.
// Called every hour by the cron job, and on-demand by /api/forecast/trigger.
//
// portConfig must have:
//   portId, portName, totalBerths, totalYardCapacity,
//   baselineGateThroughput, baselineRate, coordinates: { lat, lon }
// ─────────────────────────────────────────────────────────────────────────────
async function generateForecast(portConfig, currentOccupancy) {
  const db  = getDb();
  const now = new Date();

  console.log(`[Forecaster] Generating forecast for ${portConfig.portId} — current occupancy: ${currentOccupancy}%`);

  // ── 1. FETCH FRESH AIS DATA ───────────────────────────────────────────────
  // Refresh AIS positions so the forecast uses the latest vessel picture.
  await fetchAndStoreVessels(portConfig.portId);

  // ── 2. GET VESSEL ARRIVAL FORECAST (inflow) ───────────────────────────────
  // Each element has: estimatedDischarge.estimatedTEUs, etaHours, confidence
  const vesselsForecast = await getVesselArrivalForecast(portConfig, now);

  // Sum up TEU inflow for each time window by summing discharge estimates
  // from vessels whose ETA falls within each window.
  const inflow24h = vesselsForecast
    .filter(v => v.etaHours <= 24)
    .reduce((sum, v) => sum + (v.estimatedDischarge?.estimatedTEUs || 0), 0);

  const inflow48h = vesselsForecast
    .filter(v => v.etaHours <= 48)
    .reduce((sum, v) => sum + (v.estimatedDischarge?.estimatedTEUs || 0), 0);

  const inflow72h = vesselsForecast
    .filter(v => v.etaHours <= 72)
    .reduce((sum, v) => sum + (v.estimatedDischarge?.estimatedTEUs || 0), 0);

  // ── 3. OUTFLOW CALCULATION ────────────────────────────────────────────────
  // Model expected cargo pickup volume using public signals only.
  const outflow24h = calculateExpectedOutflow(currentOccupancy, portConfig, 24, now);
  const outflow48h = calculateExpectedOutflow(currentOccupancy, portConfig, 48, now);
  const outflow72h = calculateExpectedOutflow(currentOccupancy, portConfig, 72, now);

  // ── 4. ADJUSTMENT MULTIPLIERS ─────────────────────────────────────────────
  const weatherMultiplier = await getWeatherMultiplier(portConfig, now);
  const seasonalIndex     = getSeasonalIndex(portConfig.portId, now);
  const dayOfWeekIndex    = getDayOfWeekIndex(now);

  // ── 5. PROJECT OCCUPANCY ──────────────────────────────────────────────────
  const totalCapacity = portConfig.totalYardCapacity; // TEUs
  const currentTEUs   = (currentOccupancy / 100) * totalCapacity;

  // Projected occupancy at each time horizon:
  //   (currentTEUs + inflow - outflow) / totalCapacity × adjustment multipliers
  // Clamped to [0, 100] — yard can't be over 100% or below 0%.
  const projected24h = Math.min(100, Math.max(0, Math.round(
    ((currentTEUs + inflow24h - outflow24h) / totalCapacity) * 100
    * weatherMultiplier * seasonalIndex * dayOfWeekIndex
  )));

  const projected48h = Math.min(100, Math.max(0, Math.round(
    ((currentTEUs + inflow48h - outflow48h) / totalCapacity) * 100
    * weatherMultiplier * seasonalIndex * dayOfWeekIndex
  )));

  const projected72h = Math.min(100, Math.max(0, Math.round(
    ((currentTEUs + inflow72h - outflow72h) / totalCapacity) * 100
    * weatherMultiplier * seasonalIndex * dayOfWeekIndex
  )));

  // Peak is the maximum projected occupancy across the entire 72-hour window.
  const peakOccupancy = Math.max(currentOccupancy, projected24h, projected48h, projected72h);

  // Determine when the peak occurs for the response message.
  let peakHorizon = 'now';
  if (peakOccupancy === projected72h) peakHorizon = 72;
  else if (peakOccupancy === projected48h) peakHorizon = 48;
  else if (peakOccupancy === projected24h) peakHorizon = 24;
  const peakOccursAt = peakHorizon === 'now'
    ? now.toISOString()
    : new Date(now.getTime() + peakHorizon * 3_600_000).toISOString();

  // ── 6. PRE-EMPTIVE RATE RECOMMENDATION ───────────────────────────────────
  // Recommend a rate based on PEAK forecast occupancy, not current occupancy.
  // This is the key differentiator vs. reactive pricing.
  const peakCongestionConfig = {
    baselineGateThroughput: portConfig.baselineGateThroughput,
    totalBerths:            portConfig.totalBerths,
  };
  // Use current vessel count as a proxy for berth occupancy
  const currentVesselsAtBerth = Math.min(
    portConfig.totalBerths,
    vesselsForecast.filter(v => v.etaHours <= 6).length // vessels arriving within 6h ≈ currently berthed
  );
  const peakCongestion = classifyCongestionState(
    peakOccupancy,
    portConfig.baselineGateThroughput * (weatherMultiplier < 1 ? weatherMultiplier : 1),
    currentVesselsAtBerth,
    peakCongestionConfig
  );
  const recommendedRateObj = calculateRecommendedRate(peakCongestion, portConfig.baselineRate);

  // Build a rationale string explaining why this rate was recommended.
  const topVessel    = vesselsForecast[0];
  const vesselCount  = vesselsForecast.filter(v => v.etaHours <= 72).length;
  const rationale    = vesselCount > 0
    ? `Peak occupancy of ${peakOccupancy}% forecast in ${peakHorizon === 'now' ? 'current window' : peakHorizon + ' hours'}. ` +
      `${vesselCount} vessel${vesselCount !== 1 ? 's' : ''} arriving in next 72 hours` +
      (topVessel ? `, largest discharge estimated at ${topVessel.estimatedDischarge?.estimatedTEUs || 0} TEUs.` : '.') +
      ` Recommend pre-emptive rate increase to accelerate current inventory clearance.`
    : `Peak occupancy of ${peakOccupancy}% forecast. No vessels in AIS window — seasonal/outflow model only.`;

  // ── 7. PERSIST FORECAST ───────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO occupancy_forecasts
      (port_id, current_occupancy, forecast_24h, forecast_48h, forecast_72h,
       peak_forecast, inflow_24h, inflow_48h, inflow_72h,
       outflow_24h, outflow_48h, outflow_72h,
       weather_multiplier, seasonal_index, vessels_incoming, recommended_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    portConfig.portId, currentOccupancy,
    projected24h, projected48h, projected72h, peakOccupancy,
    inflow24h, inflow48h, inflow72h,
    outflow24h, outflow48h, outflow72h,
    weatherMultiplier, seasonalIndex,
    vesselsForecast.length,
    recommendedRateObj.recommendedRate
  );

  // ── 8. RETURN COMPLETE FORECAST OBJECT ───────────────────────────────────
  return {
    portId:           portConfig.portId,
    portName:         portConfig.portName,
    generatedAt:      now.toISOString(),
    currentOccupancy,
    forecast: {
      h24: { occupancy: projected24h, inflow: inflow24h, outflow: outflow24h },
      h48: { occupancy: projected48h, inflow: inflow48h, outflow: outflow48h },
      h72: { occupancy: projected72h, inflow: inflow72h, outflow: outflow72h },
    },
    peakOccupancy,
    peakOccursAt,
    weatherMultiplier,
    seasonalIndex,
    recommendedRate: {
      basedOnPeak:        true,
      peakCongestionState: peakCongestion.state,
      recommendedRate:    recommendedRateObj.recommendedRate,
      multiplier:         recommendedRateObj.multiplier,
      baselineRate:       portConfig.baselineRate,
      rationale,
    },
    incomingVessels: vesselsForecast,
  };
}

module.exports = { generateForecast };
