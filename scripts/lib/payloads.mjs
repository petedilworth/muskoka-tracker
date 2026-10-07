// Data shaping for the static site.
//
// Everything the browser needs is computed here — app.js only formats numbers
// and draws charts. Reads nothing but data/ on disk, so the build is
// deterministic and runs with no network.

import fs from 'node:fs/promises';
import {
  median, poolAroundDay, toRecord, addDays, daysBetween, readingNDaysBack,
  computeTodayTempStats, computeNextWeekTempForecast, loadAllArchives, loadAnnualPeaks, loadStations,
  STATION, EXTRA_STATIONS, FLOW_STATIONS, CM_PER_INCH,
  TEMP_CSV_PATH,
} from '../../notify.mjs';

export const LEVEL_STATIONS = [
  { id: STATION, name: 'Bala', label: 'Lake Muskoka' },
  ...EXTRA_STATIONS,
];

// ── loading ──

export async function loadTemps() {
  const csv = await fs.readFile(TEMP_CSV_PATH, 'utf8');
  return csv.trim().split('\n').slice(1).map(line => {
    const [date, t] = line.split(',');
    return toRecord(date, parseFloat(t));
  }).filter(r => !isNaN(r.tempC));
}

export async function loadLevelCache() {
  return loadAllArchives();
}

export function seriesFrom(cache, key) {
  return cache[key] ?? [];
}

// ── shared stats ──

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function distribution(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0] ?? null, p25: quantile(s, 0.25), p50: quantile(s, 0.5),
    p75: quantile(s, 0.75), max: s[s.length - 1] ?? null, n: s.length,
  };
}

// Where `value` sits within `values`, 0-100. Reported as a plain percentile
// with no "higher is better" inversion — for lake level and water temperature
// neither direction is good or bad, so the spec's direction-normalising would
// only invent a judgement the data doesn't support.
export function percentileOf(values, value) {
  if (values.length === 0 || value === null || value === undefined) return null;
  const below = values.filter(v => v < value).length;
  const equal = values.filter(v => v === value).length;
  return Math.round(((below + equal / 2) / values.length) * 100);
}

// Mean of the readings within `n` days of the series end, by date not by row.
function trailingMean(days, n) {
  if (days.length === 0) return null;
  const cutoff = addDays(days[days.length - 1].date, -(n - 1));
  const window = days.filter(d => d.date >= cutoff);
  if (window.length === 0) return null;
  return window.reduce((a, d) => a + d.value, 0) / window.length;
}

// ── day-of-year normals ──

// Attach year and day-of-year to a plain {date, value} archive reading. Same
// arithmetic as toRecord() in notify.mjs, which names its value `tempC`; the
// maths was never temperature-specific, only the label.
//
// Day-of-year is not leap-adjusted, so a date can shift by one between leap and
// common years. The ±3-day pooling window absorbs that.
export function withDayOfYear(dateStr, value) {
  const year = parseInt(dateStr.substring(0, 4), 10);
  const dt = new Date(dateStr + 'T00:00:00Z');
  const jan1 = new Date(Date.UTC(year, 0, 1));
  return { date: dateStr, year, dayOfYear: Math.floor((dt - jan1) / 86400000) + 1, value };
}

