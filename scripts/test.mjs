// Regression tests for the pure data logic in notify.mjs.
//
//   npm test   (or: node scripts/test.mjs)
//
// No network, no canvas rendering — just the arithmetic that has bitten before:
// outlier filtering, row-vs-date lookups, day-of-year pooling, and the DAP
// ascii parser's unit handling.

import assert from 'node:assert/strict';
import {
  filterOutliers, readingNDaysBack, median, poolAroundDay, addDays, toRecord,
  mergeSeries, parseMurAscii, computeNextWeekTempForecast, parseAnnualPeakFeatures,
  windowLabel,
} from '../notify.mjs';
import {
  quantile, distribution, percentileOf, climatology, windowByDate,
  buildLevelsPayload, buildFlowPayload, buildRecordsPayload,
  dayOfYearEnvelope, withDayOfYear, extremes, biggestSwings, longestStreak, onThisDate,
  coverageGaps, recentCoverageGaps, peaksFor,
} from './lib/payloads.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const series = (vals) => vals.map((v, i) => ({ date: addDays('2026-08-01', i), value: v }));

// ── filterOutliers ──

test('interior spike is removed without taking its neighbours', () => {
  const out = filterOutliers(series([225.30, 226.50, 225.31, 225.32]));
  assert.deepEqual(out.map(d => d.value), [225.30, 225.31, 225.32]);
});

test('spike on the newest reading is removed', () => {
  const out = filterOutliers(series([225.30, 225.31, 225.30, 226.90]));
  assert.deepEqual(out.map(d => d.value), [225.30, 225.31, 225.30]);
});

test('spike on the oldest reading is removed', () => {
  const out = filterOutliers(series([226.90, 225.31, 225.30, 225.32]));
  assert.deepEqual(out.map(d => d.value), [225.31, 225.30, 225.32]);
});

test('a steady flood-rate rise passes untouched', () => {
  const rise = series(Array.from({ length: 20 }, (_, i) => 225.0 + i * 0.08));
  assert.equal(filterOutliers(rise).length, 20);
});

test('short series returned as-is', () => {
  const s = series([1, 99, 1]);
  assert.equal(filterOutliers(s), s);
});

// ── readingNDaysBack ──

test('finds the reading n calendar days back, not n rows back', () => {
  const days = [...series([1, 2, 3]),
    ...[10, 11, 12].map((v, i) => ({ date: addDays('2026-08-20', i), value: v }))];
  const back7 = readingNDaysBack(days, 7); // latest 2026-08-22, target 08-15 — nothing near
  assert.equal(back7, null);
  const back2 = readingNDaysBack(days, 2);
  assert.equal(back2.date, '2026-08-20');
});

test('tolerance picks the nearest reading within range', () => {
  const days = [{ date: '2026-08-10', value: 5 }, { date: '2026-08-18', value: 9 }];
  assert.equal(readingNDaysBack(days, 7).date, '2026-08-10'); // 8 days back, tolerance 3
  assert.equal(readingNDaysBack(days, 7, 0), null);
});

// ── median / pooling ──

test('median of even and odd counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('poolAroundDay wraps across the Dec/Jan boundary', () => {
  const records = [
    toRecord('2020-12-30', 1), toRecord('2021-01-02', 2), toRecord('2022-07-01', 3),
  ];
  const pool = poolAroundDay(records, 366, 3, 2026); // around Dec 31/Jan 1
  assert.deepEqual(pool.map(r => r.tempC).sort(), [1, 2]);
});

test('poolAroundDay excludes the given year', () => {
  const records = [toRecord('2025-06-01', 1), toRecord('2026-06-01', 2)];
  const pool = poolAroundDay(records, toRecord('2026-06-01', 0).dayOfYear, 0, 2026);
  assert.deepEqual(pool.map(r => r.tempC), [1]);
});

// ── mergeSeries ──

test('fresh values overwrite and the series comes back sorted', () => {
  const merged = mergeSeries(
    [{ date: '2026-08-01', value: 1.0 }],
    [{ date: '2026-08-01', value: 2.0 }, { date: '2026-07-31', value: 0.5 }],
  );
  assert.deepEqual(merged, [
    { date: '2026-07-31', value: 0.5 }, { date: '2026-08-01', value: 2.0 },
  ]);
});

