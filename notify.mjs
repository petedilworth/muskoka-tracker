import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TEMP_CSV_PATH = __dirname + 'data/water-temp.csv';

/**
 * Muskoka Tracker — Daily Water Level Notification
 *
 * Fetches the latest water level from Environment Canada's OGC API
 * and water temperature from NOAA MUR SST satellite data,
 * compares levels to the 5-year July average, and sends a formatted
 * email via Resend.
 *
 * Data sources:
 *   MSC GeoMet OGC API (api.weather.gc.ca) — water levels and river flow
 *   NOAA MUR SST via ERDDAP mirrors, NCEI THREDDS fallback — water temperature
 * Station: 02EB015 — Bala Bay at Bala (Lake Muskoka)
 */

const STATION = '02EB015';
const API_BASE = 'https://api.weather.gc.ca/collections';

// Time windows derived at run time. "Today" is the calendar date at the lake,
// not UTC — a manual run after 8pm Eastern is otherwise dated tomorrow, which
// shifts every trailing window and inflates the staleness math by a day.
// (en-CA formats as YYYY-MM-DD.)
const TODAY_ISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const CURRENT_YEAR = parseInt(TODAY_ISO.substring(0, 4));
// Annual low-water search: from Jan 1 of the current year through today.
const LOW_WATER_START = `${CURRENT_YEAR}-01-01`;
const LOW_WATER_END = TODAY_ISO;
// Daily-mean history fetched per station (used for July average, low water,
// and chart backfill).
const HISTORY_START = `${CURRENT_YEAR - 5}-01-01`;
const HISTORY_END = TODAY_ISO;

// Additional stations to show current water levels
const EXTRA_STATIONS = [
  { id: '02EB018', name: 'Beaumaris', label: 'Lake Muskoka' },
  { id: '02EB020', name: 'Port Carling', label: 'Lake Rosseau' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB008', name: 'Baysville', label: 'S. Branch Muskoka R.' },
];

// Flow rate stations (discharge in m³/s) — WSC gauges on the rivers
const FLOW_STATIONS = [
  { id: '02EB006', name: 'Bala', label: 'Muskoka River' },
  { id: '02EB013', name: 'Bracebridge', label: 'Muskoka River' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB008', name: 'Baysville', label: 'S. Branch Muskoka R.' },
  { id: '02EB011', name: 'Port Carling', label: 'Indian River' },
];

// Bala Bay coordinates for satellite SST lookup
const BALA_LAT = 45.01;
const BALA_LON = -79.6;
// Confirmed 2026-07-14 from a residential IP: USF and the two PFEG servers all
// serve jplMURSST41 through the present. polarwatch (404) and spraydata (400)
// no longer host it and were dropped. USF first — it's a dedicated mirror and
// answers the quick metadata probe fastest.
const ERDDAP_MIRRORS = [
  'https://erddap.marine.usf.edu/erddap/griddap', // USF
  // PFEG origin servers: their blacklist covers GitHub runner IPs when active,
  // but they always work from residential IPs (--fetch-only)
  'https://coastwatch.pfeg.noaa.gov/erddap/griddap',
  'https://upwell.pfeg.noaa.gov/erddap/griddap',
];
// NCEI hosts the GHRSST MUR archive as one netCDF file per day with OPeNDAP
// subsetting — separate infrastructure from the blacklisted PFEG cluster.
// No range queries, so it's a fallback for single days and small gaps only.
const NCEI_THREDDS_BASE = 'https://www.ncei.noaa.gov/thredds-ocean';
const NCEI_MUR_PATH = 'ghrsst/L4/GLOB/JPL/MUR';
// MUR grid: lat -89.99..89.99, lon -179.99..179.99, both step 0.01
const MUR_LAT_IDX = Math.round((BALA_LAT + 89.99) / 0.01);  // 13500
const MUR_LON_IDX = Math.round((BALA_LON + 179.99) / 0.01); // 10039
const NCEI_MAX_GAP_DAYS = 90; // days filled per run, one at a time, when ERDDAP can't serve the range

// ── Tunable constants ──
const CM_PER_INCH = 2.54;
const CHART_DAYS = 90;  // trailing calendar-day window for level/flow charts
const ERDDAP_TIMEOUT_MS = 20000;          // quick metadata probe (time[(last)])
const ERDDAP_DATA_TIMEOUT_MS = 90000;     // range extraction — MUR point time-series is slow (one file/day server-side)
const ERDDAP_DEADLINE_MS = 6 * 60 * 1000; // total time budget for historical backfill
const BACKFILL_START = '2002-06-01';      // MUR SST v4.1 starts here — earliest available
const BACKFILL_CHUNK_DAYS = 45;           // small chunks so each extraction finishes inside the timeout
const BACKFILL_MAX_CHUNKS = 8;            // per run; cache catches up across daily runs
const OGC_TIMEOUT_MS = 15000;
const OUTLIER_THRESHOLD_M = 0.5;

// ── Configuration (from environment variables) ──
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
// Display name only matters locally: in CI the From line comes from the
// EMAIL_FROM secret, so renaming the sender there is a separate step.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Muskoka Tracker <onboarding@resend.dev>';

// ── Fetch helpers ──

async function fetchJSON(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(OGC_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

// Two stations appear in both the level and flow lists, and the realtime
// response carries LEVEL and DISCHARGE together — so the level and flow paths
// request the exact same URLs. Dedupe by first-page URL; a failed fetch is
// evicted so the second caller still gets its own retry.
const featureCache = new Map();

async function fetchAllFeatures(buildUrl, maxPages = 20) {
  const size = 500;
  const key = buildUrl(size, 0);
  if (!featureCache.has(key)) {
    const p = (async () => {
      let all = [];
      for (let page = 0; page < maxPages; page++) {
        const data = await fetchJSON(buildUrl(size, page * size));
        const feats = data.features || [];
        all = all.concat(feats);
        if (feats.length < size) break;
      }
      return all;
    })();
    featureCache.set(key, p);
    p.catch(() => featureCache.delete(key));
  }
  return featureCache.get(key);
}

// ── Parsers ──

function parseRealtime(features, field) {
  const dayMap = {};
  for (const f of features) {
    const p = f.properties || {};
    if (p[field] == null) continue;
    const d = (p.DATETIME || '').substring(0, 10);
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = [];
    dayMap[d].push(p[field]);
  }
  return Object.entries(dayMap)
    .map(([date, v]) => ({ date, value: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseDaily(features, field) {
  const results = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p[field] == null) continue;
    const date = (p.DATE || '').substring(0, 10);
    if (date) results.push({ date, value: p[field] });
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Outlier filter ──

// Judge each reading against the median of its 4 nearest neighbours. An
// earlier version compared against the mean of the two adjacent points, which
// had two failure modes: a single spike poisoned the average and took out its
// innocent neighbour with it, and the endpoints were exempt entirely — even
// though the newest reading becomes the headline number, the subject line, and
// a cache entry. The median of 4 shrugs off one bad value, and a genuine flood
// can't trip the threshold (2019 peaked near 0.1m/day against a 0.5m limit).
function filterOutliers(data) {
  if (data.length < 4) return data;
  const clean = [];
  for (let i = 0; i < data.length; i++) {
    const idx = [];
    for (let r = 1; idx.length < 4 && (i - r >= 0 || i + r < data.length); r++) {
      if (i - r >= 0) idx.push(i - r);
      if (i + r < data.length && idx.length < 4) idx.push(i + r);
    }
    const med = median(idx.map(j => data[j].value));
    if (Math.abs(data[i].value - med) > OUTLIER_THRESHOLD_M) {
      console.log(`  Outlier removed: ${data[i].date} = ${data[i].value}m (neighbour median ${med.toFixed(3)}m)`);
      continue;
    }
    clean.push(data[i]);
  }
  return clean;
}

// ── Water temperature (NOAA MUR SST satellite data) ──

async function fetchWaterTemp() {
  // MUR SST: 0.01° resolution global SST analysis, updated daily
  // Uses "(last)" to get most recent available data point — tries each mirror in order
  for (const mirror of ERDDAP_MIRRORS) {
    const { hostname } = new URL(mirror);
    const url = `${mirror}/jplMURSST41.json?analysed_sst[(last)][(${BALA_LAT})][(${BALA_LON})]`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS) });
      if (!resp.ok) {
        // resp.url is the final URL after redirects — ERDDAP mirrors of PFEG
        // datasets redirect data requests back to the origin server
        console.log(`  Water temp HTTP ${resp.status} from ${hostname} (final URL: ${resp.url})`);
        continue;
      }
      const data = await resp.json();
      const rows = data?.table?.rows;
      if (!rows || rows.length === 0) {
        console.log(`  Water temp: empty response from ${hostname}`);
        continue;
      }
      // Row format: [time, latitude, longitude, analysed_sst]
      const sst = rows[0][3];
      if (sst == null) {
        console.log(`  Water temp: null SST (land-masked?) from ${hostname}`);
        continue;
      }
      const time = rows[0][0];
      const date = time ? time.substring(0, 10) : null;
      if (date && date < addDays(TODAY_ISO, -10)) {
        console.log(`  Water temp from ${hostname} is stale (${date}) — trying next source`);
        continue;
      }
      return { tempC: Math.round(sst * 10) / 10, date };
    } catch (e) {
      console.log(`  Water temp fetch failed (${hostname}): ${e.message}`);
    }
  }

  // Fallback: NCEI THREDDS archive, probing backwards from the most recent
  // plausible day (MUR lags ~2 days; the NCEI archive a little more)
  console.log('  All ERDDAP mirrors failed — falling back to NCEI THREDDS...');
  for (let back = 2; back <= 8; back++) {
    const result = await fetchMurPointNCEI(addDays(TODAY_ISO, -back));
    if (result) return result;
  }
  return null;
}

// ── NCEI THREDDS fallback: per-day GHRSST MUR granules via OPeNDAP ──

function parseMurAscii(text) {
  // DAP2 .ascii grid output: the data line looks like "[0][13500], 288.123"
  const m = text.match(/^\[\d+\](?:\[\d+\])*,\s*(-?\d+(?:\.\d+)?)/m);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  // The granule stores analysed_sst as a packed short (scale 0.001, offset
  // 298.15 K); some TDS configs unpack to Kelvin or Celsius floats. Packed
  // shorts print as integers, floats with a decimal point. Range-check last
  // (also rejects the -32768 fill value).
  if (!m[1].includes('.')) v = v * 0.001 + 298.15 - 273.15;
  else if (v > 200 && v < 320) v = v - 273.15;
  if (v < -5 || v > 45) return null;
  return v;
}

async function fetchMurPointNCEI(dateStr) {
  const year = dateStr.substring(0, 4);
  const doy = String(toRecord(dateStr, 0).dayOfYear).padStart(3, '0');
  const dir = `${NCEI_MUR_PATH}/${year}/${doy}`;
  try {
    // Granule filenames vary across GDS versions — list the day's catalog
    // instead of guessing
    const catResp = await fetch(`${NCEI_THREDDS_BASE}/catalog/${dir}/catalog.xml`, {
      signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS),
    });
    if (!catResp.ok) {
      console.log(`  NCEI catalog HTTP ${catResp.status} for ${dateStr}`);
      return null;
    }
    const fileMatch = (await catResp.text()).match(/name="([^"]*MUR[^"]*\.nc)"/i);
    if (!fileMatch) {
      console.log(`  NCEI: no MUR granule listed for ${dateStr}`);
      return null;
    }
    const url = `${NCEI_THREDDS_BASE}/dodsC/${dir}/${fileMatch[1]}.ascii?analysed_sst[0][${MUR_LAT_IDX}][${MUR_LON_IDX}]`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS) });
    if (!resp.ok) {
      console.log(`  NCEI OPeNDAP HTTP ${resp.status} for ${dateStr}`);
      return null;
    }
    const tempC = parseMurAscii(await resp.text());
    if (tempC === null) {
      console.log(`  NCEI: could not parse SST for ${dateStr}`);
      return null;
    }
    console.log(`  NCEI THREDDS: ${dateStr} = ${tempC.toFixed(1)}°C`);
    return { tempC: Math.round(tempC * 10) / 10, date: dateStr };
  } catch (e) {
    console.log(`  NCEI fetch failed for ${dateStr}: ${e.message}`);
    return null;
  }
}