// Per-day-of-year envelope across every year but the current one: 366 rows of
// [day, min, p25, median, p75, max] instead of the whole record. This is what
// "normal for this date" means everywhere on the site.
//
// Generic over the value accessor and rounding because level needs 3 decimals
// (Bala spans 224.28-226.05 m, so 1 decimal would flatten it to nothing) while
// temperature wants 1.
// `pick`, not `valueOf`: every object inherits Object.prototype.valueOf, so an
// option of that name is never undefined and the ?? fallback silently never
// fires — you get Object.prototype.valueOf called with no `this`.
export function dayOfYearEnvelope(records, currentYear, opts = {}) {
  const pick = opts.pick ?? (r => r.value);
  const round = opts.round ?? r3;
  const halfWindow = opts.halfWindow ?? 3;

  const buckets = new Map();
  for (const r of records) {
    if (r.year === currentYear) continue;
    const v = pick(r);
    if (!Number.isFinite(v)) continue;
    if (!buckets.has(r.dayOfYear)) buckets.set(r.dayOfYear, []);
    buckets.get(r.dayOfYear).push(v);
  }
  const rows = [];
  for (let day = 1; day <= 366; day++) {
    // Pooling a window rather than a single day stops one noisy reading from
    // putting a notch in the envelope. Wraps across the Dec/Jan boundary.
    const pool = [];
    for (let d = -halfWindow; d <= halfWindow; d++) {
      const k = ((day - 1 + d + 366) % 366) + 1;
      const b = buckets.get(k);
      if (b) pool.push(...b);
    }
    if (pool.length === 0) { rows.push([day, null, null, null, null, null]); continue; }
    const s = pool.sort((a, b) => a - b);
    rows.push([day, round(s[0]), round(quantile(s, 0.25)), round(quantile(s, 0.5)),
      round(quantile(s, 0.75)), round(s[s.length - 1])]);
  }
  return rows;
}

// ── temperature ──

// The temperature flavour of the same envelope.
export function climatology(records, currentYear) {
  return dayOfYearEnvelope(records, currentYear, { pick: r => r.tempC, round: r1 });
}

// Days at or above the swim line so far this year, against what other years
// had reached by the same day. The records page already calls 20 °C the line
// for "swimmable", so this uses the same number rather than inventing another.
// Only years with a reading on at least 80% of the days up to the cutoff are
// eligible for the typical figure: a year with a hole where June should be
// would otherwise drag the median down.
export const SWIM_C = 20;
export function swimDays(records, currentYear, uptoDayOfYear, threshold = SWIM_C) {
  const byYear = new Map();
  for (const r of records) {
    if (r.dayOfYear > uptoDayOfYear) continue;
    if (!byYear.has(r.year)) byYear.set(r.year, { days: 0, warm: 0 });
    const y = byYear.get(r.year);
    y.days++;
    if (r.tempC >= threshold) y.warm++;
  }
  const thisYear = byYear.get(currentYear)?.warm ?? 0;
  const others = [...byYear.entries()]
    .filter(([y, v]) => y !== currentYear && v.days >= uptoDayOfYear * 0.8)
    .map(([y, v]) => [y, v.warm]);
  const counts = others.map(([, c]) => c).sort((a, b) => a - b);
  const best = others.reduce((m, r) => (m === null || r[1] > m[1] ? r : m), null);
  return {
    threshold, uptoDayOfYear, thisYear,
    typical: counts.length ? Math.round(median(counts)) : null,
    years: counts.length,
    best: best && { year: best[0], days: best[1] },
  };
}