test('merge keeps the whole record — nothing is capped', () => {
  // The old cache trimmed to the newest 400 days, silently discarding decades
  // of archive on every write.
  const long = Array.from({ length: 5000 }, (_, i) => ({ date: addDays('1960-01-01', i), value: i }));
  const merged = mergeSeries(long, [{ date: '2026-09-02', value: 9 }]);
  assert.equal(merged.length, 5001);
  assert.equal(merged[0].date, '1960-01-01');
});

test('merge drops malformed rows rather than poisoning the archive', () => {
  const merged = mergeSeries([], [
    { date: '2026-08-01', value: 1 }, { date: '2026-08-02', value: NaN },
    { date: null, value: 3 }, { date: '2026-08-03', value: 2 },
  ]);
  assert.deepEqual(merged.map(d => d.date), ['2026-08-01', '2026-08-03']);
});

// ── parseMurAscii unit handling ──

test('packed short is unscaled to °C', () => {
  // 21.5°C -> K: 294.65; packed = (294.65 - 298.15) / 0.001 = -3500
  assert.ok(Math.abs(parseMurAscii('[0][13500][10039], -3500') - 21.5) < 1e-9);
});

test('kelvin float is converted, celsius float passes through', () => {
  assert.ok(Math.abs(parseMurAscii('[0][13500], 294.65') - 21.5) < 1e-9);
  assert.equal(parseMurAscii('[0][13500], 21.5'), 21.5);
});

test('fill value and garbage are rejected', () => {
  assert.equal(parseMurAscii('[0][13500], -32768'), null);
  assert.equal(parseMurAscii('no data here'), null);
});

// ── computeNextWeekTempForecast ──

test('forecast reflects the historical week-over-week delta', () => {
  // Two prior years where the water always warms 1°C across the anchor→+7 gap
  const records = [];
  for (const year of [2024, 2025]) {
    for (let d = 0; d <= 14; d++) {
      records.push(toRecord(addDays(`${year}-07-01`, d), 20 + (d >= 7 ? 1 : 0)));
    }
  }
  const f = computeNextWeekTempForecast(records, '2026-07-03', 21.0);
  assert.ok(f, 'expected a forecast');
  assert.equal(f.direction, 'warm');
  assert.ok(Math.abs(f.expectedChange - 1) < 0.35, `expectedChange ${f.expectedChange}`);
  assert.equal(f.yearsUsed, 2);
});

test('forecast is null with no usable history', () => {
  assert.equal(computeNextWeekTempForecast([], '2026-07-03', 21.0), null);
});

// ── site payload shaping ──

test('quantile interpolates between neighbours', () => {
  const s = [1, 2, 3, 4];
  assert.equal(quantile(s, 0), 1);
  assert.equal(quantile(s, 1), 4);
  assert.equal(quantile(s, 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
});

test('distribution reports the five-number summary', () => {
  const d = distribution([5, 1, 3, 2, 4]);
  assert.equal(d.min, 1);
  assert.equal(d.p50, 3);
  assert.equal(d.max, 5);
  assert.equal(d.n, 5);
});

test('percentile places a value in its record', () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentileOf(vals, 0), 0);    // below everything
  assert.equal(percentileOf(vals, 11), 100); // above everything
  assert.equal(percentileOf(vals, 5), 45);   // 4 below, itself counted half
  assert.equal(percentileOf([], 5), null);
});

test('percentile is not direction-normalised', () => {
  // A cold reading must report a LOW percentile. Inverting for
  // "lower is better" would be inventing a judgement the data can't support.
  const vals = [10, 20, 30, 40];
  assert.ok(percentileOf(vals, 11) < 50);
  assert.ok(percentileOf(vals, 39) > 50);
});

test('climatology excludes the current year and spans every day', () => {
  const records = [];
  for (const year of [2023, 2024]) {
    for (let d = 0; d < 365; d++) records.push(toRecord(addDays(`${year}-01-01`, d), 10));
  }
  // A current-year outlier must not move the envelope
  records.push(toRecord('2026-06-01', 99));
  const rows = climatology(records, 2026);
  assert.equal(rows.length, 366);
  const june1 = rows[toRecord('2026-06-01', 0).dayOfYear - 1];
  assert.equal(june1[5], 10, 'current-year reading leaked into the envelope');
});