// ── Historical water temperature for spaghetti chart (MUR SST v4.1 starts 2002-06-01) ──

function toRecord(dateStr, tempC) {
  const year = parseInt(dateStr.substring(0, 4));
  const dt = new Date(dateStr + 'T00:00:00Z');
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((dt - jan1) / 86400000) + 1;
  return { date: dateStr, year, dayOfYear, tempC };
}

async function loadCachedTemp() {
  try {
    const csv = await fs.readFile(TEMP_CSV_PATH, 'utf8');
    const lines = csv.trim().split('\n').slice(1); // skip header
    const records = [];
    for (const line of lines) {
      const [date, temp] = line.split(',');
      const tempC = parseFloat(temp);
      if (date && !isNaN(tempC)) records.push(toRecord(date, tempC));
    }
    return records;
  } catch {
    return [];
  }
}

async function saveTempCache(records) {
  await fs.mkdir(__dirname + 'data', { recursive: true });
  // 3 decimals: the source data is packed shorts at 0.001°C, so anything past
  // that is float noise ("7.1129999999999995") bloating the CSV
  const rows = records.map(r => `${r.date},${Math.round(r.tempC * 1000) / 1000}`);
  await fs.writeFile(TEMP_CSV_PATH, 'date,tempC\n' + rows.join('\n') + '\n', 'utf8');
}

// ── Level/flow observation archive ──
//
// The realtime API keeps only ~1 month and the daily-mean series lags, so
// observations are archived in the repo. One append-only CSV per series, like
// water-temp.csv: a day's run adds a line or two, which git stores as a tiny
// delta. The previous design — every series in one JSON blob, trimmed to the
// newest 400 days — rewrote the whole file daily AND threw away most of what
// had already been fetched, since fetchStationData pulls years of daily means
// on every run.
//
// Nothing is capped now. HYDAT holds each gauge's full period of record, and
// the deep history is fetched once (see backfill below) rather than every run.

const ARCHIVE_DIR = __dirname + 'data/history/';
const ARCHIVE_MANIFEST = ARCHIVE_DIR + '_manifest.json';
const LEGACY_LEVEL_CACHE = __dirname + 'data/level-history.json';
// Earlier than any Canadian hydrometric record, so the API returns the
// station's true start rather than a window we guessed.
const ARCHIVE_FETCH_START = '1900-01-01';
// A full-record fetch is many paginated requests. Normal runs backfill at most
// this many series so the morning job stays inside its timeout; the rest catch
// up over following days. `--backfill` does them all at once.
const BACKFILL_SERIES_PER_RUN = 2;

const archiveKeyToFile = (key) => ARCHIVE_DIR + key.replace(':', '-') + '.csv';

export function mergeSeries(existing, fresh) {
  const m = new Map(existing.map(d => [d.date, d.value]));
  for (const d of fresh) {
    if (d && d.date && Number.isFinite(d.value)) m.set(d.date, Math.round(d.value * 10000) / 10000);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
}

function parseSeriesCsv(text) {
  return text.trim().split('\n').slice(1).map(line => {
    const [date, v] = line.split(',');
    return { date, value: parseFloat(v) };
  }).filter(d => d.date && Number.isFinite(d.value));
}

async function loadArchive(key) {
  try {
    return parseSeriesCsv(await fs.readFile(archiveKeyToFile(key), 'utf8'));
  } catch {
    // First run after the format change: seed from the old JSON blob so the
    // days already collected aren't lost before the backfill lands.
    try {
      const legacy = JSON.parse(await fs.readFile(LEGACY_LEVEL_CACHE, 'utf8'));
      const entry = legacy[key];
      if (!entry) return [];
      return Object.entries(entry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }));
    } catch {
      return [];
    }
  }
}

async function saveArchive(key, days) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const rows = days.map(d => `${d.date},${d.value}`);
  await fs.writeFile(archiveKeyToFile(key), 'date,value\n' + rows.join('\n') + '\n', 'utf8');
}

let manifestPromise = null;
function getManifest() {
  if (!manifestPromise) {
    manifestPromise = fs.readFile(ARCHIVE_MANIFEST, 'utf8').then(JSON.parse).catch(() => ({}));
  }
  return manifestPromise;
}

async function saveManifest() {
  const m = await getManifest();
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  await fs.writeFile(ARCHIVE_MANIFEST, JSON.stringify(m, null, 1), 'utf8');
}

// A full record can be many decades of dailies. Pages are 500 (the size the
// API has served reliably for this project); 400 of them is 200,000 rows, far
// past any station's record, so this bounds runaway paging without truncating.
const DEEP_FETCH_MAX_PAGES = 400;

// Fold fresh observations into a series' archive and persist it. `deep` marks
// the series as backfilled so the expensive full-record request happens once.
async function archiveMerge(key, fresh, deep) {
  const merged = mergeSeries(await loadArchive(key), fresh);
  await saveArchive(key, merged);
  if (deep && merged.length > 0) {
    const m = await getManifest();
    m[key] = { backfilled: true, firstDate: merged[0].date, lastDate: merged[merged.length - 1].date, n: merged.length };
  }
  return merged;
}

// How many series still need their one-time deep fetch, and whether this run
// is allowed to take another one.
let backfillTakenThisRun = 0;
async function claimBackfillSlot(key) {
  const m = await getManifest();
  if (m[key]?.backfilled) return false;
  if (process.argv.includes('--backfill')) return true;
  if (backfillTakenThisRun >= BACKFILL_SERIES_PER_RUN) return false;
  backfillTakenThisRun++;
  return true;
}

// Read every archived series at once — used by the site generator, which never
// touches the network.
// ── Annual instantaneous peaks ──
//
// The daily-mean series smooths a flood crest away: Bala's 2019 daily-mean high
// is 226.051 m, but the water rose above that within the day. The
// hydrometric-annual-peaks collection carries the instantaneous maximum and
// minimum per year, which is the number a flood is actually remembered by.
//
// Property names below come from a live probe of the collection, not from
// guesswork: DATE, DATA_TYPE_EN, PEAK_CODE_EN, UNITS_EN, SYMBOL_EN, PEAK.
// The *values* inside DATA_TYPE_EN and PEAK_CODE_EN have not been observed yet,
// so nothing here matches against a specific string it has not seen — the
// archive stores them verbatim and the site classifies loosely.

const ANNUAL_PEAKS_PATH = ARCHIVE_DIR + 'annual-peaks.csv';
const PEAK_COLUMNS = ['station', 'date', 'dataType', 'peakCode', 'units', 'value', 'symbol'];

const csvEscape = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