export function buildTemperaturePayload(records, currentYear, todayIso) {
  const byYear = new Map();
  for (const r of records) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  const latest = records[records.length - 1];
  const years = [...byYear.keys()].sort((a, b) => a - b);

  const recent = (year) => (byYear.get(year) ?? [])
    .sort((a, b) => a.dayOfYear - b.dayOfYear)
    .map(r => [r.dayOfYear, r1(r.tempC)]);

  const stats = computeTodayTempStats(records, latest.date, latest.tempC);
  const forecast = computeNextWeekTempForecast(records, latest.date, latest.tempC);

  // Same ±3-day pool the ranking uses, so the percentile and the rank describe
  // the same set of readings
  const pool = poolAroundDay(records, latest.dayOfYear, 3, currentYear).map(r => r.tempC);

  // Anomaly of each current-year day against the climatology median
  const clim = climatology(records, currentYear);
  const climMedian = new Map(clim.map(([day, , , p50]) => [day, p50]));
  const anomaly = (byYear.get(currentYear) ?? [])
    .sort((a, b) => a.dayOfYear - b.dayOfYear)
    .map(r => {
      const base = climMedian.get(r.dayOfYear);
      return [r.dayOfYear, base === null || base === undefined ? null : r1(r.tempC - base)];
    });

  const yearMeans = years.map(y => {
    const vals = byYear.get(y).map(r => r.tempC);
    return [y, r1(vals.reduce((a, b) => a + b, 0) / vals.length), vals.length];
  });

  return {
    meta: {
      key: 'water_temp', label: 'Water temperature', unit: '°C', format: 'f1',
      source: 'NOAA MUR SST v4.1 (satellite)',
      firstDate: records[0].date, lastDate: latest.date,
      years: years.length, records: records.length,
      // The satellite product lags a couple of days; every reading here is
      // labelled by its own date so the page never implies it is live.
      lagDays: daysBetween(todayIso, latest.date),
    },
    latest: { date: latest.date, dayOfYear: latest.dayOfYear, value: r1(latest.tempC) },
    current: { year: currentYear, series: recent(currentYear) },
    previous: { year: currentYear - 1, series: recent(currentYear - 1) },
    climatology: clim,
    anomaly,
    stats: stats && {
      min: r1(stats.min), max: r1(stats.max), median: r1(stats.median),
      rank: stats.rank, totalYears: stats.totalYears,
      windowStart: stats.windowStart, windowEnd: stats.windowEnd,
      earliestYear: stats.earliestYear, latestYear: stats.latestYear,
      percentile: percentileOf(pool, latest.tempC),
    },
    forecast: forecast && {
      expectedChange: r1(forecast.expectedChange), direction: forecast.direction,
      yearsUsed: forecast.yearsUsed, futureDate: forecast.futureDate,
    },
    swim: swimDays(records, currentYear, latest.dayOfYear),
    dist: (() => { const d = distribution(pool); return { ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'n' ? v : r1(v)])) }; })(),
    yearMeans,
  };
}

// Every year at full resolution — the year-over-year overlay. Split into its
// own file (~170 KB) and fetched only when the reader asks for it, so the
// temperature page itself stays small.
export function buildAllYearsPayload(records, currentYear) {
  const byYear = new Map();
  for (const r of records) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  return {
    meta: { currentYear, years: [...byYear.keys()].sort((a, b) => a - b) },
    series: [...byYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, rs]) => [year, rs.sort((a, b) => a.dayOfYear - b.dayOfYear)
        .map(r => [r.dayOfYear, r1(r.tempC)])]),
  };
}

// ── coverage ──

// Interior holes in a series, longer than minGapDays. Ragged ends are not gaps
// — a record simply starts and stops — so only the space *between* readings
// counts.
//
// This exists because the records page confidently reported an all-time high
// from 2019 while the archive held nothing at all for spring 2026: Environment
// Canada publishes its daily-mean series on a long lag, and this project only
// began caching realtime readings in June 2026. A record computed over a hole
// is a claim the data cannot support, so the hole has to be stated.
export function coverageGaps(days, minGapDays = 5) {
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const span = daysBetween(days[i].date, days[i - 1].date);
    if (span > minGapDays) {
      gaps.push({ from: days[i - 1].date, to: days[i].date, days: span - 1 });
    }
  }
  return gaps;
}

// Gaps recent enough to matter to a "record" claim. Anything from decades ago
// is context; a hole in the last couple of years means the record may simply
// not have seen the event being asked about.
export function recentCoverageGaps(days, todayIso, withinDays = 730, minGapDays = 5) {
  const cutoff = addDays(todayIso, -withinDays);
  return coverageGaps(days, minGapDays).filter(g => g.to >= cutoff);
}

// ── annual instantaneous peaks ──

export async function loadPeaks() { return loadAnnualPeaks(); }
export async function loadGaugeLocations() { return loadStations(); }