test('climatology wraps the pooling window across new year', () => {
  const records = [
    toRecord('2024-12-31', 4), toRecord('2025-01-02', 6),
  ];
  const rows = climatology(records, 2026);
  assert.equal(rows[0][3], 5, 'day 1 should pool both sides of the boundary');
});

test('windowByDate trims by calendar date, not row count', () => {
  // A gap in the middle: naive slice(-3) would reach back a year
  const rows = [['2025-01-01', 1], ['2025-01-02', 2], ['2026-08-28', 3], ['2026-08-29', 4], ['2026-08-30', 5]];
  assert.deepEqual(windowByDate(rows, 7).map(r => r[0]),
    ['2026-08-28', '2026-08-29', '2026-08-30']);
  assert.deepEqual(rows.slice(-3).map(r => r[0]),
    ['2026-08-28', '2026-08-29', '2026-08-30']);
  // and with the gap inside the window it must still exclude the old block
  assert.equal(windowByDate(rows, 400).length, 3);
});

// ── level vs flow framing ──
// A shared stationBlock once divided m³/s by 2.54 and printed the result as
// inches, so Bracebridge read "-279.9 in vs July avg".

function syntheticCache(prefix, id, base) {
  const days = [];
  for (let i = 0; i < 800; i++) {
    const date = addDays('2024-07-01', i);
    // Julys sit at `base`, the rest of the year lower, so julyAvg is well defined
    days.push({ date, value: date.substring(5, 7) === '07' ? base : base * 0.6 });
  }
  return { [`${prefix}:${id}`]: days };
}

test('flow reports a ratio, never a length', () => {
  const cache = syntheticCache('flow', '02EB013', 20);
  const st = buildFlowPayload(cache, '2026-09-10').stations[0];
  assert.equal(st.measure, 'flow');
  assert.equal(st.vsJulyIn, null, 'flow must not carry an inches value');
  assert.ok(Number.isFinite(st.vsJulyPct), 'flow must carry a percentage');
  // Sep sits on the off-season plateau, i.e. 60% of the July mean
  assert.ok(Math.abs(st.vsJulyPct - 60) <= 1, `expected ~60%, got ${st.vsJulyPct}`);
});

test('level reports inches, never a ratio', () => {
  const cache = syntheticCache('level', '02EB015', 225);
  const st = buildLevelsPayload(cache, '2026-09-10').stations[0];
  assert.equal(st.measure, 'level');
  assert.equal(st.vsJulyPct, null, 'level must not carry a percentage');
  assert.ok(Number.isFinite(st.vsJulyIn), 'level must carry an inches value');
});

test('flow gauges get a comparison series normalised to their own July mean', () => {
  const cache = {
    ...syntheticCache('flow', '02EB013', 20),
    ...syntheticCache('flow', '02EB011', 150), // 7x the catchment
  };
  const cmp = buildFlowPayload(cache, '2026-09-10').comparison;
  assert.equal(cmp.stations.length, 2);
  const [, a, b] = cmp.series[cmp.series.length - 1];
  // Normalisation must collapse the size difference: both ~60% of own July mean
  assert.ok(Math.abs(a - b) <= 1, `gauges should normalise together, got ${a} vs ${b}`);
});

test('monthly rows carry the within-month range, not just the mean', () => {
  // The chart draws a min-max band from columns 2 and 3; if monthlyMeans ever
  // stops emitting them the band silently disappears rather than erroring.
  const days = [];
  for (let i = 0; i < 400; i++) {
    const date = addDays('2025-01-01', i);
    days.push({ date, value: date.endsWith('-15') ? 10 : 5 });  // one spike a month
  }
  const st = buildLevelsPayload({ 'level:02EB015': days }, '2026-03-01').stations[0];
  assert.ok(st.monthly.length >= 12, 'expected a row per month');
  const [date, mean, min, max, n] = st.monthly[0];
  assert.match(date, /^\d{4}-\d{2}-15$/, 'monthly rows are dated mid-month so they plot as dates');
  assert.ok(Number.isFinite(mean) && Number.isFinite(min) && Number.isFinite(max));
  assert.equal(min, 5);
  assert.equal(max, 10, 'the monthly high must survive into the payload');
  assert.ok(n > 0);
});