// Minimal RFC4180-ish split: these fields are free text from an API and can
// legitimately contain commas.
function csvSplit(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseAnnualPeakFeatures(features, stationId) {
  return (features || []).map(f => f.properties || {})
    .map(p => ({
      station: stationId,
      date: String(p.DATE ?? '').substring(0, 10),
      dataType: p.DATA_TYPE_EN ?? '',
      peakCode: p.PEAK_CODE_EN ?? '',
      units: p.UNITS_EN ?? '',
      value: Number(p.PEAK),
      symbol: p.SYMBOL_EN ?? '',
    }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
}

async function fetchAnnualPeaks(stationId) {
  try {
    const feats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-annual-peaks/items?f=json&STATION_NUMBER=${stationId}&limit=${lim}&offset=${off}`,
      20
    );
    return parseAnnualPeakFeatures(feats, stationId);
  } catch (e) {
    console.log(`    Annual peaks failed for ${stationId}: ${e.message}`);
    return [];
  }
}

export async function loadAnnualPeaks() {
  try {
    const text = await fs.readFile(ANNUAL_PEAKS_PATH, 'utf8');
    return text.trim().split('\n').slice(1).map(line => {
      const c = csvSplit(line);
      const row = {};
      PEAK_COLUMNS.forEach((k, i) => { row[k] = c[i] ?? ''; });
      row.value = Number(row.value);
      return row;
    }).filter(r => r.station && Number.isFinite(r.value));
  } catch {
    return [];
  }
}

async function saveAnnualPeaks(rows) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const sorted = [...rows].sort((a, b) =>
    a.station.localeCompare(b.station) || a.date.localeCompare(b.date) || a.peakCode.localeCompare(b.peakCode));
  const body = sorted.map(r => PEAK_COLUMNS.map(k => csvEscape(r[k])).join(','));
  await fs.writeFile(ANNUAL_PEAKS_PATH, PEAK_COLUMNS.join(',') + '\n' + body.join('\n') + '\n', 'utf8');
}

export async function loadAllArchives() {
  const out = {};
  let names = [];
  try {
    names = (await fs.readdir(ARCHIVE_DIR)).filter(n => n.endsWith('.csv'));
  } catch { /* no archive yet */ }
  for (const name of names) {
    const key = name.replace('.csv', '').replace('-', ':');
    out[key] = parseSeriesCsv(await fs.readFile(ARCHIVE_DIR + name, 'utf8'));
  }
  if (Object.keys(out).length > 0) return out;
  // Pre-migration fallback so the site still builds from the old blob.
  try {
    const legacy = JSON.parse(await fs.readFile(LEGACY_LEVEL_CACHE, 'utf8'));
    for (const [key, entry] of Object.entries(legacy)) {
      out[key] = Object.entries(entry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }));
    }
  } catch { /* nothing to fall back to */ }
  return out;
}

function parseERDDAPCsv(text) {
  const lines = text.split('\n');
  // Line 1: header, Line 2: units, Lines 3+: data
  const dataLines = lines.slice(2).filter(l => l.trim());
  const records = [];
  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const dateStr = parts[0].substring(0, 10);
    const sst = parseFloat(parts[3]);
    if (!isNaN(sst)) records.push(toRecord(dateStr, sst));
  }
  return records;
}

// A mirror can serve a stale copy whose time axis ends months in the past.
// ERDDAP hard-errors on any request extending past the axis end (it does not
// clamp), so probe each mirror's last available day once per run and clamp
// our requests to it. A failed probe returns null = extent unknown, still try.
const mirrorEndCache = new Map();
async function getMirrorEnd(mirror) {
  if (mirrorEndCache.has(mirror)) return mirrorEndCache.get(mirror);
  const { hostname } = new URL(mirror);
  let end = null;
  try {
    const resp = await fetch(`${mirror}/jplMURSST41.json?time[(last)]`, {
      signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS),
    });
    if (resp.ok) {
      const t = (await resp.json())?.table?.rows?.[0]?.[0];
      if (t) {
        end = t.substring(0, 10);
        console.log(`  ${hostname}: data ends ${end}`);
      }
    } else {
      console.log(`  ${hostname}: end probe HTTP ${resp.status}`);
    }
  } catch (e) {
    console.log(`  ${hostname}: end probe failed: ${e.message}`);
  }
  mirrorEndCache.set(mirror, end);
  return end;
}

// Mirrors that time out on a data request are skipped for the rest of the run
// so one slow server can't burn the whole budget across every chunk.
const timedOutMirrors = new Set();

// Fetch one date range from ERDDAP, trying CSV then JSON across all mirrors.
// A stale mirror is used for whatever part of the range it has — the caller
// advances by the dates actually returned. Returns records[] on success,
// null if every attempt failed or the deadline passed.
async function fetchTempChunk(startDate, endDate, deadlineAt) {
  for (const format of ['csv', 'json']) {
    for (const mirror of ERDDAP_MIRRORS) {
      if (Date.now() > deadlineAt) {
        console.log('  ERDDAP time budget exhausted');
        return null;
      }
      if (timedOutMirrors.has(mirror)) continue;
      const { hostname } = new URL(mirror);
      const mirrorEnd = await getMirrorEnd(mirror);
      if (mirrorEnd && mirrorEnd < startDate) continue; // stale copy — has nothing in range
      const effEnd = mirrorEnd && mirrorEnd < endDate ? mirrorEnd : endDate;
      const url = `${mirror}/jplMURSST41.${format}?analysed_sst[(${startDate}T09:00:00Z):(${effEnd}T09:00:00Z)][(${BALA_LAT})][(${BALA_LON})]`;
      console.log(`  Trying ERDDAP ${format.toUpperCase()}: ${startDate} to ${effEnd}${effEnd !== endDate ? ' (clamped to mirror end)' : ''} via ${hostname}...`);
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_DATA_TIMEOUT_MS) });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          console.log(`  ERDDAP HTTP ${resp.status} (final URL: ${resp.url}): ${errBody.substring(0, 200)}`);
          continue;
        }
        let records;
        if (format === 'csv') {
          records = parseERDDAPCsv(await resp.text());
        } else {
          const rows = (await resp.json())?.table?.rows || [];
          records = [];
          for (const row of rows) {
            const dateStr = row[0]?.substring(0, 10);
            const sst = row[3];
            if (dateStr && sst != null && !isNaN(sst)) {
              records.push(toRecord(dateStr, Math.round(sst * 10) / 10));
            }
          }
        }
        if (records.length > 0) {
          console.log(`  ERDDAP returned ${records.length} records via ${hostname}`);
          return records;
        }
        console.log(`  ERDDAP returned no records via ${hostname}`);
      } catch (e) {
        console.log(`  ERDDAP ${format.toUpperCase()} failed (${hostname}): ${e.message}`);
        if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
          timedOutMirrors.add(mirror);
          console.log(`  ${hostname} timed out — skipping it for the rest of this run`);
        }
      }
    }
  }
  return null;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

async function fetchHistoricalWaterTemp() {
  const cached = await loadCachedTemp();
  const latestCached = cached.length > 0 ? cached[cached.length - 1].date : null;

  // MUR SST data lags ~2 days behind real-time
  const endDate = addDays(TODAY_ISO, -3);

  // --fetch-only runs (seeding from an unblocked IP) get a much bigger budget.
  // Either way the run resumes from the cache next time, so a cutoff just means
  // "run it again to continue".
  const fetchOnly = process.argv.includes('--fetch-only');
  const maxChunks = fetchOnly ? 120 : BACKFILL_MAX_CHUNKS;
  const deadlineAt = Date.now() + (fetchOnly ? 8 : 1) * ERDDAP_DEADLINE_MS;

  const byDate = new Map(cached.map(r => [r.date, r]));
  let all = cached;
  let fetchedAny = false;
  let chunksUsed = 0;

  const save = async () => {
    all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    await saveTempCache(all);
    fetchedAny = true;
  };

  // 1. Tail: extend forward from the newest cached day (oldest chunk first)
  let startDate = latestCached ? addDays(latestCached, 1) : BACKFILL_START;
  while (startDate <= endDate && chunksUsed < maxChunks && Date.now() < deadlineAt) {
    let chunkEnd = addDays(startDate, BACKFILL_CHUNK_DAYS - 1);
    if (chunkEnd > endDate) chunkEnd = endDate;
    chunksUsed++;
    const records = await fetchTempChunk(startDate, chunkEnd, deadlineAt);
    if (!records) {
      // ERDDAP failed entirely — inch forward via NCEI, one day at a time,
      // starting at the gap's oldest day so the cache stays contiguous.
      // Guarantees recent years keep filling in even if ERDDAP is down for weeks.
      let nceiEnd = addDays(startDate, (fetchOnly ? 400 : NCEI_MAX_GAP_DAYS) - 1);
      if (nceiEnd > endDate) nceiEnd = endDate;
      console.log(`  ERDDAP down — filling ${startDate}..${nceiEnd} from NCEI THREDDS...`);
      for (let d = startDate; d <= nceiEnd && Date.now() < deadlineAt; d = addDays(d, 1)) {
        const point = await fetchMurPointNCEI(d);
        if (!point) break; // stop at the first hole to stay contiguous
        byDate.set(point.date, toRecord(point.date, point.tempC));
        await new Promise(r => setTimeout(r, 100));
      }
      if (byDate.size > cached.length) await save();
      break; // stop so the cache never develops interior gaps
    }
    for (const r of records) byDate.set(r.date, r);
    await save();
    // A stale mirror may return less than the requested range — advance by
    // what actually arrived so the remainder is retried (or handed to NCEI)
    const lastFetched = records.reduce((m, r) => (r.date > m ? r.date : m), records[0].date);
    if (lastFetched < startDate) break; // no forward progress
    startDate = addDays(lastFetched, 1);
  }

  // 2. Head: extend backward from the oldest cached day toward BACKFILL_START,
  //    newest chunk first so the cached block always stays contiguous. Only
  //    runs once the tail is fully caught up — recent years matter more than
  //    old ones, and a flaky tail chunk must not divert the budget backwards.
  const tailComplete = startDate > endDate;
  let earliest = all.length > 0 ? all[0].date : null;
  while (tailComplete && earliest && earliest > BACKFILL_START && chunksUsed < maxChunks && Date.now() < deadlineAt) {
    const chunkEnd = addDays(earliest, -1);
    let chunkStart = addDays(chunkEnd, -(BACKFILL_CHUNK_DAYS - 1));
    if (chunkStart < BACKFILL_START) chunkStart = BACKFILL_START;
    chunksUsed++;
    const records = await fetchTempChunk(chunkStart, chunkEnd, deadlineAt);
    if (!records) break;
    for (const r of records) byDate.set(r.date, r);
    await save();
    earliest = chunkStart;
  }

  if (!fetchedAny) {
    if (cached.length > 0) {
      console.log(`  Historical temp: cache is current (${cached.length} records)`);
      return cached;
    }
    console.log('  All ERDDAP attempts failed');
    return null;
  }

  console.log(`  Historical temp: ${all.length} records across ${new Set(all.map(r => r.year)).size} years`);
  return all;
}

// ── Build water temperature spaghetti chart (year-over-year overlay) ──

async function buildTempSpaghettiChart(records, waterTemp) {
  if (!records || records.length === 0) return null;

  const byYear = {};
  for (const r of records) {
    if (!byYear[r.year]) byYear[r.year] = [];
    byYear[r.year].push(r);
  }

  const years = Object.keys(byYear).map(Number).sort();
  const currentYear = CURRENT_YEAR;
  const prevYear = currentYear - 1;

  const datasets = years.map(year => {
    const sorted = byYear[year].sort((a, b) => a.dayOfYear - b.dayOfYear);
    // Insert a null point at holes > 5 days so the line breaks (spanGaps is
    // off) instead of drawing a misleading straight jump across the gap
    const data = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].dayOfYear - sorted[i - 1].dayOfYear > 5) {
        data.push({ x: sorted[i - 1].dayOfYear + 1, y: null });
      }
      data.push({ x: sorted[i].dayOfYear, y: sorted[i].tempC });
    }

    let color, width, order;
    if (year === currentYear) {
      color = '#2D6A9F';
      width = 2.5;
      order = 0;
    } else if (year === prevYear) {
      color = '#C0392B';
      width = 2;
      order = 1;
    } else {
      color = 'rgba(150, 150, 150, 0.55)';
      width = 1;
      order = 2;
    }

    return {
      label: String(year),
      data,
      borderColor: color,
      borderWidth: width,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      spanGaps: false,
      order,
    };
  });

  // Highlight the actual "today" reading — the current-year line's own
  // endpoint isn't reliably readable as "today" once 20+ years overlap it
  if (waterTemp) {
    datasets.push({
      label: 'Today',
      data: [{ x: toRecord(waterTemp.date, 0).dayOfYear, y: waterTemp.tempC }],
      showLine: false,
      pointRadius: 5,
      pointBackgroundColor: '#2D6A9F',
      pointBorderColor: '#FFFFFF',
      pointBorderWidth: 1.5,
      order: -1,
    });
  }

  // Sort so current year renders on top (lowest order = drawn last = on top)
  datasets.sort((a, b) => b.order - a.order);

  const monthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const config = {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: false,
      animation: false,
      showLine: true,
      scales: {
        x: {
          type: 'linear',
          min: 1,
          max: 366,
          // Chart.js has no "tick values" option for linear axes — replace the
          // auto-generated ticks so one lands on the 1st of every month
          afterBuildTicks: (axis) => {
            axis.ticks = monthStarts.map(value => ({ value }));
          },
          ticks: {
            callback: (val) => {
              const idx = monthStarts.indexOf(val);
              return idx >= 0 ? monthLabels[idx] : '';
            },
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
            autoSkip: false,
            maxRotation: 0,
          },
          grid: { color: '#F0EDE8' },
        },
        y: {
          title: {
            display: true,
            text: '°C',
            font: { size: 11, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          ticks: {
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          grid: { color: '#F0EDE8' },
        },
      },
      plugins: {
        title: {
          display: true,
          text: 'Water Temperature — Bala Bay · Year over Year',
          font: { size: 13, weight: '600', family: 'sans-serif' },
          color: '#0B1D33',
          padding: { bottom: 8 },
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
      layout: {
        padding: { left: 4, right: 12, top: 4, bottom: 4 },
      },
    },
  };

  const buffer = await getCanvas(560, 280).renderToBuffer(config);
  console.log(`  Spaghetti chart: ${buffer.length} bytes PNG`);
  return buffer;
}

// ── Historical temperature stats (this-day-of-year vs all other years) ──

// All readings from years other than `excludeYear` within a circular
// ±windowDays of `targetDay` (wraps across the Dec/Jan boundary).
function poolAroundDay(records, targetDay, windowDays, excludeYear) {
  const days = new Set();
  for (let d = -windowDays; d <= windowDays; d++) {
    days.add(((targetDay - 1 + d + 366) % 366) + 1);
  }
  return records.filter(r => r.year !== excludeYear && days.has(r.dayOfYear));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Today's max/min/median for this time of year, plus today's rank among
// all years on record (1 = warmest). Windowed ±3 days to smooth out single
// noisy satellite readings while staying "this time of year".
function computeTodayTempStats(records, todayDate, todayTempC) {
  const todayRecord = toRecord(todayDate, todayTempC);
  const pool = poolAroundDay(records, todayRecord.dayOfYear, 3, CURRENT_YEAR);
  if (pool.length === 0) return null;

  const temps = pool.map(r => r.tempC);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const med = median(temps);

  // Per-year average within the window, for a fair "Nth warmest of M years" rank
  const byYear = new Map();
  for (const r of pool) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r.tempC);
  }
  const yearAverages = [...byYear.values()].map(vals => vals.reduce((a, b) => a + b, 0) / vals.length);
  const rank = 1 + yearAverages.filter(v => v > todayTempC).length;
  const poolYears = [...byYear.keys()];

  return {
    min, max, median: med, rank,
    totalYears: yearAverages.length + 1,
    windowStart: addDays(todayDate, -3),
    windowEnd: addDays(todayDate, 3),
    earliestYear: Math.min(...poolYears),
    latestYear: Math.max(...poolYears),
  };
}

// Median expected change in water temperature over the next 7 days, based on
// what happened historically between this day-of-year and 7 days later.
// Compares ±2-day pooled averages (anchor vs anchor+7) per year, then takes
// the median delta across all years on record.
function computeNextWeekTempForecast(records, todayDate, todayTempC) {
  const todayRecord = toRecord(todayDate, todayTempC);
  const futureDayOfYear = ((todayRecord.dayOfYear - 1 + 7) % 366) + 1;

  const anchorPool = poolAroundDay(records, todayRecord.dayOfYear, 2, CURRENT_YEAR);
  const futurePool = poolAroundDay(records, futureDayOfYear, 2, CURRENT_YEAR);
  if (anchorPool.length === 0 || futurePool.length === 0) return null;

  // Per-year average for each window, then per-year delta (future - anchor).
  const avgByYear = (pool) => {
    const byYear = new Map();
    for (const r of pool) {
      if (!byYear.has(r.year)) byYear.set(r.year, []);
      byYear.get(r.year).push(r.tempC);
    }
    const out = new Map();
    for (const [year, vals] of byYear) out.set(year, vals.reduce((a, b) => a + b, 0) / vals.length);
    return out;
  };
  const anchorByYear = avgByYear(anchorPool);
  const futureByYear = avgByYear(futurePool);

  const deltas = [];
  for (const [year, anchorAvg] of anchorByYear) {
    if (futureByYear.has(year)) deltas.push(futureByYear.get(year) - anchorAvg);
  }
  if (deltas.length === 0) return null;

  const expectedChange = median(deltas);
  const direction = expectedChange > 0.15 ? 'warm' : expectedChange < -0.15 ? 'cool' : 'hold steady';

  return {
    expectedChange,             // °C, signed
    direction,                  // 'warm' | 'cool' | 'hold steady'
    yearsUsed: deltas.length,
    futureDate: addDays(todayDate, 7),
  };
}

// ── Build water temperature YTD anomaly chart (actual vs historical median) ──

async function buildTempAnomalyChart(records) {
  if (!records || records.length === 0) return null;

  const currentYearByDay = new Map(
    records.filter(r => r.year === CURRENT_YEAR).map(r => [r.dayOfYear, r.tempC])
  );
  if (currentYearByDay.size === 0) return null;

  // Bound the chart to the last day of data actually present — the cache is
  // always at least a few days behind real "today" (satellite processing
  // lag), so using real today here would reserve blank trailing space.
  const lastDataDay = Math.max(...currentYearByDay.keys());

  // Bucket every non-current-year reading by its own day-of-year once, then
  // union ±3 buckets per target day instead of re-filtering ~6800 rows per day.
  const buckets = new Map();
  for (const r of records) {
    if (r.year === CURRENT_YEAR) continue;
    if (!buckets.has(r.dayOfYear)) buckets.set(r.dayOfYear, []);
    buckets.get(r.dayOfYear).push(r.tempC);
  }
  const windowedMedian = (targetDay) => {
    const temps = [];
    for (let d = -3; d <= 3; d++) {
      const day = ((targetDay - 1 + d + 366) % 366) + 1;
      const bucket = buckets.get(day);
      if (bucket) temps.push(...bucket);
    }
    return median(temps);
  };

  const data = [];
  for (let day = 1; day <= lastDataDay; day++) {
    const actual = currentYearByDay.get(day);
    const baseline = windowedMedian(day);
    data.push({ x: day, y: (actual !== undefined && baseline !== null) ? actual - baseline : null });
  }

  const allMonthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const allMonthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabelByStart = new Map(allMonthStarts.map((v, i) => [v, allMonthLabels[i]]));
  const monthStarts = allMonthStarts.filter(m => m <= lastDataDay);

  const config = {
    type: 'bar',
    data: {
      datasets: [{
        label: 'Anomaly',
        data,
        backgroundColor: data.map(d => d.y === null ? 'transparent' : (d.y >= 0 ? '#E07B4C' : '#2D6A9F')),
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          min: 1,
          max: Math.max(lastDataDay, 1),
          afterBuildTicks: (axis) => {
            axis.ticks = monthStarts.map(value => ({ value }));
          },
          ticks: {
            callback: (val) => monthLabelByStart.get(val) ?? '',
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
            autoSkip: false,
            maxRotation: 0,
          },
          grid: { color: '#F0EDE8' },
        },
        y: {
          title: {
            display: true,
            text: '°C vs median',
            font: { size: 11, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          ticks: {
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          grid: { color: '#F0EDE8' },
        },
      },
      plugins: {
        title: {
          display: true,
          text: 'Water Temperature — Bala Bay · Daily Anomaly vs Historical Median (YTD)',
          font: { size: 13, weight: '600', family: 'sans-serif' },
          color: '#0B1D33',
          padding: { bottom: 8 },
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
      layout: {
        padding: { left: 4, right: 12, top: 4, bottom: 4 },
      },
    },
  };

  const buffer = await getCanvas(560, 280).renderToBuffer(config);
  console.log(`  Anomaly chart: ${buffer.length} bytes PNG`);
  return buffer;
}

// ── Shared chart helpers ──

// Trailing calendar window: data from the last n days, not the last n rows
// (daily-mean history can lag months, leaving holes before the realtime data)
function lastCalendarDays(days, n) {
  const cutoff = addDays(TODAY_ISO, -(n - 1));
  return days.filter(d => d.date >= cutoff);
}

// "Trailing 90 days" is a request, not a description of what came back. When
// the published daily means lag by months and realtime covers only the last few
// weeks, the window filter returns those few weeks — and labelling that
// "trailing 90 days" tells the reader something untrue about the chart they are
// looking at. Describe the window that actually got plotted.
function windowLabel(chartDays) {
  const span = daysBetween(chartDays[chartDays.length - 1].date, chartDays[0].date) + 1;
  const n = chartDays.length;
  const dense = n >= span - 3;
  if (span >= CHART_DAYS - 3 && dense) return `trailing ${CHART_DAYS} days`;
  if (dense) return `trailing ${span} days — all that is published`;
  return `trailing ${span} days, ${n} with data`;
}

function daysBetween(laterDate, earlierDate) {
  return Math.round(
    (new Date(laterDate + 'T12:00:00Z') - new Date(earlierDate + 'T12:00:00Z')) / 86400000
  );
}

// The reading closest to n days before the series' newest date. Indexing by row
// (days[len - 1 - n]) silently means something else whenever the series has
// interior holes — and it does: an API outage left a 158-day gap in the cache,
// so "7 rows back" can be months back. Returns null when nothing lands within
// `tolerance` days of the target, so callers omit the metric instead of
// reporting a bogus one.
function readingNDaysBack(days, n, tolerance = 3) {
  if (!days || days.length === 0) return null;
  const target = addDays(days[days.length - 1].date, -n);
  let best = null;
  let bestDiff = Infinity;
  for (const d of days) {
    const diff = Math.abs(daysBetween(d.date, target));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return bestDiff <= tolerance ? best : null;
}

function fmtShort(d) {
  return new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

// ── Level / flow / spread charts (Chart.js PNG, same pipeline as the temp charts) ──
//
// These were hand-built <table> bar charts positioned with negative CSS margins.
// That approach had no y-axis at all, and the reference lines were placed with
// `margin-top:-Npx; margin-bottom:(N-1)px`, so each line displaced the ones
// after it and inflated the container by its own offset. Rendering to PNG gets
// real axes, correct gridlines, and no layout arithmetic.

const CHART_PNG_W = 560;
const CHART_PNG_H = 175;

const canvasCache = new Map();
function getCanvas(width, height) {
  const key = `${width}x${height}`;
  if (!canvasCache.has(key)) {
    canvasCache.set(key, new ChartJSNodeCanvas({ width, height, backgroundColour: '#FFFFFF' }));
  }
  return canvasCache.get(key);
}

const AXIS_FONT = { size: 10, family: 'sans-serif' };
const GRID = '#F0EDE8';
const INK = '#0B1D33';
const MUTED = '#6B6B6B';

// Shared scale/plugin block. `yFmt` formats tick values; `title`/`subtitle`
// render inside the PNG so the caption travels with the image.
function chartFrame(title, subtitle, yLabel, yFmt, xLabels) {
  return {
    responsive: false,
    animation: false,
    scales: {
      x: {
        ticks: {
          callback(i) { return xLabels[i] ?? ''; },
          font: AXIS_FONT, color: MUTED,
          maxRotation: 0, autoSkip: true, maxTicksLimit: 6,
        },
        grid: { display: false },
      },
      y: {
        title: { display: !!yLabel, text: yLabel, font: { size: 10, family: 'sans-serif' }, color: MUTED },
        ticks: { callback: yFmt, font: AXIS_FONT, color: MUTED, maxTicksLimit: 5 },
        grid: { color: GRID },
      },
    },
    plugins: {
      title: {
        display: true, text: title,
        font: { size: 12, weight: '600', family: 'sans-serif' },
        color: INK, padding: { bottom: 2 },
      },
      subtitle: {
        display: !!subtitle, text: subtitle,
        font: { size: 10, family: 'sans-serif' },
        color: MUTED, padding: { bottom: 6 },
      },
      legend: { display: false },
      tooltip: { enabled: false },
    },
    // Right padding keeps the "latest" marker off the frame edge.
    layout: { padding: { left: 4, right: 18, top: 2, bottom: 2 } },
  };
}

// Pad a data range so the series never sits flat against the frame. A dead-flat
// series (range 0) still needs a window or Chart.js picks an arbitrary one.
function paddedBounds(values, extra = [], padFrac = 0.18, floor = 0.02) {
  const all = [...values, ...extra.filter(v => v !== null && v !== undefined && isFinite(v))];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = Math.max((hi - lo) * padFrac, floor);
  return { min: lo - pad, max: hi + pad };
}

// One chart section: PNG plus the <img> that references it by CID.
function chartSection(cid, buffer, isFirst, altText) {
  const style = isFirst
    ? 'margin-top:12px;'
    : 'margin-top:18px;border-top:1px solid #E0DAD2;padding-top:14px;';
  return {
    buffer,
    cid,
    html: `
      <div style="${style}">
        <img src="cid:${cid}" alt="${altText}" style="width:100%;max-width:${CHART_PNG_W}px;height:auto;border-radius:8px;border:1px solid #E0DAD2;display:block;" />
      </div>`,
  };
}

async function buildWaterLevelChart(name, label, days, stJulyAvg, isFirst, stationId) {
  if (!days || days.length === 0) return null;
  const chartDays = lastCalendarDays(days, CHART_DAYS);
  if (chartDays.length === 0) return null;

  const latest = chartDays[chartDays.length - 1];
  const values = chartDays.map(d => d.value);
  const xLabels = chartDays.map(fmtShort);

  const vsJulyStr = stJulyAvg !== null
    ? `${((latest.value - stJulyAvg) * 100 / CM_PER_INCH) >= 0 ? '+' : ''}${((latest.value - stJulyAvg) * 100 / CM_PER_INCH).toFixed(1)} in vs July avg`
    : 'July average unavailable';

  // Scale to the observed water only. The old chart folded the record high into
  // these bounds, which stretched the axis ~4x and flattened the actual season
  // into a sliver at the bottom.
  const { min, max } = paddedBounds(values, [stJulyAvg]);

  const datasets = [{
    data: values,
    borderColor: '#2D6A9F',
    backgroundColor: 'rgba(74, 155, 217, 0.18)',
    borderWidth: 2,
    fill: 'start',
    tension: 0.25,
    pointRadius: chartDays.map((_, i) => (i === chartDays.length - 1 ? 4 : 0)),
    pointBackgroundColor: '#E07B4C',
    pointBorderColor: '#FFFFFF',
    pointBorderWidth: 1.5,
    order: 0,
  }];

  if (stJulyAvg !== null) {
    datasets.push({
      data: values.map(() => stJulyAvg),
      borderColor: '#5BA88A',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
      order: 1,
    });
  }

  const decimals = (max - min) < 0.5 ? 3 : 2;
  const opts = chartFrame(
    `${name} — ${label}`,
    `Water level, ${windowLabel(chartDays)} · ${vsJulyStr}`,
    'metres',
    (v) => Number(v).toFixed(decimals),
    xLabels
  );
  // suggested* rather than hard bounds so Chart.js still picks round tick values
  opts.scales.y.suggestedMin = min;
  opts.scales.y.suggestedMax = max;

  const buffer = await getCanvas(CHART_PNG_W, CHART_PNG_H).renderToBuffer({
    type: 'line',
    data: { labels: xLabels.map((_, i) => i), datasets },
    options: opts,
  });

  const section = chartSection(`level-${stationId}`, buffer, isFirst, `${name} water level, ${windowLabel(chartDays)}`);
  const legend = stJulyAvg !== null
    ? `<div style="margin-top:4px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:16px;border-top:2px solid #2D6A9F;vertical-align:middle;margin-right:4px;"></span>Daily level
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#E07B4C;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>Latest (${fmtShort(latest)})
          <span style="display:inline-block;width:16px;border-top:1.5px dashed #5BA88A;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>July avg
        </div>`
    : '';
  section.html = section.html.replace('</div>', `${legend}\n      </div>`);
  return section;
}

async function buildSpreadChart(balaDays, balaJulyAvg, beauDays, beauJulyAvg) {
  if (!balaDays || !beauDays || balaJulyAvg === null || beauJulyAvg === null) return null;

  const balaByDate = new Map(balaDays.map(d => [d.date, d.value]));
  const spreadDays = [];
  for (const d of beauDays) {
    const balaVal = balaByDate.get(d.date);
    if (balaVal === undefined) continue;
    const spreadIn = ((d.value - beauJulyAvg) - (balaVal - balaJulyAvg)) * 100 / CM_PER_INCH;
    spreadDays.push({ date: d.date, spread: spreadIn });
  }
  if (spreadDays.length === 0) return null;

  const chartDays = lastCalendarDays(spreadDays, CHART_DAYS);
  if (chartDays.length === 0) return null;
  const latestSpread = chartDays[chartDays.length - 1].spread;
  const values = chartDays.map(d => d.spread);
  const xLabels = chartDays.map(fmtShort);
  const { min, max } = paddedBounds(values, [0], 0.18, 0.25);

  const opts = chartFrame(
    'Beaumaris vs Bala — Water Level Spread',
    `${windowLabel(chartDays)[0].toUpperCase()}${windowLabel(chartDays).slice(1)} · now ${latestSpread >= 0 ? '+' : ''}${latestSpread.toFixed(1)} in · normalized to each station's July average`,
    'inches',
    (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1),
    xLabels
  );
  opts.scales.y.suggestedMin = min;
  opts.scales.y.suggestedMax = max;
  opts.scales.y.grid = { color: (ctx) => (ctx.tick.value === 0 ? '#999' : GRID) };

  const buffer = await getCanvas(CHART_PNG_W, CHART_PNG_H).renderToBuffer({
    type: 'bar',
    data: {
      labels: xLabels.map((_, i) => i),
      datasets: [{
        data: values,
        backgroundColor: values.map(v => (v >= 0 ? '#4A9BD9' : '#E07B4C')),
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      }],
    },
    options: opts,
  });

  const section = chartSection('spread', buffer, false, 'Beaumaris vs Bala water level spread');
  section.html = section.html.replace('</div>', `
        <div style="margin-top:4px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:8px;height:8px;background:#4A9BD9;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Beaumaris above Bala
          <span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:10px;margin-right:3px;"></span>Bala above Beaumaris
        </div>
      </div>`);
  return section;
}

async function buildFlowChart(name, label, days, isFirst, stationId) {
  if (!days || days.length === 0) return null;
  const chartDays = lastCalendarDays(days, CHART_DAYS);
  if (chartDays.length === 0) return null;

  const latest = chartDays[chartDays.length - 1];
  const values = chartDays.map(d => d.value);
  const xLabels = chartDays.map(fmtShort);
  // Flow is a magnitude, so anchor the axis at zero unless that would flatten
  // the series into a thin band at the top.
  const peak = Math.max(...values);
  const trough = Math.min(...values);
  const zeroAnchored = trough <= peak * 0.55;
  const { min, max } = zeroAnchored
    ? { min: 0, max: peak * 1.12 }
    : paddedBounds(values, [], 0.18, 0.1);

  const flowDecimals = max >= 10 ? 0 : 1;
  const opts = chartFrame(
    `${name} — ${label}`,
    `River flow, ${windowLabel(chartDays)} · ${latest.value.toFixed(1)} m³/s on ${fmtShort(latest)}`,
    'm³/s',
    (v) => Number(v).toFixed(flowDecimals),
    xLabels
  );
  if (zeroAnchored) opts.scales.y.min = 0; // keep the fill anchored to a true zero
  else opts.scales.y.suggestedMin = min;
  opts.scales.y.suggestedMax = max;

  const buffer = await getCanvas(CHART_PNG_W, CHART_PNG_H).renderToBuffer({
    type: 'line',
    data: {
      labels: xLabels.map((_, i) => i),
      datasets: [{
        data: values,
        borderColor: '#4C7A99',
        backgroundColor: 'rgba(107, 142, 173, 0.22)',
        borderWidth: 2,
        fill: 'start',
        tension: 0.25,
        pointRadius: chartDays.map((_, i) => (i === chartDays.length - 1 ? 4 : 0)),
        pointBackgroundColor: '#E07B4C',
        pointBorderColor: '#FFFFFF',
        pointBorderWidth: 1.5,
      }],
    },
    options: opts,
  });

  return chartSection(`flow-${stationId}`, buffer, isFirst, `${name} river flow, ${windowLabel(chartDays)}`);
}

function txtRow(name, label, recentDays, stJulyAvg, lowWater) {
  if (!recentDays || recentDays.length === 0) return null;
  const lat = recentDays[recentDays.length - 1];
  const aboveLow = lowWater ? ((lat.value - lowWater.value) * 100 / CM_PER_INCH).toFixed(1) : '?';
  const belowSum = stJulyAvg !== null ? ((lat.value - stJulyAvg) * 100 / CM_PER_INCH).toFixed(1) : '?';
  return `  ${name} (${label}): ${lat.value.toFixed(3)}m | ↑low:${aboveLow}in | ↓summer:${belowSum}in`;
}


// ── Fetch all data for a station: realtime + 5-year daily-mean history, then
//    derive July avg, low water, and a combined daily series used for the
//    chart, day-change metrics, and the CSV attachment. ──

async function fetchStationData(stationId) {
  const result = {
    realtimeDaily: [],
    history: [],
    recentDays: null,
    julyAvg: null,
    lowWater: null,
  };

  // 1. Realtime data (recent ~30 days of sub-daily readings, averaged to daily)
  try {
    const rtFeats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${stationId}&limit=${lim}&offset=${off}`,
      20
    );
    result.realtimeDaily = filterOutliers(parseRealtime(rtFeats, 'LEVEL'));
  } catch (e) {
    console.log(`    Realtime failed: ${e.message}`);
  }

  // 2. Daily-mean history — the authoritative daily values, lagging realtime by
  //    a few days (realtime fills the tail below). Once per series we ask for
  //    the whole period of record; after that a 5-year window is plenty, since
  //    everything older is already archived.
  const key = `level:${stationId}`;
  result.deepFetch = await claimBackfillSlot(key);
  const from = result.deepFetch ? ARCHIVE_FETCH_START : HISTORY_START;
  try {
    const feats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${stationId}&datetime=${from}/${HISTORY_END}&limit=${lim}&offset=${off}`,
      result.deepFetch ? DEEP_FETCH_MAX_PAGES : 20
    );
    result.history = parseDaily(feats, 'LEVEL');
    if (result.deepFetch) {
      console.log(`    full record: ${result.history.length} daily means` +
        (result.history.length ? ` from ${result.history[0].date}` : ''));
    }
  } catch (e) {
    console.log(`    Daily-mean history failed: ${e.message}`);
    result.deepFetch = false;
  }

  // 3. Combine history + realtime (realtime fills dates daily-mean hasn't
  //    published yet), then fold into the on-disk archive.
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  const combined = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));
  result.recentDays = await archiveMerge(key, combined, result.deepFetch);

  // 4. July average — deliberately the last 5 Julys, not every July in the
  //    archive. The email and site both call this "the five-year July average";
  //    now that the archive can run to decades, averaging all of it would
  //    silently redefine every "vs July avg" number on both surfaces.
  const julyVals = result.recentDays
    .filter(d => d.date >= HISTORY_START && d.date.substring(5, 7) === '07')
    .map(d => d.value);
  if (julyVals.length > 0) {
    result.julyAvg = julyVals.reduce((a, b) => a + b, 0) / julyVals.length;
  }

  // 5. Low water — minimum value within the Jan 1 → today window, using the
  //    combined history + realtime series for maximum date coverage.
  const lowWindow = result.recentDays.filter(
    d => d.date >= LOW_WATER_START && d.date <= LOW_WATER_END
  );
  if (lowWindow.length > 0) {
    result.lowWater = lowWindow.reduce((min, d) => (d.value < min.value ? d : min), lowWindow[0]);
  }

  return result;
}