// Classify by matching loosely rather than against exact strings, because the
// values inside DATA_TYPE_EN have not been observed — only the field name has.
// Falls back to units, then gives up rather than guessing wrong.
function peakMeasure(row) {
  const t = String(row.dataType).toLowerCase();
  if (/level|elevation|stage/.test(t)) return 'level';
  if (/discharge|flow/.test(t)) return 'flow';
  const u = String(row.units).toLowerCase();
  if (/m3|m³|cms/.test(u)) return 'flow';
  if (/^m$|metre|meter/.test(u)) return 'level';
  return null;
}

// The instantaneous high and low for one gauge and measure. Derived from the
// values themselves rather than from PEAK_CODE_EN, whose vocabulary is also
// unobserved — the largest row is the crest whatever it is labelled.
export function peaksFor(rows, stationId, measure) {
  const mine = rows.filter(r => r.station === stationId && peakMeasure(r) === measure);
  if (mine.length === 0) return null;
  let high = mine[0], low = mine[0];
  for (const r of mine) {
    if (r.value > high.value) high = r;
    if (r.value < low.value) low = r;
  }
  const years = [...new Set(mine.map(r => r.date.substring(0, 4)))].sort();
  return {
    high: { date: high.date, value: r3(high.value) },
    low: { date: low.date, value: r3(low.value) },
    n: mine.length, firstYear: years[0], lastYear: years[years.length - 1],
  };
}

// ── records ──

// distribution() already yields the all-time min and max, but drops the dates,
// which is exactly what a records page needs. These fill that gap.
export function extremes(days) {
  if (!days || days.length === 0) return null;
  let high = days[0], low = days[0];
  for (const d of days) {
    if (d.value > high.value) high = d;
    if (d.value < low.value) low = d;
  }
  return {
    high: { date: high.date, value: r3(high.value) },
    low: { date: low.date, value: r3(low.value) },
  };
}

// Largest rises and falls over a rolling window. Compares by date rather than
// by row so a gap in the record cannot masquerade as a sudden swing: a pair
// whose dates are further apart than the window is skipped.
export function biggestSwings(days, windowDays, n = 5) {
  if (!days || days.length < 2) return { rises: [], falls: [] };
  const byDate = new Map(days.map(d => [d.date, d.value]));
  const swings = [];
  for (const d of days) {
    const from = addDays(d.date, -windowDays);
    const prev = byDate.get(from);
    if (prev === undefined) continue;
    swings.push({ from, to: d.date, change: d.value - prev, fromValue: r3(prev), toValue: r3(d.value) });
  }
  const sorted = [...swings].sort((a, b) => b.change - a.change);
  const shape = (x) => ({ ...x, change: r3(x.change) });
  return {
    rises: sorted.slice(0, n).filter(x => x.change > 0).map(shape),
    falls: sorted.slice(-n).reverse().filter(x => x.change < 0).map(shape),
  };
}

// Longest run of consecutive days satisfying `test`. Consecutive by date, so a
// hole in the record ends the run rather than being bridged.
export function longestStreak(days, test) {
  let best = null, run = null;
  for (const d of days) {
    const ok = test(d.value);
    const contiguous = run && daysBetween(d.date, run.end) === 1;
    if (ok && contiguous) { run.end = d.date; run.length++; }
    else if (ok) run = { start: d.date, end: d.date, length: 1 };
    else run = null;
    if (run && (!best || run.length > best.length)) best = { ...run };
  }
  return best;
}

// Every reading ever taken on this calendar date (±0 days — the exact date),
// so "on this date" means what it says.
export function onThisDate(days, monthDay) {
  const hits = days.filter(d => d.date.substring(5) === monthDay);
  if (hits.length === 0) return null;
  const values = hits.map(d => d.value);
  const ex = extremes(hits);
  return {
    n: hits.length,
    earliestYear: parseInt(hits[0].date.substring(0, 4), 10),
    latestYear: parseInt(hits[hits.length - 1].date.substring(0, 4), 10),
    high: ex.high, low: ex.low, median: r3(median(values)),
  };
}

// ── levels and flow ──