// ── day-of-year normals on a {date,value} series ──

test('envelope works on plain {date,value} archive rows', () => {
  // climatology() reads r.tempC; the archive has r.value. The generic version
  // must handle the archive shape without a temperature-specific accessor.
  const recs = [];
  for (const y of [2023, 2024, 2025]) {
    for (let d = 0; d < 365; d++) recs.push(withDayOfYear(addDays(`${y}-01-01`, d), 100 + d));
  }
  const rows = dayOfYearEnvelope(recs, 2026);
  assert.equal(rows.length, 366);
  const day50 = rows[49];
  assert.equal(day50[0], 50);
  assert.ok(Number.isFinite(day50[3]), 'median should be a number');
});

test('envelope keeps 3-decimal precision for levels', () => {
  // 1-decimal rounding would flatten Bala's whole 224.28-226.05 m range.
  const recs = [];
  for (const y of [2023, 2024, 2025]) {
    for (let d = 0; d < 20; d++) recs.push(withDayOfYear(addDays(`${y}-06-01`, d), 225.123 + d * 0.001));
  }
  const row = dayOfYearEnvelope(recs, 2026)[withDayOfYear('2026-06-10', 0).dayOfYear - 1];
  assert.ok(String(row[3]).includes('.'), 'median should not be an integer');
  assert.ok(Math.abs(row[3] - 225.13) < 0.02, `expected ~225.13, got ${row[3]}`);
});

test('a station with too little history gets no normal', () => {
  // Two winters is not a normal. Guard is 3 prior years.
  const two = [];
  for (const y of [2025, 2026]) {
    for (let d = 0; d < 365; d++) two.push({ date: addDays(`${y}-01-01`, d), value: 5 });
  }
  const shallow = buildLevelsPayload({ 'level:02EB015': two }, '2026-09-06').stations[0];
  assert.equal(shallow.normal, null, 'two years must not produce a normal');

  const four = [];
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    for (let d = 0; d < 365; d++) four.push({ date: addDays(`${y}-01-01`, d), value: 5 });
  }
  const deep = buildLevelsPayload({ 'level:02EB015': four }, '2026-09-06').stations[0];
  assert.ok(deep.normal, 'four prior years should produce a normal');
  assert.equal(deep.normal.years, 4);
});

// ── records ──

test('extremes returns the dates, which distribution() drops', () => {
  const days = [
    { date: '2020-01-01', value: 5 }, { date: '2020-06-15', value: 9 },
    { date: '2021-03-02', value: 1 }, { date: '2021-08-08', value: 7 },
  ];
  const e = extremes(days);
  assert.equal(e.high.value, 9); assert.equal(e.high.date, '2020-06-15');
  assert.equal(e.low.value, 1);  assert.equal(e.low.date, '2021-03-02');
  assert.equal(extremes([]), null);
});

test('swings compare by date, so a gap cannot fake a jump', () => {
  // Two blocks a year apart. A row-based diff would call the seam a huge
  // 7-day swing; a date-based one skips it because no reading is 7 days back.
  const days = [
    ...Array.from({ length: 10 }, (_, i) => ({ date: addDays('2024-01-01', i), value: 10 })),
    ...Array.from({ length: 10 }, (_, i) => ({ date: addDays('2025-06-01', i), value: 90 })),
  ];
  const sw = biggestSwings(days, 7, 5);
  assert.equal(sw.rises.length, 0, 'no genuine 7-day rise exists here');
  assert.equal(sw.falls.length, 0);
});

test('swings find a real rise with its dates', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: addDays('2024-01-01', i), value: i < 10 ? 1 : 5,
  }));
  const top = biggestSwings(days, 7, 3).rises[0];
  assert.ok(top, 'expected a rise');
  assert.equal(top.change, 4);
  assert.equal(daysBetweenISO(top.from, top.to), 7);
});

