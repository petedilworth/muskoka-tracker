// Static-site generator for the Muskoka Tracker dashboard.
//
//   node scripts/build-site.mjs        (or: npm run build:site)
//
// Reads only data/ from disk and writes docs/. No network, so the build is
// deterministic, runs in a sandbox, and cannot be broken by an upstream API
// outage — the daily notifier is what refreshes data/.

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  TODAY_ISO, CURRENT_YEAR, STATION, daysBetween, ordinal, addDays,
} from '../notify.mjs';
import {
  loadTemps, loadLevelCache, buildTemperaturePayload, buildAllYearsPayload,
  buildLevelsPayload, buildFlowPayload, buildOverviewPayload, buildRecordsPayload,
  loadPeaks,
} from './lib/payloads.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = here + '../';
const DOCS = ROOT + 'docs/';
const PAYLOAD_WARN_KB = 300;

// ── html helpers ──

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NAV = [
  ['index.html', 'Today'],
  ['temperature.html', 'Temperature'],
  ['levels.html', 'Water levels'],
  ['flow.html', 'River flow'],
  ['records.html', 'Records'],
  ['about.html', 'About'],
];

function page({ file, title, heading, sub, body, script }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Public gauge data, but this is a personal dashboard — keep it out of search results. -->
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<!-- Inline so the browser never fires a request for /favicon.ico -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%8C%8A%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<header class="site">
  <div class="wrap">
    <div class="brand">
      <h1>🌊 Muskoka Tracker</h1>
      <span class="sub">Lake Muskoka &amp; Rosseau water conditions</span>
    </div>
    <nav class="site">
      ${NAV.map(([href, label]) =>
        `<a href="${href}"${href === file ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('\n      ')}
    </nav>
  </div>
</header>
<main class="wrap">
  <h2 style="margin:0 0 2px;font-size:22px;">${esc(heading)}</h2>
  <p style="margin:0 0 18px;color:var(--muted);font-size:13px;">${sub}</p>
${body}
  <footer class="site">
    Gauge data: Environment and Climate Change Canada, MSC GeoMet (station 02EB015 and neighbours).
    Water temperature: NOAA MUR SST v4.1 satellite analysis.<br>
    Rebuilt automatically each morning. Generated ${TODAY_ISO}.
  </footer>
</main>
<script src="assets/chart.umd.js"></script>
<script src="assets/app.js"></script>
<script>
${script}
</script>
</body>
</html>
`;
}

const card = (inner, href) => href
  ? `<a class="card" href="${href}">${inner}</a>`
  : `<div class="card">${inner}</div>`;

function kvTable(rows, head) {
  return `<div class="table-scroll"><table class="kv">
    <tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map((c, i) =>
      `<td${i > 0 ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('\n    ')}
  </table></div>`;
}

function chartCard({ title, sub, id, legend, toggles, short }) {
  return `<div class="chart-card">
    <div class="chart-head">
      <div>
        <div class="chart-title">${esc(title)}</div>
        ${sub ? `<div class="chart-sub">${sub}</div>` : ''}
      </div>
      ${toggles ? `<div class="toggles" id="${id}-toggles">${toggles.map(([v, l], i) =>
        `<button type="button" data-value="${v}" aria-pressed="${i === toggles.findIndex(t => t[2]) ? 'true' : 'false'}">${esc(l)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="chart-box${short ? ' short' : ''}"><canvas id="${id}"></canvas></div>
    ${legend ? `<div class="legend">${legend}</div>` : ''}
  </div>`;
}

// Level and flow compare to their July mean differently — a difference in
// inches for level, a ratio for flow. Sharing one formula is what produced
// "-279.9 in vs July avg" for a discharge gauge.
function vsJuly(st) {
  if (st.measure === 'flow' && st.vsJulyPct !== null && st.vsJulyPct !== undefined) {
    return ` &middot; ${st.vsJulyPct}% of the July average`;
  }
  if (st.vsJulyIn !== null && st.vsJulyIn !== undefined) {
    return ` &middot; ${st.vsJulyIn > 0 ? '+' : ''}${st.vsJulyIn.toFixed(1)} in vs July avg`;
  }
  return '';
}

// The second comparison: how today sits against normal for its own calendar
// date. "vs July avg" applies one summer number to all 365 days, so on its own
// it says little in February. Always states how many years the normal rests on,
// because a shallow gauge can report a 100th percentile off four years.
function vsNormal(st) {
  const n = st.normal;
  if (!n) return '';
  const amount = st.measure === 'flow'
    ? `${n.vsNormalPct}% of normal`
    : `${n.vsNormalIn > 0 ? '+' : ''}${n.vsNormalIn.toFixed(1)} in vs normal`;
  return `<p class="lede">${amount} for ${escDate(st.latest.date).replace(/, \d{4}$/, '')}`
    + ` &middot; ${pctLine(n.percentile, `for this date across ${n.years} years (${n.earliestYear}–${n.latestYear})`)}</p>`;
}

const sw = (color, cls) => `<span class="swatch ${cls || ''}" style="background:${color}"></span>`;

// The charts show flat stretches broken by sudden steps, and until now the site
// gave no reason for that shape. Lake Muskoka is a regulated lake; the steps are
// dam operation, not weather. Saying so is worth doing on its own, whether or
// not the OPG operations data ever gets wired in.
const MANAGED_EXPLAINER = `<details class="explain"><summary>Why the level steps up and down so abruptly</summary><div class="body">
      <p>Lake Muskoka is not at a natural level. It is controlled by dams at Bala — operating since 1873 — and at Port Carling, with the Ministry of Natural Resources setting stop logs under the Muskoka River Water Management Plan and its annual lake operating plans.</p>
      <p>That is why these charts show flat stretches broken by sudden steps rather than the smooth curve rainfall alone would produce. A step usually means logs went in or came out, not that it rained. Levels are drawn down ahead of the spring melt and held through the summer.</p>
      <p>Nothing here is adjusted for dam operation. These are the gauge readings as published.</p>
    </div></details>`;

function explain(summary, bodyHtml) {
  return `<details class="explain"><summary>${esc(summary)}</summary><div class="body">${bodyHtml}</div></details>`;
}

// Percentile phrasing, stated as a percentile rather than "better than N%" —
// there is no better or worse here, only where today sits in the record.
const pctLine = (p, what) =>
  p === null || p === undefined ? '' : `${ordinal(p)} percentile ${what}`;

function staleNotice(ageDays, what, threshold) {
  if (ageDays === null || ageDays === undefined || ageDays <= threshold) return '';
  return `<div class="notice">The most recent ${what} reading is ${ageDays} days old. Everything below describes that reading, not today.</div>`;
}

// ── pages ──

function indexPage(o, temp) {
  const lvl = o.level;
  const t = o.temp;

  const levelCard = lvl ? card(`
      <h2>Water level · ${esc(lvl.name)}</h2>
      <div class="big num">${lvl.vsJulyIn === null ? '—' : (lvl.vsJulyIn > 0 ? '+' : '') + lvl.vsJulyIn.toFixed(1)}<span class="unit">in vs July avg</span></div>
      <div class="asof">${lvl.value.toFixed(3)} m &middot; ${escDate(lvl.date)}</div>
      <p class="lede">${pctLine(lvl.percentile, `of ${lvl.dist.n.toLocaleString('en-CA')} readings on record`)}</p>
      ${kvTable([
        ['Latest', lvl.value.toFixed(3)],
        ['7-day mean', lvl.trailing.d7 === null ? '—' : lvl.trailing.d7.toFixed(3)],
        ['30-day mean', lvl.trailing.d30 === null ? '—' : lvl.trailing.d30.toFixed(3)],
      ], ['', 'metres'])}
      <div class="dist" id="dist-overview-level"></div>
    `, 'levels.html') : '';

  const tempCard = card(`
      <h2>Water temperature</h2>
      <div class="big num">${t.value.toFixed(1)}<span class="unit">°C</span><span class="alt">${t.tempF}°F</span></div>
      <div class="asof">${escDate(t.date)}${t.ageDays > 0 ? ` &middot; satellite lags ${t.ageDays} day${t.ageDays === 1 ? '' : 's'}` : ''}</div>
      <p class="lede">${t.stats ? `${pctLine(t.stats.percentile, `for this time of year across ${t.years} years`)} &middot; ${ordinal(t.stats.rank)} warmest of ${t.stats.totalYears}` : ''}</p>
      ${t.stats ? kvTable([
        ['Today', t.value.toFixed(1)],
        ['Typical (median)', t.stats.median.toFixed(1)],
        ['Range on record', `${t.stats.min.toFixed(1)}–${t.stats.max.toFixed(1)}`],
      ], ['', '°C']) : ''}
      <div class="dist" id="dist-overview-temp"></div>
    `, 'temperature.html');

  const flowCard = o.flow.length ? card(`
      <h2>River flow</h2>
      <div class="big num">${o.flow[0].value.toFixed(1)}<span class="unit">m³/s</span></div>
      <div class="asof">${esc(o.flow[0].name)} &middot; ${escDate(o.flow[0].date)}</div>
      <p class="lede">${pctLine(o.flow[0].percentile, 'of readings on record')}</p>
      ${kvTable(o.flow.slice(0, 4).map(s => [esc(s.name), s.value.toFixed(1)]), ['Gauge', 'm³/s'])}
    `, 'flow.html') : '';

  const outlook = t.forecast
    ? `<p class="lede" style="margin-top:14px;">Over the next seven days the water has historically ${
        t.forecast.direction === 'hold steady' ? 'held steady'
          : t.forecast.direction + 'ed by about ' + Math.abs(t.forecast.expectedChange).toFixed(1) + ' °C'
      } from this point in the season, across ${t.forecast.yearsUsed} years.</p>` : '';

  const body = `
  ${staleNotice(lvl ? lvl.ageDays : null, 'gauge', 2)}
  <div class="cards">${levelCard}${tempCard}${flowCard}</div>
  ${outlook}
  <div class="section">
    <h2>Bala water level &middot; last 90 days</h2>
    ${chartCard({
      title: 'Bala — Lake Muskoka',
      sub: 'Daily level against the five-year July average',
      id: 'ch-level',
      legend: `${sw('#2D6A9F')}Daily level ${sw('#E07B4C', 'dot')}Latest ${sw('#5BA88A')}July average`,
    })}
  </div>`;

  const script = `
Muskoka.getJSON('data/overview.json').then(function (o) {
  if (!o.level) return;
  var st = { name: o.level.name, unit: 'm', format: 'f3', decimals: 3, series: o.level.series };
  Muskoka.charts.datedSeries(document.getElementById('ch-level'), st, 90, ${lvl && lvl.julyAvg !== null && lvl.julyAvg !== undefined ? lvl.julyAvg : 'null'});
  Muskoka.renderDist(document.getElementById('dist-overview-level'), o.level.dist, o.level.value, 'f3', 'm');
  if (o.temp && o.temp.dist) {
    Muskoka.renderDist(document.getElementById('dist-overview-temp'), o.temp.dist, o.temp.value, 'f1', '°C');
  }
});`;

  return page({
    file: 'index.html', title: 'Muskoka Tracker — today',
    heading: 'Today on the lake',
    sub: `Level, temperature and flow as of the most recent reading from each source.`,
    body, script,
  });
}

function escDate(iso) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = String(iso).split('-');
  return `${M[parseInt(p[1], 10) - 1]} ${parseInt(p[2], 10)}, ${p[0]}`;
}

function temperaturePage(t) {
  const s = t.stats;
  const body = `
  ${staleNotice(t.meta.lagDays, 'satellite', 4)}
  <div class="cards">
    ${card(`
      <h2>Latest reading</h2>
      <div class="big num">${t.latest.value.toFixed(1)}<span class="unit">°C</span><span class="alt">${Math.round(t.latest.value * 9 / 5 + 32)}°F</span></div>
      <div class="asof">${escDate(t.latest.date)}</div>
      ${s ? `<p class="lede">${pctLine(s.percentile, 'for this week of the year')}, and the ${ordinal(s.rank)} warmest of ${s.totalYears} years on record.</p>` : ''}
      <div class="dist" id="dist-temp"></div>
    `)}
    ${card(`
      <h2>This week of the year, ${s ? s.earliestYear + '–' + s.latestYear : ''}</h2>
      ${s ? kvTable([
        ['Today', t.latest.value.toFixed(1)],
        ['Median', s.median.toFixed(1)],
        ['Coldest on record', s.min.toFixed(1)],
        ['Warmest on record', s.max.toFixed(1)],
      ], ['', '°C']) : ''}
      <p class="lede">Readings pooled from ${esc(escDate(s ? s.windowStart : ''))} to ${esc(escDate(s ? s.windowEnd : ''))} in every year on record.</p>
    `)}
    ${t.forecast ? card(`
      <h2>Next seven days</h2>
      <div class="big num">${t.forecast.direction === 'hold steady' ? 'Steady' : (t.forecast.expectedChange > 0 ? '+' : '') + t.forecast.expectedChange.toFixed(1)}${t.forecast.direction === 'hold steady' ? '' : '<span class="unit">°C</span>'}</div>
      <div class="asof">typical change by ${escDate(t.forecast.futureDate)}</div>
      <p class="lede">Based on what the water actually did over the same seven calendar days in ${t.forecast.yearsUsed} previous years. High confidence in direction, less in magnitude.</p>
    `) : ''}
  </div>

  <div class="section">
    <h2>${t.meta.years} years of readings</h2>
    ${chartCard({
      title: `${t.current.year} against the ${t.meta.years}-year record`,
      sub: 'Shaded bands show the full range and the middle half of all previous years',
      id: 'ch-clim',
      toggles: [['season', 'This season', true], ['year', 'Full year', false], ['all', 'All years', false]],
      legend: `${sw('#2D6A9F')}${t.current.year} ${sw('#C0392B')}${t.previous.year} ${sw('rgba(107,142,173,0.28)', 'band')}Middle half ${sw('rgba(107,142,173,0.16)', 'band')}Full range ${sw('#E07B4C', 'dot')}Latest`,
    })}
    ${explain('How the bands are built', `
      <p>For every day of the year, all readings within ±3 days of it — in every year except the current one — are pooled together. The bands are the minimum, 25th percentile, 75th percentile and maximum of that pool.</p>
      <code class="formula">pool(day)  = readings from day−3 … day+3, all years except ${t.current.year}
full range = min(pool) … max(pool)
middle half = 25th percentile(pool) … 75th percentile(pool)</code>
      <p>The ±3-day window keeps a single noisy satellite reading from putting a notch in the envelope. It is the same window used for the ranking and the percentile, so all three describe the same set of readings.</p>`)}
  </div>

  <div class="section">
    <h2>This year against normal</h2>
    ${chartCard({
      title: 'Daily difference from the median',
      sub: `Each bar is that day's reading minus the ${t.meta.years}-year median for the same day`,
      id: 'ch-anom', short: true,
      legend: `${sw('#E07B4C')}Warmer than usual ${sw('#2D6A9F')}Cooler than usual`,
    })}
    ${explain('What each bar is measured against', `
      <p>Every bar is one day of ${t.current.year} minus the typical reading for that same day of the year, taken across the other ${t.meta.years - 1} years on record. Zero means the water was exactly normal for the date.</p>
      <code class="formula">bar = this year's reading − median(same day ±3 days, all other years)</code>
      <p>Because the comparison moves with the calendar, a bar in April and a bar in August mean the same thing: how far the water sat from normal <em>for that date</em>. A warm bar in April does not mean the water was warm, only that it was warmer than most Aprils.</p>
      <p>The baseline is the same ±3-day pool the bands above use, so the two charts describe the same history.</p>`)}
  </div>

  <div class="section">
    <h2>Yearly averages</h2>
    ${kvTable(
      t.yearMeans.slice().reverse().map(([y, mean, n]) =>
        [String(y), mean.toFixed(1), String(n)]),
      ['Year', 'Mean °C', 'Days'])}
    <p class="lede">Mean of every reading in the year. Partial years (the first and the current) average fewer days and are not comparable to full ones.</p>
  </div>`;

  const script = `
// temperature.json already carries all of this; inlining a second copy in the
// page doubled the bytes and gave the same numbers two places to drift apart.
var T = null, chart = null, allYears = null;
function draw(mode) {
  if (!T) return;
  if (chart) { chart.destroy(); chart = null; }
  var el = document.getElementById('ch-clim');
  if (mode === 'all') {
    if (!allYears) {
      Muskoka.getJSON('data/temperature-allyears.json').then(function (d) { allYears = d; draw('all'); });
      return;
    }
    chart = Muskoka.charts.tempAllYears(el, allYears);
  } else if (mode === 'year') {
    chart = Muskoka.charts.tempClimatology(el, T, { xMin: 1, xMax: 366 });
  } else {
    chart = Muskoka.charts.tempClimatology(el, T, {
      xMin: Math.max(1, T.latest.dayOfYear - 120), xMax: Math.min(366, T.latest.dayOfYear + 20)
    });
  }
}
Muskoka.getJSON('data/temperature.json').then(function (d) {
  T = d;
  draw('season');
  Muskoka.charts.tempAnomaly(document.getElementById('ch-anom'), T);
  Muskoka.renderDist(document.getElementById('dist-temp'), T.dist, T.latest.value, 'f1', '°C');
});
Muskoka.toggleGroup(document.getElementById('ch-clim-toggles'), draw);`;

  return page({
    file: 'temperature.html', title: 'Muskoka Tracker — water temperature',
    heading: 'Water temperature',
    sub: `${t.meta.records.toLocaleString('en-CA')} daily satellite readings, ${escDate(t.meta.firstDate)} to ${escDate(t.meta.lastDate)}.`,
    body, script,
  });
}

function stationPage({ file, title, heading, sub, payload, comparison, note, measure }) {
  const withNormal = payload.stations.find(st => st.normal);
  const normalNote = withNormal ? explain('What "normal for the date" means', `
      <p>Two comparisons sit on each card and they answer different questions. <strong>Vs July average</strong> compares against the mean of every July day in the last five years: a fixed summer benchmark, useful for "is the lake up or down for the season". <strong>Vs normal for the date</strong> compares against what this gauge has actually done on this calendar date across its whole record.</p>
      <code class="formula">normal(date) = median of readings from date−3 … date+3, every year except this one</code>
      <p>The second is the one that stays meaningful in February, when comparing to July says little. The shaded bands on the charts are that same calculation drawn across the whole window: the darker band is the middle half of past years, the lighter one the full recorded range, and the dashed line the median.</p>
      <p>A normal needs depth to mean anything, so it is only shown for gauges with at least three prior years, and every card states how many years its normal rests on. ${esc(withNormal.name)}'s rests on ${withNormal.normal.years}.</p>`) : '';

  const managedNote = measure === 'level'
    ? `\n  <div class="section">${MANAGED_EXPLAINER}${normalNote}</div>`
    : (normalNote ? `\n  <div class="section">${normalNote}</div>` : '');
  const cards = payload.stations.map(st => card(`
      <h2>${esc(st.name)} &middot; ${esc(st.label)}</h2>
      <div class="big num">${st.latest.value.toFixed(st.decimals)}<span class="unit">${esc(st.unit)}</span></div>
      <div class="asof">${escDate(st.latest.date)}${vsJuly(st)}</div>
      <p class="lede">${pctLine(st.percentile, `of all ${st.n.toLocaleString('en-CA')} readings on record (${st.firstDate.substring(0, 4)}–${st.lastDate.substring(0, 4)})`)}</p>
      ${vsNormal(st)}
      ${kvTable([
        ['1-day change', fmtChange(st.changes.d1, st.decimals)],
        ['7-day change', fmtChange(st.changes.d7, st.decimals)],
        ['30-day change', fmtChange(st.changes.d30, st.decimals)],
        ['7-day mean', st.trailing.d7 === null ? '—' : st.trailing.d7.toFixed(st.decimals)],
        ['30-day mean', st.trailing.d30 === null ? '—' : st.trailing.d30.toFixed(st.decimals)],
      ], ['', st.unit])}
      <div class="dist" id="dist-${st.id}"></div>
    `)).join('\n    ');

  const charts = payload.stations.map(st => chartCard({
    title: `${st.name} — ${st.label}`,
    sub: `${st.n.toLocaleString('en-CA')} readings, ${escDate(st.firstDate)} to ${escDate(st.lastDate)}`,
    id: `ch-${st.id}`,
    toggles: [['90', '90 days', true], ['365', '1 year', false], ['730', '2 years', false], ['9999', `All ${st.years}y`, false]],
    legend: `${sw('#2D6A9F')}Daily ${sw('#E07B4C', 'dot')}Latest`
      + `${st.julyAvg !== null ? ` ${sw('#5BA88A')}July avg (${st.julyAvgYears}-yr)` : ''}`
      + `${st.normal ? ` ${sw('#6B6B6B')}Normal for the date ${sw('rgba(107,142,173,0.28)', 'band')}Middle half ${sw('rgba(107,142,173,0.16)', 'band')}Full range` : ''}`
      + ` &middot; the "All" view switches to monthly means with each month's range shaded`,
  })).join('\n    ');

  const cmp = (comparison && payload.comparison && payload.comparison.series.length) ? `
  <div class="section">
    <h2>All gauges compared</h2>
    ${chartCard({
      title: measure === 'flow'
        ? 'Each gauge as a percent of its own July average'
        : 'Inches above or below each gauge’s own July average',
      sub: 'The only fair comparison between these gauges — see the note below',
      id: 'ch-cmp',
      toggles: [['90', '90 days', true], ['365', '1 year', false], ['730', '2 years', false]],
      legend: payload.comparison.stations.map((s, i) =>
        `${sw(['#2D6A9F', '#E07B4C', '#5BA88A', '#C0392B', '#7B5EA7'][i % 5])}${esc(s.name)}`).join(' '),
    })}
    ${measure === 'flow' ? explain('Why these gauges cannot share a raw axis', `
      <p>These rivers drain catchments of very different size, so plotting raw discharge together mostly ranks catchment area. Port Carling peaks near 177 m³/s while Baysville peaks near 56 — the gap between them says more about geography than about conditions.</p>
      <code class="formula">value = flow ÷ that gauge's 5-year July mean × 100</code>
      <p>Dividing by each gauge's own July average removes the size difference and leaves what is comparable: how hard each river is running relative to its own normal. 100% is a typical July day.</p>`)
    : explain('Why these gauges cannot share a raw axis', `
      <p>The five level gauges are surveyed to different datums. Bala reads about 225 m above sea level; the others read between 0 and 10 m on local gauge datums. Plotting them together raw would say nothing except which datum each surveyor chose.</p>
      <code class="formula">value = (level − that gauge's 5-year July mean) ÷ 2.54 cm per inch</code>
      <p>Subtracting each gauge's own July average removes the datum and leaves the part that is actually comparable: how high the water is running for the season.</p>`)}
  </div>` : '';

  const script = `
Muskoka.getJSON('data/${file.replace('.html', '')}.json').then(function (d) {
  d.stations.forEach(function (st) {
    var chart = null;
    function draw(days) {
      if (chart) chart.destroy();
      chart = Muskoka.charts.datedSeries(document.getElementById('ch-' + st.id), st, parseInt(days, 10), st.julyAvg);
    }
    draw(90);
    Muskoka.toggleGroup(document.getElementById('ch-' + st.id + '-toggles'), draw);
    Muskoka.renderDist(document.getElementById('dist-' + st.id), st.dist, st.latest.value, st.format, st.unit);
  });
  ${comparison ? `
  if (d.comparison && d.comparison.series.length) {
    var c = null;
    function drawCmp(days) {
      if (c) c.destroy();
      c = Muskoka.charts.comparison(document.getElementById('ch-cmp'), d.comparison, parseInt(days, 10), '${measure}');
    }
    drawCmp(90);
    Muskoka.toggleGroup(document.getElementById('ch-cmp-toggles'), drawCmp);
  }` : ''}
});`;

  return page({
    file, title, heading, sub,
    body: `${note}<div class="cards">${cards}</div>\n  <div class="section">${charts}</div>${managedNote}${cmp}`,
    script,
  });
}

function fmtChange(c, decimals) {
  if (!c) return '—';
  const v = c.change;
  return `${v > 0 ? '+' : ''}${v.toFixed(decimals)}`;
}

function recordsPage(r) {
  const t = r.temperature;
  const fmtV = (v, d) => v === null || v === undefined ? '—' : v.toFixed(d);
  const cov = (g) => `${g.firstDate.substring(0, 4)}–${g.lastDate.substring(0, 4)}`;

  // Instantaneous crests are a different measurement from daily means, not a
  // better version of the same one, so they get their own column rather than
  // quietly replacing the daily figure.
  const gaugeTable = (gauges, heading) => {
    if (gauges.length === 0) return '';
    const anyPeaks = gauges.some(g => g.peaks);
    const head = ['Gauge', `Highest daily mean (${gauges[0].unit})`,
      ...(anyPeaks ? [`Instantaneous crest (${gauges[0].unit})`] : []),
      `Lowest daily mean (${gauges[0].unit})`, 'Record'];
    return `
  <div class="section">
    <h2>${heading}</h2>
    ${kvTable(gauges.map(g => [
      `${esc(g.name)} <span style="color:var(--faint)">${esc(g.label)}</span>`,
      `${fmtV(g.extremes.high.value, g.decimals)} <span style="color:var(--faint)">${escDate(g.extremes.high.date)}</span>`,
      ...(anyPeaks ? [g.peaks
        ? `${fmtV(g.peaks.high.value, g.decimals)} <span style="color:var(--faint)">${escDate(g.peaks.high.date)}</span>`
        : '—'] : []),
      `${fmtV(g.extremes.low.value, g.decimals)} <span style="color:var(--faint)">${escDate(g.extremes.low.date)}</span>`,
      `${cov(g)} <span style="color:var(--faint)">${g.n.toLocaleString('en-CA')}</span>`,
    ]), head)}
    ${anyPeaks ? `<p class="lede">The crest column is the highest instantaneous reading Environment Canada recorded that year, which is higher than any daily average of the same flood.</p>` : ''}
  </div>`;
  };

  const swingTable = (gauges, heading) => {
    const rows = [];
    for (const g of gauges) {
      const rise = g.swings.rises[0], fall = g.swings.falls[0];
      if (!rise && !fall) continue;
      rows.push([
        `${esc(g.name)}`,
        rise ? `+${fmtV(rise.change, g.decimals)} <span style="color:var(--faint)">to ${escDate(rise.to)}</span>` : '—',
        fall ? `${fmtV(fall.change, g.decimals)} <span style="color:var(--faint)">to ${escDate(fall.to)}</span>` : '—',
        cov(g),
      ]);
    }
    return rows.length === 0 ? '' : `
  <div class="section">
    <h2>${heading}</h2>
    ${kvTable(rows, ['Gauge', 'Largest 7-day rise', 'Largest 7-day fall', 'Record'])}
  </div>`;
  };

  const onDate = (gauges) => {
    const rows = gauges.filter(g => g.onThisDate).map(g => {
      const o = g.onThisDate;
      return [
        `${esc(g.name)}`,
        fmtV(o.median, g.decimals),
        `${fmtV(o.high.value, g.decimals)} <span style="color:var(--faint)">${o.high.date.substring(0, 4)}</span>`,
        `${fmtV(o.low.value, g.decimals)} <span style="color:var(--faint)">${o.low.date.substring(0, 4)}</span>`,
        `${o.n} yrs`,
      ];
    });
    return rows.length ? kvTable(rows, ['Gauge', 'Typical', 'Highest', 'Lowest', 'Seen']) : '';
  };

  const gapInfo = r.meta.coverage;
  const gapYear = gapInfo ? parseInt(gapInfo.to.substring(0, 4)) : null;
  const coverageNotice = !gapInfo ? '' : `<div class="notice">
    <strong>These records do not include this spring.</strong>
    Every gauge is missing ${escDate(gapInfo.commonFrom)} to ${escDate(gapInfo.to)}${
      gapInfo.worstFrom !== gapInfo.commonFrom
        ? `, and most are missing back to ${escDate(gapInfo.worstFrom)}`
        : ''}.
    Environment Canada publishes its daily-mean series one calendar year at a
    time, well after that year ends, and this site only began keeping its own
    readings on ${escDate(addDays(gapInfo.to, 1))}. A high-water event inside that
    window would not appear below. Nothing can bridge it in the meantime: the
    realtime feed keeps 30 days, and the annual peak, annual statistic and
    monthly mean series all stop where the daily means do. The gap fills itself
    when ${gapYear} is published, expected around July ${gapYear + 1} — ${gapYear - 1}
    landed in a single step in July ${gapYear}.
  </div>`;

  const body = `
  ${coverageNotice}
  <div class="cards">
    ${card(`
      <h2>Highest in the published record</h2>
      <div class="big num">${fmtV(r.levels[0]?.peaks?.high.value ?? r.levels[0]?.extremes.high.value, 3)}<span class="unit">m</span></div>
      <div class="asof">${esc(r.levels[0]?.name ?? '')} &middot; ${escDate((r.levels[0]?.peaks?.high ?? r.levels[0]?.extremes.high)?.date ?? '')}`
      + `${r.levels[0]?.peaks ? ' &middot; instantaneous crest' : ' &middot; daily mean'}`
      + `${gapInfo ? ' &middot; excludes the gap above' : ''}</div>
      <p class="lede">${(() => {
        // Derive this rather than assert it: four gauges peaked in 2019 but
        // Port Carling's high is from 2013, and a hand-written sentence about
        // "every gauge" was simply wrong.
        const years = r.levels.map(g => g.extremes.high.date.substring(0, 4));
        const top = years[0];
        const same = years.filter(y => y === top).length;
        const odd = r.levels.filter(g => g.extremes.high.date.substring(0, 4) !== top);
        if (same === years.length) return `Every level gauge on this page peaked in ${top}.`;
        return `${same} of the ${years.length} level gauges peaked in ${top}. `
          + odd.map(g => `${esc(g.name)}'s high came in ${g.extremes.high.date.substring(0, 4)}`).join('; ') + '.';
      })()}</p>
    `)}
    ${card(`
      <h2>Warmest water on record</h2>
      <div class="big num">${fmtV(t.extremes.high.value, 1)}<span class="unit">°C</span></div>
      <div class="asof">${escDate(t.extremes.high.date)}</div>
      <p class="lede">Coldest was ${fmtV(t.extremes.low.value, 1)} °C on ${escDate(t.extremes.low.date)}, across ${t.years} years of satellite readings.</p>
    `)}
    ${t.swimStreak ? card(`
      <h2>Longest stretch above 20 °C</h2>
      <div class="big num">${t.swimStreak.length}<span class="unit">days</span></div>
      <div class="asof">${escDate(t.swimStreak.start)} to ${escDate(t.swimStreak.end)}</div>
      <p class="lede">The longest continuous run of swimmable water in the record.</p>
    `) : ''}
  </div>

  ${gaugeTable(r.levels, 'Water level records')}
  ${gaugeTable(r.flow, 'River flow records')}
  ${swingTable(r.levels, 'Biggest level swings')}
  ${swingTable(r.flow, 'Biggest flow swings')}

  <div class="section">
    <h2>Temperature records</h2>
    ${kvTable([
      ['Warmest reading', `${fmtV(t.extremes.high.value, 1)} °C`, escDate(t.extremes.high.date)],
      ['Coldest reading', `${fmtV(t.extremes.low.value, 1)} °C`, escDate(t.extremes.low.date)],
      ...t.warmestYears.slice(0, 3).map((y, i) => [`${ordinal(i + 1)} warmest year`, `${fmtV(y[1], 1)} °C`, String(y[0])]),
      ...t.coolestYears.slice(0, 3).map((y, i) => [`${ordinal(i + 1)} coolest year`, `${fmtV(y[1], 1)} °C`, String(y[0])]),
    ], ['', 'Value', 'When'])}
    <p class="lede">Yearly figures use only years with at least 350 readings, so a partial year cannot win on a short warm sample.</p>
  </div>

  <div class="section">
    <h2>On this date &middot; ${escDate(r.meta.generated)}</h2>
    ${t.onThisDate ? kvTable([[
      'Water temperature',
      `${fmtV(t.onThisDate.median, 1)} °C`,
      `${fmtV(t.onThisDate.high.value, 1)} <span style="color:var(--faint)">${t.onThisDate.high.date.substring(0, 4)}</span>`,
      `${fmtV(t.onThisDate.low.value, 1)} <span style="color:var(--faint)">${t.onThisDate.low.date.substring(0, 4)}</span>`,
      `${t.onThisDate.n} yrs`,
    ]], ['Series', 'Typical', 'Highest', 'Lowest', 'Seen']) : ''}
    ${onDate(r.levels)}
    ${onDate(r.flow)}
    <p class="lede">Every reading ever taken on this exact calendar date, not a pooled window.</p>
  </div>

  ${explain('Why these records are not equally impressive', `
    <p>Coverage is very uneven. Port Sydney's flow gauge has run since 1915, so its record low genuinely survived a century. Three other flow gauges only start in 2021, so their "records" describe about five years.</p>
    <p>Every row above carries its period of record for that reason. A record high off five years and one off a hundred are not the same claim, and nothing here averages them together.</p>
    <p>Most figures here are daily means published by Environment and Climate Change Canada, so a brief peak within a day is smoothed away. Where a crest column appears, that is the instantaneous annual maximum from Environment Canada's own peaks record — the number a flood is actually remembered by — and it is not comparable to a daily average. Temperatures are satellite surface readings, not a thermometer in the water.</p>
    <p><strong>The published series also lags.</strong> Environment Canada releases each station's daily means on its own schedule, often a year or more behind, and this site's own record only starts when it began caching readings. That leaves the window named at the top of this page with no data at all, so any peak inside it is absent from every figure here. Nothing on this page is wrong about the days it can see; it simply cannot see those days. The gap closes on its own as the daily means are published, because each run re-requests the last five years rather than only new dates. Publication happens a whole calendar year at a time rather than gradually, so the window will not narrow first — it will close all at once.</p>`)}`;

  return page({
    file: 'records.html', title: 'Muskoka Tracker — records',
    heading: 'Records',
    sub: `Extremes across every gauge, from ${escDate(r.flow.concat(r.levels).map(g => g.firstDate).sort()[0])} to today.`,
    body, script: '',
  });
}

function aboutPage(temp, levels, flow) {
  const omitted = flow.omitted.length
    ? `<p>${flow.omitted.map(o => `Gauge ${esc(o.id)} (${esc(o.name)}) is not shown: its most recent reading is from ${escDate(o.lastDate)}.`).join(' ')}</p>`
    : '';
  const body = `
  <div class="card">
    <h2>Where the numbers come from</h2>
    <p class="lede"><strong>Water level and river flow</strong> come from Environment and Climate Change Canada's MSC GeoMet API — the same public gauge network as the Water Office. Bala is station 02EB015. Readings are daily means, backfilled with sub-daily realtime values for days the daily-mean series has not published yet.</p>
    <p class="lede"><strong>Water temperature</strong> comes from NOAA's MUR SST v4.1 satellite analysis, sampled at ${'45.01'}° N, ${'79.6'}° W. It is a surface analysis of a 0.01° cell, not a thermometer in the water, and it lags real time by two to three days. Every temperature on this site is labelled with the date it was actually measured.</p>
  </div>

  <div class="card" style="margin-top:14px;">
    <h2>How often it updates</h2>
    <p class="lede">A scheduled job runs each morning at 7am Eastern: it fetches new readings, sends the daily email, and rebuilds these pages. If a source is unreachable that morning, the previous reading stays in place and the notices above say how old it is.</p>
  </div>

  <div class="card" style="margin-top:14px;">
    <h2>Reading the numbers</h2>
    <p class="lede"><strong>Percentiles</strong> describe where a reading sits in the record — "16th percentile" means 16% of comparable readings were lower. Neither warmer nor higher is treated as better, because for a lake neither is.</p>
    <p class="lede"><strong>Datums.</strong> Each level gauge is surveyed to its own reference. Raw levels are comparable only against that same gauge's history, never against another gauge. The comparison chart on the levels page normalises this away.</p>
    <p class="lede"><strong>Averages against July.</strong> "vs July avg" compares against the mean of every July day in the five years of daily means fetched for that station — a stable warm-season baseline, not a same-date comparison.</p>
    ${omitted}
  </div>

  <div class="card" style="margin-top:14px;">
    <h2>Coverage</h2>
    ${kvTable([
      ['Water temperature', `${escDate(temp.meta.firstDate)} – ${escDate(temp.meta.lastDate)}`, temp.meta.records.toLocaleString('en-CA')],
      ...levels.stations.map(s => [`Level · ${esc(s.name)}`, `${escDate(s.firstDate)} – ${escDate(s.lastDate)}`, String(s.n)]),
      ...flow.stations.map(s => [`Flow · ${esc(s.name)}`, `${escDate(s.firstDate)} – ${escDate(s.lastDate)}`, String(s.n)]),
    ], ['Series', 'Range', 'Readings'])}
  </div>`;

  return page({
    file: 'about.html', title: 'Muskoka Tracker — about the data',
    heading: 'About the data', sub: 'Sources, update cadence, and what the numbers mean.',
    body, script: '',
  });
}

// ── build ──

async function writeJSON(name, obj) {
  const text = JSON.stringify(obj);
  const kb = Buffer.byteLength(text) / 1024;
  await fs.writeFile(DOCS + 'data/' + name, text, 'utf8');
  const flag = kb > PAYLOAD_WARN_KB ? '  ⚠ over ' + PAYLOAD_WARN_KB + 'KB' : '';
  console.log(`  data/${name.padEnd(28)} ${kb.toFixed(1).padStart(7)} KB${flag}`);
  if (kb > PAYLOAD_WARN_KB) process.exitCode = 0; // warn, don't fail
  return kb;
}

async function main() {
  console.log('Building site from data/ (no network)...');

  const [temps, cache, peakRows] = await Promise.all([loadTemps(), loadLevelCache(), loadPeaks()]);
  const temp = buildTemperaturePayload(temps, CURRENT_YEAR, TODAY_ISO);
  const allYears = buildAllYearsPayload(temps, CURRENT_YEAR);
  const levels = buildLevelsPayload(cache, TODAY_ISO);
  const flow = buildFlowPayload(cache, TODAY_ISO);
  const overview = buildOverviewPayload(temp, levels, flow, TODAY_ISO);
  const records = buildRecordsPayload(temps, cache, TODAY_ISO, peakRows);

  console.log(`  ${temps.length} temperature readings, ${temp.meta.years} years`);
  console.log(`  ${levels.stations.length} level gauges, ${flow.stations.length} flow gauges` +
    (flow.omitted.length ? ` (${flow.omitted.length} omitted as stale)` : ''));

  await fs.mkdir(DOCS + 'data', { recursive: true });
  await fs.mkdir(DOCS + 'assets', { recursive: true });

  await writeJSON('overview.json', overview);
  await writeJSON('temperature.json', temp);
  await writeJSON('temperature-allyears.json', allYears);
  await writeJSON('levels.json', levels);
  await writeJSON('flow.json', flow);
  await writeJSON('records.json', records);

  const pages = {
    'index.html': indexPage(overview, temp),
    'temperature.html': temperaturePage(temp),
    'levels.html': stationPage({
      file: 'levels.html', title: 'Muskoka Tracker — water levels',
      heading: 'Water levels', sub: 'Five gauges around Lake Muskoka and Lake Rosseau.',
      payload: levels, comparison: true, measure: 'level',
      note: staleNotice(overview.level ? overview.level.ageDays : null, 'gauge', 2),
    }),
    'flow.html': stationPage({
      file: 'flow.html', title: 'Muskoka Tracker — river flow',
      heading: 'River flow', sub: 'Discharge on the Muskoka and Indian rivers.',
      payload: flow, comparison: true, measure: 'flow',
      note: flow.omitted.length ? `<div class="notice">${flow.omitted.map(g =>
        `Gauge ${esc(g.id)} (${esc(g.name)}) is not shown: it stopped reporting after ${escDate(g.lastDate)}.`).join(' ')}</div>` : '',
    }),
    'records.html': recordsPage(records),
    'about.html': aboutPage(temp, levels, flow),
  };

  for (const [name, html] of Object.entries(pages)) {
    await fs.writeFile(DOCS + name, html, 'utf8');
    console.log(`  ${name.padEnd(33)} ${(Buffer.byteLength(html) / 1024).toFixed(1).padStart(7)} KB`);
  }

  // Assets: stylesheet, renderer, and the vendored charting library. Vendored
  // rather than pulled from a CDN so the site works in networks and sandboxes
  // that block third-party origins, and cannot break when a CDN changes.
  await fs.copyFile(here + 'lib/site.css', DOCS + 'assets/site.css');
  await fs.copyFile(here + 'lib/app.js', DOCS + 'assets/app.js');
  await fs.copyFile(ROOT + 'node_modules/chart.js/dist/chart.umd.js', DOCS + 'assets/chart.umd.js');

  await fs.writeFile(DOCS + 'robots.txt', 'User-agent: *\nDisallow: /\n', 'utf8');
  await fs.writeFile(DOCS + '404.html', page({
    file: '', title: 'Muskoka Tracker — not found', heading: 'Not found',
    sub: 'That page does not exist.',
    body: '<div class="card"><p class="lede"><a href="index.html">Back to today’s conditions</a></p></div>',
    script: '',
  }), 'utf8');
  // Pages would otherwise run the output through Jekyll
  await fs.writeFile(DOCS + '.nojekyll', '', 'utf8');

  console.log('Done → docs/');
}

main().catch(err => {
  console.error("❌ Site build failed:", err.stack);
  process.exit(1);
});