// The "vs July avg" figure both surfaces quote is explicitly a FIVE-year
// average. The archive now runs to decades, so this has to be windowed —
// averaging every July on record would silently redefine the headline number
// on the email and every card on the site.
const JULY_AVG_YEARS = 5;

function julyAverage(days, currentYear) {
  const cutoff = `${currentYear - JULY_AVG_YEARS}-01-01`;
  const july = days
    .filter(d => d.date >= cutoff && d.date.substring(5, 7) === '07')
    .map(d => d.value);
  if (july.length === 0) return null;
  return july.reduce((a, b) => a + b, 0) / july.length;
}

// Monthly means over the whole record. Decades of dailies would be several MB;
// this is ~12 rows a year, so the deep history ships in a few KB and the daily
// resolution is reserved for the recent years anyone actually scrubs through.
// Dated to mid-month so the browser can plot it with the same code path.
function monthlyMeans(days) {
  const buckets = new Map();
  for (const d of days) {
    const ym = d.date.substring(0, 7);
    if (!buckets.has(ym)) buckets.set(ym, []);
    buckets.get(ym).push(d.value);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, vals]) => [
    `${ym}-15`,
    r3(vals.reduce((a, b) => a + b, 0) / vals.length),
    r3(Math.min(...vals)), r3(Math.max(...vals)), vals.length,
  ]);
}

const DAILY_YEARS = 2; // full-resolution window shipped to the browser

// A normal needs several years behind it to mean anything. Four flow gauges
// currently hold about five years and one dormant gauge holds a single year;
// a band drawn from one winter would be worse than no band at all.
const MIN_YEARS_FOR_NORMAL = 3;

// How today compares to normal for its own calendar date, plus the 366-row
// envelope the chart shades. Returns null when the record is too shallow, and
// the card then falls back to the July comparison alone.
function dateNormal(days, latest, currentYear, measure) {
  const records = days.map(d => withDayOfYear(d.date, d.value));
  const priorYears = new Set(records.filter(r => r.year !== currentYear).map(r => r.year));
  if (priorYears.size < MIN_YEARS_FOR_NORMAL) return null;

  const envelope = dayOfYearEnvelope(records, currentYear);
  const today = withDayOfYear(latest.date, latest.value);
  const row = envelope[today.dayOfYear - 1];
  if (!row || row[3] === null) return null;

  // Same ±3-day pool the envelope uses, so the percentile and the band agree.
  const pool = [];
  for (let d = -3; d <= 3; d++) {
    const k = ((today.dayOfYear - 1 + d + 366) % 366) + 1;
    for (const r of records) if (r.year !== currentYear && r.dayOfYear === k) pool.push(r.value);
  }
  const med = row[3];

  return {
    envelope,
    dayOfYear: today.dayOfYear,
    min: row[1], p25: row[2], median: med, p75: row[4], max: row[5],
    n: pool.length, years: priorYears.size,
    earliestYear: Math.min(...priorYears), latestYear: Math.max(...priorYears),
    percentile: percentileOf(pool, latest.value),
    // Same measure split as the July comparison: a difference in inches for
    // level, a ratio for flow.
    vsNormalIn: measure === 'level' ? r1((latest.value - med) * 100 / CM_PER_INCH) : null,
    vsNormalPct: (measure === 'flow' && med !== 0) ? Math.round((latest.value / med) * 100) : null,
  };
}