test('streak breaks at a hole rather than bridging it', () => {
  const days = [
    ...Array.from({ length: 5 }, (_, i) => ({ date: addDays('2024-06-01', i), value: 25 })),
    // 30-day hole, then a longer warm run
    ...Array.from({ length: 8 }, (_, i) => ({ date: addDays('2024-07-10', i), value: 25 })),
  ];
  const s = longestStreak(days, v => v >= 20);
  assert.equal(s.length, 8, 'the two runs must not be joined across the hole');
  assert.equal(s.start, '2024-07-10');
});

test('onThisDate matches the exact calendar date across years', () => {
  const days = [
    { date: '2020-09-06', value: 3 }, { date: '2021-09-06', value: 7 },
    { date: '2021-09-07', value: 99 }, { date: '2022-09-06', value: 5 },
  ];
  const o = onThisDate(days, '09-06');
  assert.equal(o.n, 3, 'Sep 7 must not be counted');
  assert.equal(o.high.value, 7);
  assert.equal(o.low.value, 3);
  assert.equal(o.median, 5);
});

function daysBetweenISO(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

// ── coverage ──
// The records page reported an all-time high from 2019 while holding no data at
// all for spring 2026. Records over a hole are a claim the data cannot support,
// so the hole has to be detectable.

test('coverage finds an interior hole and ignores the ends', () => {
  const days = [
    ...Array.from({ length: 10 }, (_, i) => ({ date: addDays('2025-01-01', i), value: 1 })),
    // 150-day hole, exactly the shape of the real one
    ...Array.from({ length: 10 }, (_, i) => ({ date: addDays('2025-06-10', i), value: 1 })),
  ];
  const gaps = coverageGaps(days, 5);
  assert.equal(gaps.length, 1, 'a series simply starting and stopping is not a gap');
  assert.equal(gaps[0].from, '2025-01-10');
  assert.equal(gaps[0].to, '2025-06-10');
  assert.equal(gaps[0].days, 150);
});

test('coverage ignores ordinary single missing days', () => {
  const days = [
    { date: '2025-01-01', value: 1 }, { date: '2025-01-03', value: 1 },
    { date: '2025-01-04', value: 1 },
  ];
  assert.deepEqual(coverageGaps(days, 5), [], 'a one-day skip is not worth reporting');
});

test('only gaps recent enough to bear on a record are surfaced', () => {
  const days = [
    { date: '2005-01-01', value: 1 }, { date: '2006-06-01', value: 1 }, // ancient hole
    ...Array.from({ length: 5 }, (_, i) => ({ date: addDays('2026-07-01', i), value: 1 })),
  ];
  const all = coverageGaps(days, 5);
  const recent = recentCoverageGaps(days, '2026-09-06', 730);
  assert.equal(all.length, 2);
  assert.equal(recent.length, 1, 'a 20-year-old hole is context, not a caveat');
  assert.equal(recent[0].to, '2026-07-01');
});

test('the records payload reports the gap it cannot see past', () => {
  // Two years of data, then nothing for five months, then a short recent run:
  // the shape that made "highest ever" wrong.
  const days = [
    ...Array.from({ length: 700 }, (_, i) => ({ date: addDays('2024-01-01', i), value: 10 })),
    ...Array.from({ length: 30 }, (_, i) => ({ date: addDays('2026-06-07', i), value: 12 })),
  ];
  const temps = Array.from({ length: 400 }, (_, i) => toRecord(addDays('2025-01-01', i), 15));
  const r = buildRecordsPayload(temps, { 'level:02EB015': days }, '2026-09-06');
  assert.ok(r.meta.coverage, 'a five-month hole must be reported');
  assert.equal(r.meta.coverage.to, '2026-06-06', 'last missing day');
  assert.ok(r.meta.coverage.commonFrom > '2025-11-01', `unexpected start ${r.meta.coverage.commonFrom}`);
});

// ── annual instantaneous peaks ──
// Property names below are the real ones, taken from a live probe of
// hydrometric-annual-peaks. The VALUES inside DATA_TYPE_EN and PEAK_CODE_EN
// have not been observed, so nothing may depend on a particular string.

const peakFeature = (st, date, type, code, units, peak) => ({ properties: {
  DATE: date + 'T00:00:00Z', STATION_NUMBER: st, DATA_TYPE_EN: type,
  PEAK_CODE_EN: code, UNITS_EN: units, SYMBOL_EN: '', PEAK: peak } });

test('peak features parse, and junk rows are dropped', () => {
  const rows = parseAnnualPeakFeatures([
    peakFeature('02EB015', '2019-05-03', 'Water Level', 'Maximum', 'm', 226.42),
    peakFeature('02EB015', '2019-03-15', 'Water Level', 'Minimum', 'm', 224.30),
    { properties: { DATE: null, PEAK: 5 } },              // no date
    { properties: { DATE: '2019-01-01', PEAK: 'n/a' } },  // unparseable value
  ], '02EB015');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2019-05-03', 'timestamp trimmed to a date');
  assert.equal(rows[0].value, 226.42);
});

test('crest is taken from the values, not from a label string', () => {
  // PEAK_CODE_EN vocabulary is unobserved, so an unfamiliar label must not
  // break the classification.
  const rows = parseAnnualPeakFeatures([
    peakFeature('02EB015', '2019-05-03', 'Water Level', 'ANNUAL MAX', 'm', 226.42),
    peakFeature('02EB015', '2005-03-01', 'Water Level', 'whatever', 'm', 224.10),
    peakFeature('02EB015', '2012-04-01', 'Water Level', '', 'm', 225.50),
  ], '02EB015');
  const p = peaksFor(rows, '02EB015', 'level');
  assert.equal(p.high.value, 226.42);
  assert.equal(p.high.date, '2019-05-03');
  assert.equal(p.low.value, 224.10);
  assert.equal(p.firstYear, '2005');
  assert.equal(p.lastYear, '2019');
});

test('level and flow peaks do not contaminate each other', () => {
  const rows = parseAnnualPeakFeatures([
    peakFeature('02EB004', '2019-04-26', 'Water Level', 'Maximum', 'm', 3.6),
    peakFeature('02EB004', '2019-04-26', 'Discharge', 'Maximum', 'm3/s', 234),
  ], '02EB004');
  assert.equal(peaksFor(rows, '02EB004', 'level').high.value, 3.6);
  assert.equal(peaksFor(rows, '02EB004', 'flow').high.value, 234);
  assert.equal(peaksFor(rows, '02EB999', 'level'), null, 'unknown station yields nothing');
});

test('an unrecognised data type falls back to units, then gives up', () => {
  const byUnits = parseAnnualPeakFeatures([
    peakFeature('02EB015', '2019-05-03', 'Mystery', 'Max', 'm3/s', 99),
  ], '02EB015');
  assert.ok(peaksFor(byUnits, '02EB015', 'flow'), 'units should rescue it');
  const hopeless = parseAnnualPeakFeatures([
    peakFeature('02EB015', '2019-05-03', 'Mystery', 'Max', 'furlongs', 99),
  ], '02EB015');
  assert.equal(peaksFor(hopeless, '02EB015', 'level'), null);
  assert.equal(peaksFor(hopeless, '02EB015', 'flow'), null);
});

// A chart labelled "trailing 90 days" while plotting three weeks is not a
// cosmetic problem: it is the chart asserting coverage it does not have. This
// is what the daily email did through spring 2026, when the published daily
// means stopped at 2025-12-31 and only the realtime pool remained.
const span = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    out.push({ date: d, value: 1 });
  }
  return out;
};

test('a full window is described as the full window', () => {
  assert.equal(windowLabel(span('2026-06-03', '2026-08-31')), 'trailing 90 days');
});

test('a short window says how short it really is', () => {
  const label = windowLabel(span('2026-08-01', '2026-08-31'));
  assert.equal(label, 'trailing 31 days — all that is published');
  assert.ok(!label.includes('90'), 'must not claim 90 days it does not have');
});

test('a window with a hole in it reports both the span and the coverage', () => {
  const holed = [...span('2026-06-03', '2026-06-10'), ...span('2026-08-20', '2026-08-31')];
  assert.equal(windowLabel(holed), 'trailing 90 days, 20 with data');
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ', 0 failed'}`);