// ── Fetch discharge (flow) data for a station ──

async function fetchFlowData(stationId) {
  const result = { realtimeDaily: [], history: [], recentDays: null };

  // Realtime discharge (recent ~30 days of sub-daily readings, averaged to daily)
  try {
    const rtFeats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${stationId}&limit=${lim}&offset=${off}`,
      20
    );
    const withDischarge = rtFeats.filter(f => f.properties?.DISCHARGE != null).length;
    console.log(`    realtime: ${rtFeats.length} features, ${withDischarge} with DISCHARGE`);
    result.realtimeDaily = parseRealtime(rtFeats, 'DISCHARGE');
  } catch (e) {
    console.log(`    Realtime flow failed: ${e.message}`);
  }

  // Daily-mean discharge history. Same one-time deep fetch as levels: the
  // rating curve can lag months, and HYDAT holds the gauge's whole record.
  const key = `flow:${stationId}`;
  result.deepFetch = await claimBackfillSlot(key);
  const from = result.deepFetch ? ARCHIVE_FETCH_START : HISTORY_START;
  try {
    const feats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${stationId}&datetime=${from}/${HISTORY_END}&limit=${lim}&offset=${off}`,
      result.deepFetch ? DEEP_FETCH_MAX_PAGES : 20
    );
    const withDischarge = feats.filter(f => f.properties?.DISCHARGE != null).length;
    console.log(`    daily-mean: ${feats.length} features, ${withDischarge} with DISCHARGE`);
    result.history = parseDaily(feats, 'DISCHARGE');
    if (result.deepFetch) {
      console.log(`    full record: ${result.history.length} daily means` +
        (result.history.length ? ` from ${result.history[0].date}` : ''));
    }
  } catch (e) {
    console.log(`    Daily-mean flow failed: ${e.message}`);
    result.deepFetch = false;
  }

  // Combine: history + realtime fill for dates history hasn't published yet,
  // then merge with the on-disk cache of past observations
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  const combined = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));
  result.recentDays = await archiveMerge(key, combined, result.deepFetch);

  return result;
}

