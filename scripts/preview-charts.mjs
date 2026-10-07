// Render the level / flow / spread charts straight from the cached observations
// in data/level-history.json and write them to scripts/out/ as PNGs.
//
// Useful because the live email path needs Environment Canada reachable (for the
// July average) and the NOAA mirrors reachable (for temperature) — this needs
// neither, so chart styling can be iterated on offline.
//
//   node scripts/preview-charts.mjs

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildWaterLevelChart, buildFlowChart, buildSpreadChart } from '../notify.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const OUT = here + 'out/';

const STATIONS = [
  { id: '02EB015', name: 'Bala', label: 'Lake Muskoka' },
  { id: '02EB018', name: 'Beaumaris', label: 'Lake Muskoka' },
  { id: '02EB020', name: 'Port Carling', label: 'Lake Rosseau' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB008', name: 'Baysville', label: 'S. Branch Muskoka R.' },
];

const FLOWS = [
  { id: '02EB013', name: 'Huntsville', label: 'Big East River' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB011', name: 'Moon River', label: 'Lake Muskoka outflow, Hwy 400' },
];

const cache = JSON.parse(await fs.readFile(here + '../data/level-history.json', 'utf8'));
const series = (key) =>
  Object.entries(cache[key] ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));

// The real July average comes from 5 years of daily means, which needs the EC
// API. Standing in the mean of the series' own July days keeps the reference
// line in a realistic spot for eyeballing.
function julyAverage(days) {
  const july = days.filter(d => d.date.substring(5, 7) === '07').map(d => d.value);
  if (july.length === 0) return null;
  return july.reduce((a, b) => a + b, 0) / july.length;
}

await fs.mkdir(OUT, { recursive: true });
const written = [];

for (const [i, st] of STATIONS.entries()) {
  const days = series(`level:${st.id}`);
  if (days.length === 0) continue;
  const avg = julyAverage(days);
  const chart = await buildWaterLevelChart(st.name, st.label, days, avg, i === 0, st.id);
  if (!chart) { console.log(`${st.name}: no data in window`); continue; }
  await fs.writeFile(OUT + `${chart.cid}.png`, chart.buffer);
  written.push([`${chart.cid}.png`, chart.buffer.length, `julyAvg=${avg?.toFixed(3) ?? 'null'}`]);
}

for (const [i, st] of FLOWS.entries()) {
  const days = series(`flow:${st.id}`);
  if (days.length === 0) continue;
  const chart = await buildFlowChart(st.name, st.label, days, i === 0, st.id);
  if (!chart) { console.log(`${st.name} flow: no data in window`); continue; }
  await fs.writeFile(OUT + `${chart.cid}.png`, chart.buffer);
  written.push([`${chart.cid}.png`, chart.buffer.length, '']);
}

const bala = series('level:02EB015');
const beau = series('level:02EB018');
const spread = await buildSpreadChart(bala, julyAverage(bala), beau, julyAverage(beau));
if (spread) {
  await fs.writeFile(OUT + 'spread.png', spread.buffer);
  written.push(['spread.png', spread.buffer.length, '']);
}

// A no-July-average station and a dead-flat series both have to render sanely.
const flat = Array.from({ length: 90 }, (_, i) => ({
  date: `2026-0${i < 31 ? '6' : i < 61 ? '7' : '8'}-${String((i % 30) + 1).padStart(2, '0')}`,
  value: 12.5,
}));
const flatChart = await buildWaterLevelChart('Edge Case', 'flat series, no July avg', flat, null, false, 'EDGE');
if (flatChart) {
  await fs.writeFile(OUT + 'edge-flat.png', flatChart.buffer);
  written.push(['edge-flat.png', flatChart.buffer.length, 'flat + julyAvg=null']);
}

const total = written.reduce((n, [, bytes]) => n + bytes, 0);
for (const [name, bytes, note] of written) {
  console.log(`  ${name.padEnd(22)} ${String(Math.round(bytes / 1024)).padStart(4)}KB  ${note}`);
}
console.log(`\n${written.length} charts, ${Math.round(total / 1024)}KB raw / ~${Math.round(total * 1.37 / 1024)}KB base64`);
console.log(`Written to ${OUT}`);