function stationBlock(st, days, { unit, format, decimals, measure }, currentYear) {
  const latest = days[days.length - 1];
  const values = days.map(d => d.value);
  const avg = julyAverage(days, currentYear);
  const back = (n) => {
    const p = readingNDaysBack(days, n, 2);
    return p ? { date: p.date, change: (latest.value - p.value) } : null;
  };
  const dailyFrom = addDays(latest.date, -Math.round(DAILY_YEARS * 365.25));
  return {
    id: st.id, name: st.name, label: st.label, unit, format, decimals,
    latest: { date: latest.date, value: r3(latest.value) },
    measure,
    julyAvg: r3(avg), julyAvgYears: JULY_AVG_YEARS,
    // How this reading sits against the station's own July mean. The two
    // measures need different shapes:
    //
    // Level — inches of difference. The five gauges sit on different datums
    // (Bala reads ~225 m above sea level, the rest 0-10 m local), so a
    // difference from each gauge's own mean is the ONLY quantity comparable
    // across stations.
    //
    // Flow — a ratio, not a difference. Discharge swings across orders of
    // magnitude with the season (0.33 to 177 m³/s on the Moon River), so a
    // subtraction says little; and dividing m³/s by 2.54 to call it "inches",
    // as this did when the two measures shared one formula, is meaningless.
    vsJulyIn: (measure === 'level' && avg !== null)
      ? r1((latest.value - avg) * 100 / CM_PER_INCH) : null,
    vsJulyPct: (measure === 'flow' && avg !== null && avg !== 0)
      ? Math.round((latest.value / avg) * 100) : null,
    trailing: { d7: r3(trailingMean(days, 7)), d30: r3(trailingMean(days, 30)) },
    changes: { d1: back(1), d7: back(7), d30: back(30) },
    // Distribution and percentile span the ENTIRE record, so "52nd percentile"
    // means against every reading ever taken at the gauge, not a 400-day window.
    dist: Object.fromEntries(Object.entries(distribution(values)).map(([k, v]) => [k, k === 'n' ? v : r3(v)])),
    percentile: percentileOf(values, latest.value),
    firstDate: days[0].date, lastDate: latest.date, n: days.length,
    years: Math.max(1, Math.round((new Date(latest.date) - new Date(days[0].date)) / 31557600000)),
    series: days.filter(d => d.date >= dailyFrom).map(d => [d.date, r3(d.value)]),
    monthly: monthlyMeans(days),
    // Second comparison, beside the July one: how today sits against normal for
    // its own calendar date. "vs July avg" applies a single summer number to all
    // 365 days, so it says little in February.
    normal: dateNormal(days, latest, currentYear, measure),
  };
}

export function buildLevelsPayload(cache, todayIso) {
  const currentYear = parseInt(todayIso.substring(0, 4), 10);
  const stations = [];
  for (const st of LEVEL_STATIONS) {
    const days = seriesFrom(cache, `level:${st.id}`);
    if (days.length === 0) continue;
    stations.push(stationBlock(st, days, { unit: 'm', format: 'f3', decimals: 3, measure: 'level' }, currentYear));
  }
  // Normalised comparison: inches from each station's own July mean, on the
  // dates every station has in common.
  const withAvg = stations.filter(s => s.julyAvg !== null && s.series.length > 0);
  const maps = withAvg.map(s => new Map(s.series));
  const comparison = buildComparison(withAvg, maps,
    (v, s) => r1((v - s.julyAvg) * 100 / CM_PER_INCH));
  return { meta: { generated: todayIso, unit: 'm' }, stations, comparison };
}