// ── Main ──

async function main() {
  console.log('🌊 Muskoka Tracker — Daily Water Level Notification');
  console.log('──────────────────────────────────────────');

  // Fetch-only mode: update the water temperature cache and exit (no email,
  // no secrets needed). Useful for seeding data/water-temp.csv from a machine
  // whose IP isn't blocked by the ERDDAP servers.
  if (process.argv.includes('--fetch-only')) {
    console.log('Fetch-only mode: updating water temperature cache...');
    const records = await fetchHistoricalWaterTemp();
    console.log(records ? `Done: ${records.length} records in ${TEMP_CSV_PATH}` : 'No records fetched.');
    return;
  }

  // Dry-run mode: build the email and write it to disk instead of sending, so
  // template changes can be previewed locally without secrets (or a live send).
  const dryRun = process.argv.includes('--dry-run');

  // Validate config
  if (!dryRun) {
    if (!RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY');
    if (EMAIL_TO.length === 0) throw new Error('Missing EMAIL_TO');
  }

  // 1. Fetch Bala station data (realtime + 5-year daily-mean history).
  console.log(`Fetching Bala station data (${STATION})...`);
  const balaData = await fetchStationData(STATION);
  const recentData = balaData.recentDays || [];
  console.log(`  ${balaData.realtimeDaily.length} realtime days, ${balaData.history.length} daily-mean days, ${recentData.length} combined`);

  if (recentData.length === 0) {
    throw new Error('No water level data available for Bala');
  }

  const latest = recentData[recentData.length - 1];
  console.log(`  Latest: ${latest.date} = ${latest.value.toFixed(3)}m`);

  // 2. Compute trend (7-day change if available)
  let trend = null;
  let trendIn = null;
  let trendArrow = '';
  const weekAgo = readingNDaysBack(recentData, 7);
  if (weekAgo) {
    trend = (latest.value - weekAgo.value) * 100; // in cm
    trendIn = trend / CM_PER_INCH; // in inches
    trendArrow = trend > 0.5 ? '↗ rising' : trend < -0.5 ? '↘ falling' : '→ stable';
    console.log(`  7-day trend: ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)}in (${trendArrow}) — ${weekAgo.date} → ${latest.date}`);
  } else {
    console.log('  7-day trend: no reading near 7 days back — skipping');
  }

  // 3. July average (computed from 5-year history inside fetchStationData)
  let julyAvg = balaData.julyAvg;
  let deltaCm = null;
  let deltaSign = '';
  let deltaNote = '';

  if (julyAvg !== null) {
    deltaCm = (latest.value - julyAvg) * 100;
    deltaSign = deltaCm >= 0 ? '+' : '';
    deltaNote = deltaCm > 10 ? 'Above normal summer level'
      : deltaCm < -10 ? 'Below normal summer level'
      : deltaCm > 0 ? 'Slightly above normal'
      : deltaCm < 0 ? 'Slightly below normal'
      : 'At normal summer level';
    console.log(`  July avg: ${julyAvg.toFixed(3)}m | Delta: ${deltaSign}${deltaCm.toFixed(1)}cm`);
  }

  // Convert delta and values to inches relative to July average
  const deltaIn = deltaCm !== null ? deltaCm / CM_PER_INCH : null;

  // 4. Fetch water temperature: current + historical for spaghetti chart
  console.log('Fetching water temperature (current + historical)...');
  let [waterTemp, historicalTempRecords] = await Promise.all([
    fetchWaterTemp(),
    fetchHistoricalWaterTemp(),
  ]);

  // The live sources share infrastructure that periodically blacklists GitHub
  // runner IPs, but the on-disk history usually holds a reading only a few
  // days old. Without this fallback an outage silently drops the temperature
  // headline, the ranking line, the 7-day forecast, and the chart's today
  // marker — everything downstream labels the reading by its date, so a
  // slightly older one degrades gracefully.
  if (!waterTemp && historicalTempRecords && historicalTempRecords.length > 0) {
    const newest = historicalTempRecords[historicalTempRecords.length - 1];
    if (newest.date >= addDays(TODAY_ISO, -10)) {
      waterTemp = { tempC: Math.round(newest.tempC * 10) / 10, date: newest.date };
      console.log(`  Live temp sources failed — using cached reading ${newest.date} = ${waterTemp.tempC}°C`);
    }
  }
  const tempF = waterTemp ? Math.round(waterTemp.tempC * 9 / 5 + 32) : null;
  const tempYears = historicalTempRecords ? [...new Set(historicalTempRecords.map(r => r.year))] : [];
  const tempGreyYears = tempYears.filter(y => y <= CURRENT_YEAR - 2);
  const tempMinYear = tempGreyYears.length > 0 ? Math.min(...tempGreyYears) : null;
  const tempMaxGreyYear = tempGreyYears.length > 0 ? Math.max(...tempGreyYears) : null;
  if (waterTemp) {
    console.log(`  Water temp: ${waterTemp.tempC}°C (${tempF}°F) — ${waterTemp.date}`);
  } else {
    console.log('  Water temperature unavailable');
  }

  let todayTempStats = null;
  let nextWeekTempForecast = null;
  if (waterTemp && historicalTempRecords && historicalTempRecords.length > 0) {
    todayTempStats = computeTodayTempStats(historicalTempRecords, waterTemp.date, waterTemp.tempC);
    if (todayTempStats) {
      console.log(`  This time of year: ${todayTempStats.min.toFixed(1)}–${todayTempStats.max.toFixed(1)}°C (median ${todayTempStats.median.toFixed(1)}°C), today ranks ${ordinal(todayTempStats.rank)} warmest of ${todayTempStats.totalYears}`);
    }
    nextWeekTempForecast = computeNextWeekTempForecast(historicalTempRecords, waterTemp.date, waterTemp.tempC);
    if (nextWeekTempForecast) {
      const changeStr = nextWeekTempForecast.direction !== 'hold steady' ? ` ~${Math.abs(nextWeekTempForecast.expectedChange).toFixed(1)}°C` : '';
      console.log(`  Next 7 days: median temp expected to ${nextWeekTempForecast.direction}${changeStr} (${nextWeekTempForecast.yearsUsed}-yr pattern)`);
    }
  }

  // 5. Bala's low water (from combined history + realtime, Jan 1 → today)
  const balaLowWater = balaData.lowWater;
  if (balaLowWater) console.log(`  Bala low water: ${balaLowWater.date} = ${balaLowWater.value.toFixed(3)}m`);

  // 6. Fetch extra station data (same fetchStationData, parallel).
  console.log('Fetching extra station data...');

  const extraResults = await Promise.all(
    EXTRA_STATIONS.map(async (st) => {
      console.log(`  Fetching ${st.name} (${st.id})...`);
      const data = await fetchStationData(st.id);
      if (data.recentDays) {
        const lat = data.recentDays[data.recentDays.length - 1];
        console.log(`    level=${lat.value.toFixed(3)}m, julyAvg=${data.julyAvg?.toFixed(3) ?? 'N/A'}, lowWater=${data.lowWater ? data.lowWater.date + '=' + data.lowWater.value.toFixed(3) + 'm' : 'N/A'}`);
      } else {
        console.log(`    no data`);
      }
      return {
        ...st,
        recentDays: data.recentDays,
        history: data.history,
        realtimeDaily: data.realtimeDaily,
        julyAvg: data.julyAvg,
        lowWater: data.lowWater,
      };
    })
  );

  // 7. Fetch flow rate data for river stations (parallel).
  console.log('Fetching flow rate data...');

  const flowResults = await Promise.all(
    FLOW_STATIONS.map(async (st) => {
      console.log(`  Fetching flow ${st.name} (${st.id})...`);
      const data = await fetchFlowData(st.id);
      if (data.recentDays && data.recentDays.length > 0) {
        const lat = data.recentDays[data.recentDays.length - 1];
        console.log(`    flow=${lat.value.toFixed(1)} m³/s (${data.recentDays.length} days)`);
      } else {
        console.log(`    no discharge data`);
      }
      return { ...st, recentDays: data.recentDays };
    })
  );

  // A gauge can go dormant and leave only old readings in the cache (02EB006
  // stopped reporting in 2021). Its chart is empty either way, but the text
  // body used to print that last cached row as the current flow — drop stale
  // gauges once, here, so HTML and text agree on which ones exist.
  const freshFlowResults = flowResults.filter(s => {
    const fresh = s.recentDays ? lastCalendarDays(s.recentDays, CHART_DAYS) : [];
    if (fresh.length > 0) return true;
    const last = s.recentDays?.length ? s.recentDays[s.recentDays.length - 1].date : 'never';
    console.log(`    ${s.name} (${s.id}) flow omitted — no reading in last ${CHART_DAYS} days (latest: ${last})`);
    return false;
  });

  // All station/flow fetches are done — persist the observation cache so the
  // workflow's data-commit step picks it up
  // Annual instantaneous peaks: one small request per station, annual data, so
  // this is cheap next to everything above.
  const peakStations = [...new Set([STATION, ...EXTRA_STATIONS.map(s => s.id), ...FLOW_STATIONS.map(s => s.id)])];
  const peakRows = [];
  for (const id of peakStations) peakRows.push(...await fetchAnnualPeaks(id));
  if (peakRows.length > 0) {
    await saveAnnualPeaks(peakRows);
    const types = [...new Set(peakRows.map(r => r.dataType))];
    const codes = [...new Set(peakRows.map(r => r.peakCode))];
    console.log(`  Annual peaks: ${peakRows.length} rows across ${peakStations.length} stations`);
    console.log(`    DATA_TYPE_EN values: ${types.join(' | ')}`);
    console.log(`    PEAK_CODE_EN values: ${codes.join(' | ')}`);
  } else {
    console.log('  Annual peaks: none returned; keeping any existing archive');
  }

  await saveManifest();
  console.log('  Level/flow archive saved');

  // 8. Dump diagnostic CSV with all computed values
  {
    const csvRows = ['Station,Body of Water,Latest Date,Level (m),July Avg (m),Low Water Date,Low Water Level (m),Above Low (in),Below Summer (in),1d Chg (in),2d Chg (in),3d Chg (in)'];
    function csvRow(name, label, days, stJulyAvg, lowWater) {
      if (!days || days.length === 0) return;
      const lat = days[days.length - 1];
      const level = lat.value;
      const aboveLow = lowWater ? ((level - lowWater.value) * 100 / CM_PER_INCH).toFixed(2) : '';
      const belowSum = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / CM_PER_INCH).toFixed(2) : '';
      const chg = (n) => {
        const prev = readingNDaysBack(days, n, 1);
        return prev ? ((level - prev.value) * 100 / CM_PER_INCH).toFixed(2) : '';
      };
      csvRows.push([name, label, lat.date, level.toFixed(4), stJulyAvg?.toFixed(4) ?? '', lowWater?.date ?? '', lowWater?.value.toFixed(4) ?? '', aboveLow, belowSum, chg(1), chg(2), chg(3)].join(','));
    }
    csvRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater);
    for (const s of extraResults) csvRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater);
    console.log('\n── Diagnostic CSV ──');
    for (const row of csvRows) console.log(row);
    console.log('── End CSV ──\n');
  }

  // 6b. Build temperature spaghetti chart (PNG)
  let tempChartBuffer = null;
  try {
    if (historicalTempRecords && historicalTempRecords.length > 0) {
      tempChartBuffer = await buildTempSpaghettiChart(historicalTempRecords, waterTemp);
    }
  } catch (e) {
    console.log(`  Spaghetti chart generation failed: ${e.message}`);
  }

  // 6c. Build temperature YTD anomaly chart (PNG)
  let tempAnomalyChartBuffer = null;
  try {
    if (historicalTempRecords && historicalTempRecords.length > 0) {
      tempAnomalyChartBuffer = await buildTempAnomalyChart(historicalTempRecords);
    }
  } catch (e) {
    console.log(`  Anomaly chart generation failed: ${e.message}`);
  }

  // 7. Build and send email
  console.log('Sending email...');

  const dateStr = new Date(latest.date + 'T12:00:00').toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  // Every headline number is derived from `latest`, so if the gauge feed stalls
  // the email keeps looking current while quietly reporting old water. Say so.
  const levelAgeDays = daysBetween(TODAY_ISO, latest.date);
  const staleLevelNote = levelAgeDays > 2
    ? `Latest gauge reading is ${levelAgeDays} days old — Environment Canada's feed may be lagging.`
    : null;
  if (staleLevelNote) console.log(`  ⚠ ${staleLevelNote}`);

  // Build water level charts (HTML)
  const waterLevelChartInputs = [
    { name: 'Bala', label: 'Lake Muskoka', days: recentData, julyAvg, stationId: STATION, isFirst: true },
    ...extraResults
      .filter(s => s.recentDays && s.recentDays.length > 0)
      .map(s => ({ name: s.name, label: s.label, days: s.recentDays, julyAvg: s.julyAvg, stationId: s.id, isFirst: false })),
  ];
  const waterLevelCharts = [];
  for (const input of waterLevelChartInputs) {
    try {
      const result = await buildWaterLevelChart(input.name, input.label, input.days, input.julyAvg, input.isFirst, input.stationId);
      if (result) waterLevelCharts.push(result);
    } catch (e) {
      console.log(`  Chart for ${input.name} failed: ${e.message}`);
    }
  }

  // Flow charts (PNG) — built here so their buffers can be attached alongside
  const flowCharts = [];
  for (const [i, s] of freshFlowResults.entries()) {
    try {
      const result = await buildFlowChart(s.name, s.label, s.recentDays, i === 0, s.id);
      if (result) flowCharts.push(result);
    } catch (e) {
      console.log(`  Flow chart for ${s.name} failed: ${e.message}`);
    }
  }

  // Build Beaumaris–Bala spread chart
  let spreadChart = null;
  try {
    const beaumaris = extraResults.find(s => s.id === '02EB018');
    if (beaumaris && beaumaris.recentDays) {
      spreadChart = await buildSpreadChart(recentData, julyAvg, beaumaris.recentDays, beaumaris.julyAvg);
    }
  } catch (e) {
    console.log(`  Spread chart failed: ${e.message}`);
  }

  const deltaColor = deltaCm > 10 ? '#E07B4C'
    : deltaCm < -10 ? '#2D6A9F'
    : '#5BA88A';

  // Build area water levels table
  const areaTableHtml = (() => {
    const td = 'padding:3px 4px;font-size:10px;color:#0B1D33;border-bottom:1px solid #F0EDE8;white-space:nowrap;';
    const th = 'padding:3px 4px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:#6B6B6B;border-bottom:2px solid #E0DAD2;white-space:nowrap;';
    const tdr = td + 'text-align:right;';
    const thr = th + 'text-align:right;';

    function buildRow(name, label, days, stJulyAvg, lowWater, isBala, stationId) {
      if (!days || days.length === 0) return '';
      const lat = days[days.length - 1];
      const level = lat.value;

      const belowSummer = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / CM_PER_INCH) : null;
      const belowSummerStr = belowSummer !== null ? (belowSummer >= 0 ? '+' : '') + belowSummer.toFixed(1) : '\u2014';

      function dayChange(n) {
        const prev = readingNDaysBack(days, n, 1);
        if (!prev) return '\u2014';
        const chg = (level - prev.value) * 100 / CM_PER_INCH;
        return (chg >= 0 ? '+' : '') + chg.toFixed(1);
      }

      const bold = isBala ? 'font-weight:600;' : '';
      return '<tr>'
        + '<td style="' + td + bold + '">' + name + '</td>'
        + '<td style="' + td + 'font-size:9px;color:#6B6B6B;">' + label + '</td>'
        + '<td style="' + tdr + '">' + level.toFixed(3) + '</td>'
        + '<td style="' + tdr + '">' + belowSummerStr + '</td>'
        + '<td style="' + tdr + '">' + dayChange(1) + '</td>'
        + '<td style="' + tdr + '">' + dayChange(2) + '</td>'
        + '<td style="' + tdr + '">' + dayChange(3) + '</td>'
        + '</tr>';
    }

    const balaRow = buildRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater, true, STATION);
    const extraRows = extraResults.filter(s => s.recentDays).map(s =>
      buildRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater, false, s.id)
    ).join('');

    return '<div style="margin-bottom:16px;overflow-x:auto;">'
      + '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:8px;">Area Water Levels</div>'
      + '<table style="width:100%;border-collapse:collapse;">'
      + '<tr>'
      + '<th style="' + th + '">Stn</th>'
      + '<th style="' + th + '">Water</th>'
      + '<th style="' + thr + '">Lvl (m)</th>'
      + '<th style="' + thr + '">vs Sum</th>'
      + '<th style="' + thr + '">1d</th>'
      + '<th style="' + thr + '">2d</th>'
      + '<th style="' + thr + '">3d</th>'
      + '</tr>'
      + balaRow
      + extraRows
      + '</table></div>';
  })();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F0EB;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="margin-bottom:20px;">
      <h1 style="margin:0;font-size:20px;color:#0B1D33;">🌊 Muskoka Tracker</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#6B6B6B;">${dateStr}</p>
      ${staleLevelNote ? `<p style="margin:6px 0 0;font-size:11px;color:#C0392B;">⚠ ${staleLevelNote}</p>` : ''}
    </div>

    <!-- Main card -->
    <div style="background:#fff;border:1px solid #E0DAD2;border-radius:12px;padding:20px;margin-bottom:16px;">

      <!-- Current level -->
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Current Level vs July Avg</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${deltaSign}${deltaIn?.toFixed(1) ?? '?'}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">in</span></div>
      </div>

      ${waterTemp ? `
      <!-- Water Temperature -->
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Water Temperature — ${fmtShort({ date: waterTemp.date })}</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${waterTemp.tempC.toFixed(1)}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">°C</span> <span style="font-size:16px;font-weight:400;color:#6B6B6B;">(${tempF}°F)</span></div>
        ${todayTempStats ? `
        <div style="font-size:12px;color:#6B6B6B;margin-top:4px;">
          ${fmtShort({ date: todayTempStats.windowStart })}–${fmtShort({ date: todayTempStats.windowEnd })} historically: ${todayTempStats.min.toFixed(1)}–${todayTempStats.max.toFixed(1)}°C (median ${todayTempStats.median.toFixed(1)}°C) across ${todayTempStats.earliestYear}–${todayTempStats.latestYear} · ranks <strong style="color:#0B1D33;">${ordinal(todayTempStats.rank)} warmest</strong> of ${todayTempStats.totalYears} years on record${nextWeekTempForecast ? ` · median temp expected to <strong style="color:#0B1D33;">${nextWeekTempForecast.direction}</strong>${nextWeekTempForecast.direction !== 'hold steady' ? ` ~${Math.abs(nextWeekTempForecast.expectedChange).toFixed(1)}°C` : ''} over the next 7 days (${nextWeekTempForecast.yearsUsed}-yr pattern)` : ''}
        </div>
        ` : ''}
      </div>
      ` : ''}

      ${tempChartBuffer ? `
      <!-- Water Temperature Spaghetti Chart (CID inline image — Gmail strips data: URIs) -->
      <div style="margin-bottom:16px;">
        <img src="cid:temp-chart" alt="Water temperature year-over-year chart" style="width:100%;max-width:560px;height:auto;border-radius:8px;border:1px solid #E0DAD2;display:block;" />
        <div style="margin-top:6px;font-size:9px;color:#999;">
          ${waterTemp ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2D6A9F;vertical-align:middle;margin-right:4px;"></span>Today (${fmtShort({ date: waterTemp.date })})` : ''}
          <span style="display:inline-block;width:16px;border-top:2.5px solid #2D6A9F;vertical-align:middle;margin-left:${waterTemp ? '10px' : '0'};margin-right:4px;"></span>${CURRENT_YEAR} YTD
          <span style="display:inline-block;width:16px;border-top:2px solid #C0392B;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>${CURRENT_YEAR - 1}
          ${tempMinYear !== null && tempMinYear <= CURRENT_YEAR - 2 ? `<span style="display:inline-block;width:16px;border-top:1px solid rgba(150,150,150,0.7);vertical-align:middle;margin-left:10px;margin-right:4px;"></span>${tempMinYear < tempMaxGreyYear ? `${tempMinYear}\u2013${tempMaxGreyYear}` : tempMaxGreyYear}` : ''}
        </div>
        <div style="font-size:8px;color:#BBB;margin-top:2px;">Source: NOAA MUR SST v4.1</div>
      </div>
      ` : ''}

      ${tempAnomalyChartBuffer ? `
      <!-- Water Temperature YTD Anomaly Chart (CID inline image) -->
      <div style="margin-bottom:16px;">
        <img src="cid:temp-anomaly-chart" alt="Water temperature daily anomaly vs historical median, year to date" style="width:100%;max-width:560px;height:auto;border-radius:8px;border:1px solid #E0DAD2;display:block;" />
        <div style="margin-top:6px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:16px;height:8px;background:#E07B4C;vertical-align:middle;margin-right:4px;"></span>warmer than usual
          <span style="display:inline-block;width:16px;height:8px;background:#2D6A9F;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>cooler than usual
        </div>
      </div>
      ` : ''}

      ${trend !== null ? `
      <!-- Trend -->
      <div style="font-size:13px;color:#6B6B6B;margin-bottom:16px;">
        <strong>7-day trend:</strong> ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)} in ${trendArrow}
      </div>
      ` : ''}

      <!-- Area Water Levels -->
      ${areaTableHtml}

      <!-- Water Level Charts: Bala + extra stations -->
      ${waterLevelCharts.map(c => c.html).join('')}

      <!-- Beaumaris–Bala Spread Chart -->
      ${spreadChart ? spreadChart.html : ''}

      <!-- Flow Rate Charts -->
      ${flowCharts.length > 0 ? `
      <div style="margin-top:24px;border-top:2px solid #E0DAD2;padding-top:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">River Flow Rates</div>
        ${flowCharts.map(c => c.html).join('')}
      </div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div style="text-align:center;font-size:11px;color:#6B6B6B;line-height:1.5;">
      Station 02EB015 · Lake Muskoka, Ontario<br>
      Data: Environment Canada, MSC Open Data${waterTemp ? ' · NOAA MUR SST' : ''}
    </div>
  </div>