// Cross-station series on the dates every station shares. `normalise` maps a
// raw reading to whatever quantity is actually comparable between gauges —
// inches from each gauge's own July mean for levels, percent of it for flow.
function buildComparison(stations, maps, normalise) {
  const commonDates = stations.length === 0 ? [] :
    [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  return {
    stations: stations.map(s => ({ id: s.id, name: s.name })),
    series: commonDates.map(date => [
      date,
      ...stations.map((s, i) => normalise(maps[i].get(date), s)),
    ]),
  };
}

export function buildFlowPayload(cache, todayIso) {
  const currentYear = parseInt(todayIso.substring(0, 4), 10);
  const stations = [];
  const omitted = [];
  for (const st of FLOW_STATIONS) {
    const days = seriesFrom(cache, `flow:${st.id}`);
    // A gauge can go dormant and leave only old readings behind (02EB006
    // stopped reporting in 2021); showing its last value as current would be
    // wrong by four years.
    const fresh = days.length > 0 && daysBetween(todayIso, days[days.length - 1].date) <= 90;
    if (!fresh) {
      if (days.length > 0) omitted.push({ id: st.id, name: st.name, lastDate: days[days.length - 1].date });
      continue;
    }
    stations.push(stationBlock(st, days, { unit: 'm³/s', format: 'f1', decimals: 1, measure: 'flow' }, currentYear));
  }
  // Discharge spans orders of magnitude between gauges (the Moon River peaks
  // near 177 m³/s, Baysville near 56), so raw m³/s on one axis just ranks catchment
  // size. Percent of each gauge's own July mean is the comparable quantity.
  const withAvg = stations.filter(s => s.julyAvg !== null && s.julyAvg !== 0 && s.series.length > 0);
  const maps = withAvg.map(s => new Map(s.series));
  const comparison = buildComparison(withAvg, maps,
    (v, s) => Math.round((v / s.julyAvg) * 100));

  return { meta: { generated: todayIso, unit: 'm³/s' }, stations, omitted, comparison };
}

// Trailing window by calendar date, not by row. Slicing the last N rows spans
// any gap in the record and silently relabels it — the Bala series still holds
// a 158-day hole, so `slice(-90)` reached back to December and drew a straight
// line across five missing months.
export function windowByDate(rows, days) {
  if (rows.length === 0) return rows;
  const cutoff = addDays(rows[rows.length - 1][0], -(days - 1));
  return rows.filter(r => r[0] >= cutoff);
}

// Records across every archived series. Coverage is wildly uneven — Port
// Sydney's flow reaches 1915 while three other flow gauges start in 2021 — so
// every entry carries its own period of record. A "record high" off five years
// and one off a century are not the same claim.
export function buildRecordsPayload(temps, cache, todayIso, peakRows = []) {
  const monthDay = todayIso.substring(5);
  const gauge = (st, key, unit, format, decimals, measure) => {
    const days = seriesFrom(cache, key);
    if (days.length === 0) return null;
    // Same staleness rule the flow page uses: a dormant gauge's last reading is
    // not a current record.
    if (measure === 'flow' && daysBetween(todayIso, days[days.length - 1].date) > 90) return null;
    return {
      id: st.id, name: st.name, label: st.label, unit, format, decimals, measure,
      firstDate: days[0].date, lastDate: days[days.length - 1].date, n: days.length,
      years: Math.max(1, Math.round(
        (new Date(days[days.length - 1].date) - new Date(days[0].date)) / 31557600000)),
      extremes: extremes(days),
      swings: biggestSwings(days, 7, 5),
      onThisDate: onThisDate(days, monthDay),
      gaps: recentCoverageGaps(days, todayIso),
      // Instantaneous crest, which runs higher than any daily mean. Null until
      // the daily job has fetched the annual-peaks collection at least once.
      peaks: peaksFor(peakRows, st.id, measure),
    };
  };

  const levels = LEVEL_STATIONS
    .map(st => gauge(st, `level:${st.id}`, 'm', 'f3', 3, 'level')).filter(Boolean);
  const flow = FLOW_STATIONS
    .map(st => gauge(st, `flow:${st.id}`, 'm³/s', 'f1', 1, 'flow')).filter(Boolean);

  // Temperature records come from the satellite archive rather than a gauge.
  const tempDays = temps.map(r => ({ date: r.date, value: r.tempC }));
  const byYear = new Map();
  for (const r of temps) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r.tempC);
  }
  // Partial years average fewer days and are not comparable, so rank only the
  // years with near-complete coverage.
  const fullYears = [...byYear.entries()]
    .filter(([, v]) => v.length >= 350)
    .map(([y, v]) => [y, r1(v.reduce((a, b) => a + b, 0) / v.length), v.length])
    .sort((a, b) => b[1] - a[1]);

  // Summarise the gap that bears on a record claim: the most recent one at each
  // gauge. They all end the day this project began caching realtime readings,
  // but they start at different points because Environment Canada publishes
  // each station's daily means on its own schedule — Bala is out through 2025,
  // most others only through 2024. Report both the window every gauge is
  // missing and the worst case, rather than averaging them into one vague line.
  const gauges = [...levels, ...flow];
  const latest = gauges.map(g => g.gaps[g.gaps.length - 1]).filter(Boolean);
  const affected = latest.length;
  const coverage = latest.length === 0 ? null : (() => {
    const endsAt = latest.map(g => g.to).sort().pop();
    const atEnd = latest.filter(g => g.to === endsAt);
    const froms = atEnd.map(g => g.from).sort();
    return {
      to: addDays(endsAt, -1),                  // last missing day
      commonFrom: addDays(froms[froms.length - 1], 1), // every gauge missing from here
      worstFrom: addDays(froms[0], 1),          // some gauges missing from here
      commonDays: Math.min(...atEnd.map(g => g.days)),
      worstDays: Math.max(...atEnd.map(g => g.days)),
      gauges: affected, totalGauges: gauges.length,
    };
  })();

  return {
    meta: {
      generated: todayIso, monthDay,
      coverage,
    },
    levels, flow,
    temperature: {
      firstDate: temps[0].date, lastDate: temps[temps.length - 1].date,
      n: temps.length, years: byYear.size,
      extremes: (() => {
        const e = extremes(tempDays);
        return { high: { ...e.high, value: r1(e.high.value) }, low: { ...e.low, value: r1(e.low.value) } };
      })(),
      warmestYears: fullYears.slice(0, 5),
      coolestYears: fullYears.slice(-5).reverse(),
      swimStreak: longestStreak(tempDays, v => v >= 20),
      onThisDate: (() => {
        const o = onThisDate(tempDays, monthDay);
        return o && { ...o, median: r1(o.median),
          high: { ...o.high, value: r1(o.high.value) },
          low: { ...o.low, value: r1(o.low.value) } };
      })(),
    },
  };
}

// Lake Muskoka's outflow at Bala. 02EB006 (Muskoka River below Bala) stopped
// reporting in 2021; the Moon River gauge at Highway 400 is the live gauge on
// the water that has just left the lake.
export const HOME_FLOW = '02EB011';

export function buildOverviewPayload(temp, levels, flow, todayIso) {
  const bala = levels.stations.find(s => s.id === STATION) ?? levels.stations[0];
  return {
    meta: { generated: todayIso },
    level: bala && {
      name: bala.name, label: bala.label, date: bala.latest.date,
      value: bala.latest.value, unit: 'm', vsJulyIn: bala.vsJulyIn,
      julyAvg: bala.julyAvg,
      percentile: bala.percentile, dist: bala.dist,
      trailing: bala.trailing, changes: bala.changes,
      ageDays: daysBetween(todayIso, bala.latest.date),
      // The home page draws this year against the gauge's whole-record
      // envelope, so it needs the two-year daily series and the normal block,
      // not a 90-day slice. Same shape as the station payload so the browser
      // uses the same renderer.
      latest: bala.latest,
      series: bala.series,
      normal: bala.normal,
    },
    temp: {
      date: temp.latest.date, value: temp.latest.value, unit: '°C',
      tempF: Math.round(temp.latest.value * 9 / 5 + 32),
      stats: temp.stats, forecast: temp.forecast, dist: temp.dist,
      swim: temp.swim,
      ageDays: temp.meta.lagDays, years: temp.meta.years,
    },
    // The home page takes the first of these. It used to be whatever came
    // first in the station list, which — once the gauge below Bala went dead —
    // was a river forty kilometres north of the lake. Name the one that
    // matters for Bala: the Moon River, where Lake Muskoka leaves at Bala.
    flow: [...flow.stations]
      .sort((a, b) => (a.id === HOME_FLOW ? -1 : b.id === HOME_FLOW ? 1 : 0))
      .map(s => ({
        id: s.id, name: s.name, label: s.label,
        date: s.latest.date, value: s.latest.value, percentile: s.percentile,
        vsJulyPct: s.vsJulyPct,
      })),
  };
}