</body>
</html>`;

  const balaText = txtRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater);
  const extraText = extraResults.filter(s => s.recentDays).map(s =>
    txtRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater)
  ).filter(Boolean).join('\n');
  const flowText = freshFlowResults
    .map(s => {
      const fresh = lastCalendarDays(s.recentDays, CHART_DAYS);
      const lat = fresh[fresh.length - 1];
      return `  ${s.name} (${s.label}): ${lat.value.toFixed(1)} m³/s (${fmtShort(lat)})`;
    }).join('\n');
  const text = [
    `🌊 Muskoka Water Levels — ${dateStr}`,
    staleLevelNote ? `⚠ ${staleLevelNote}` : '',
    ``,
    `Current: ${deltaSign}${deltaIn?.toFixed(1) ?? '?'} in vs July avg`,
    waterTemp ? `Water temp (${fmtShort({ date: waterTemp.date })}): ${waterTemp.tempC.toFixed(1)}°C (${tempF}°F)` : '',
    todayTempStats ? `  ${fmtShort({ date: todayTempStats.windowStart })}-${fmtShort({ date: todayTempStats.windowEnd })} historically: ${todayTempStats.min.toFixed(1)}-${todayTempStats.max.toFixed(1)}°C (median ${todayTempStats.median.toFixed(1)}°C) across ${todayTempStats.earliestYear}-${todayTempStats.latestYear} — ranks ${ordinal(todayTempStats.rank)} warmest of ${todayTempStats.totalYears} years on record${nextWeekTempForecast ? ` — median temp expected to ${nextWeekTempForecast.direction}${nextWeekTempForecast.direction !== 'hold steady' ? ` ~${Math.abs(nextWeekTempForecast.expectedChange).toFixed(1)}°C` : ''} over next 7 days (${nextWeekTempForecast.yearsUsed}-yr pattern)` : ''}` : '',
    julyAvg !== null ? `${deltaNote}` : '',
    trend !== null ? `7-day trend: ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)} in ${trendArrow}` : '',
    ``,
    `Area Water Levels:`,
    balaText,
    extraText,
    flowText ? `\nRiver Flow Rates:\n${flowText}` : '',
    ``,
    `Station 02EB015 · Lake Muskoka · Environment Canada${waterTemp ? ' · NOAA MUR SST' : ''}`,
  ].filter(Boolean).join('\n');

  // Send via Resend
  const attachments = [];
  if (tempChartBuffer) {
    attachments.push({
      filename: 'water-temp-chart.png',
      content: tempChartBuffer.toString('base64'),
      content_id: 'temp-chart',
    });
  }
  if (tempAnomalyChartBuffer) {
    attachments.push({
      filename: 'water-temp-anomaly-chart.png',
      content: tempAnomalyChartBuffer.toString('base64'),
      content_id: 'temp-anomaly-chart',
    });
  }
  for (const c of [...waterLevelCharts, ...(spreadChart ? [spreadChart] : []), ...flowCharts]) {
    attachments.push({
      filename: `${c.cid}.png`,
      content: c.buffer.toString('base64'),
      content_id: c.cid,
    });
  }
  console.log(`  ${attachments.length} chart attachments, ${Math.round(attachments.reduce((n, a) => n + a.content.length, 0) / 1024)}KB base64 total`);

  if (dryRun) {
    // Inline every CID attachment as a data: URI so the preview renders standalone
    let previewHtml = html;
    for (const a of attachments) {
      previewHtml = previewHtml.replaceAll(`cid:${a.content_id}`, `data:image/png;base64,${a.content}`);
    }
    await fs.writeFile(__dirname + 'preview.html', previewHtml, 'utf8');
    await fs.writeFile(__dirname + 'preview.txt', text, 'utf8');
    console.log('📄 Dry run — no email sent.');
    console.log(`   Wrote preview.html (${previewHtml.length} bytes) and preview.txt`);
    console.log(`   Charts: spaghetti=${tempChartBuffer ? 'yes' : 'no'}, anomaly=${tempAnomalyChartBuffer ? 'yes' : 'no'}`);
    return;
  }

  const emailResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `🌊 Muskoka: ${deltaSign}${deltaIn?.toFixed(1) ?? '?'} in vs July avg${waterTemp ? ` · ${waterTemp.tempC.toFixed(1)}°C` : ''}`,
      html: html,
      text: text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  });

  if (!emailResp.ok) {
    const err = await emailResp.text();
    throw new Error(`Resend API error: ${emailResp.status} — ${err}`);
  }

  const result = await emailResp.json();
  console.log(`✅ Email sent! ID: ${result.id}`);
  console.log(`   To: ${EMAIL_TO.join(', ')}`);
}

// Only run when invoked directly, so the chart builders can be imported and
// exercised on their own (see scripts/preview-charts.mjs).
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

export {
  buildWaterLevelChart, buildFlowChart, buildSpreadChart,
  // pure helpers, exported for scripts/test.mjs
  filterOutliers, readingNDaysBack, median, poolAroundDay, addDays, toRecord,
  lastCalendarDays, windowLabel, parseMurAscii,
  computeTodayTempStats, computeNextWeekTempForecast,
  daysBetween, ordinal, paddedBounds,
  // station tables, so the site generator labels gauges identically to the email
  STATION, EXTRA_STATIONS, FLOW_STATIONS, CM_PER_INCH, TODAY_ISO, CURRENT_YEAR,
  TEMP_CSV_PATH, ARCHIVE_DIR,
};
