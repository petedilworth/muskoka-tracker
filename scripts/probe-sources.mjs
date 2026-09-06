// Discovery probe for prospective data sources.
//
//   node scripts/probe-sources.mjs          (or the "Probe data sources" Action)
//
// This writes nothing and touches no production path. It exists because the
// development sandbox's egress proxy blocks every third-party host, so the
// shape of these APIs cannot be observed while writing code against them. A
// parser written against a guessed response is code that looks finished and has
// never run — so this reports what is actually served, and the integration gets
// designed afterwards.
//
// Checks robots.txt before fetching anything else from a host, and reports
// rather than assumes.

const TIMEOUT_MS = 20000;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function get(url, opts = {}) {
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT_MS),
      headers: {
        // Identify honestly rather than impersonating a browser.
        'User-Agent': 'muskoka-tracker-probe/1.0 (+https://github.com/petedilworth/muskoka-tracker)',
        ...(opts.headers || {}),
      },
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, url: resp.url, text, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, ms: Date.now() - started };
  }
}

function head(title) {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`);
}

// Report what robots.txt says about a path without pretending to be a full
// parser — the point is to surface the rules for a human to read.
async function robots(origin, path) {
  const r = await get(`${origin}/robots.txt`);
  if (!r.ok) {
    console.log(`  robots.txt: ${bad(`HTTP ${r.status || r.error}`)} — treat as unknown, do not crawl`);
    return;
  }
  const lines = r.text.split('\n').map(l => l.trim()).filter(Boolean);
  const disallows = lines.filter(l => /^disallow:/i.test(l));
  console.log(`  robots.txt: ${ok('found')}, ${lines.length} lines, ${disallows.length} Disallow rules`);
  const relevant = disallows.filter(l => {
    const p = l.split(':')[1]?.trim();
    return p && (p === '/' || path.startsWith(p));
  });
  console.log(relevant.length
    ? `  ${bad('DISALLOWED')} for ${path}: ${relevant.join(' | ')}`
    : `  ${ok('no rule blocks')} ${path}`);
  const crawlDelay = lines.find(l => /^crawl-delay:/i.test(l));
  if (crawlDelay) console.log(`  ${crawlDelay}`);
}

// ── OPG: dam operations for the Bala reach ──

async function probeOpg() {
  head('OPG — water.opg.com (Bala reach dam operations)');
  const origin = 'https://water.opg.com';
  await robots(origin, '/sites/bala-reach/');

  const page = await get(`${origin}/sites/bala-reach/`);
  if (!page.ok) {
    console.log(`  page: ${bad(`HTTP ${page.status || page.error}`)} — thread closes here`);
    return;
  }
  console.log(`  page: ${ok('HTTP 200')}, ${(page.text.length / 1024).toFixed(0)} KB in ${page.ms}ms`);

  // Server-rendered numbers, or a JS shell that fetches them separately?
  const hasTable = /<table/i.test(page.text);
  const numbers = (page.text.match(/\d+\.\d{1,3}\s*(m³\/s|cms|m\b)/gi) || []).slice(0, 6);
  console.log(`  server-rendered table: ${hasTable ? ok('yes') : dim('no')}`);
  console.log(`  numeric readings visible in HTML: ${numbers.length ? ok(numbers.join(', ')) : dim('none')}`);

  // Candidate data endpoints referenced by the page or its scripts
  const urls = [...new Set(
    (page.text.match(/["'`]([^"'`]*\/(?:api|data|json|feed|graph)[^"'`]*)["'`]/gi) || [])
      .map(m => m.slice(1, -1)).filter(u => u.length < 200)
  )].slice(0, 15);
  console.log(`  candidate data endpoints (${urls.length}):`);
  for (const u of urls) console.log(`    ${u}`);

  const embedded = page.text.match(/(?:window\.\w+|var \w+)\s*=\s*(\{.{0,120}|\[.{0,120})/g) || [];
  console.log(`  embedded JS data blobs: ${embedded.length ? ok(String(embedded.length)) : dim('none')}`);
  if (embedded.length) console.log(`    e.g. ${embedded[0].replace(/\s+/g, ' ').slice(0, 110)}…`);

  console.log(dim('  → if this is a JS shell with no visible endpoint, the thread needs'));
  console.log(dim('    a browser-rendered probe or should stop at the About explainer.'));
}

// ── DataStream: Muskoka water quality ──
//
// Queries below follow datastreamapp/api-docs (docs/README.md) rather than
// guesswork. Three things there matter and are easy to get wrong:
//
//   1. contains() is NOT supported. It appears in the docs only inside an HTML
//      comment. The operators are in, eq, lt, gt, lte, gte, ne — so a location
//      cannot be found by name substring, and the documented way to select an
//      area is a lat/long bounding box.
//   2. The location name field is `Name`, not `LocationName`.
//   3. Attribution is mandatory: any published use needs the citation, licence
//      and a link to https://doi.org/{DOI}, all of which come from /Metadata.
//      So /Metadata is probed first, not as an afterthought.

// Muskoka lakes, centred on the Bala coordinates already used for the satellite
// temperature lookup (45.01 N, -79.6 W). Wide enough to take in Lake Muskoka,
// Lake Rosseau and Lake Joseph.
const MUSKOKA_BOX = {
  latMin: '44.85', latMax: '45.40',
  lonMin: '-79.95', lonMax: '-79.15',
};

// The docs ask for 2 requests/second and no parallelism, on pain of 429.
const DS_GAP_MS = 600;
// Province-level selector from the docs' RegionId list.
const DS_REGION = 'admin.4.ca.on';
const pause = (ms) => new Promise(r => setTimeout(r, ms));

function summarise(rows, fields, limit = 8) {
  for (const r of rows.slice(0, limit)) {
    console.log('    ' + fields.map(f => r[f] ?? '—').join(' · '));
  }
  if (rows.length > limit) console.log(dim(`    …and ${rows.length - limit} more`));
  if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
}

async function dsGet(url, headers, label) {
  const r = await get(url, { headers });
  const status = r.ok ? ok(`HTTP ${r.status}`) : bad(`HTTP ${r.status || r.error}`);
  console.log(`  ${label}: ${status} in ${r.ms}ms`);
  if (r.status === 429) console.log(`  ${bad('rate limited')} — the probe is pacing at ${DS_GAP_MS}ms; slow it further`);
  await pause(DS_GAP_MS);
  if (!r.ok) {
    if (r.text) console.log(dim(`    body: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`));
    return null;
  }
  try {
    const j = JSON.parse(r.text);
    if (j['@odata.nextLink']) console.log(dim('    more pages available (@odata.nextLink present)'));
    return j;
  } catch {
    console.log(dim(`    not JSON: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`));
    return null;
  }
}

async function probeDataStream() {
  head('DataStream — Muskoka water quality');
  const key = process.env.DATASTREAM_API_KEY;
  // The QA host lets a query be shaken out without touching production.
  const base = process.env.DATASTREAM_QA
    ? 'https://api.qa.datastream.org/v1/odata/v4'
    : 'https://api.datastream.org/v1/odata/v4';
  console.log(`  host: ${base}`);
  console.log(`  API key in env: ${key ? ok('yes') : dim('no — expect 401')}`);
  if (!key) {
    console.log(dim('  Request one via the "Request an API Key" form linked from'));
    console.log(dim('  github.com/datastreamapp/api-docs, then set DATASTREAM_API_KEY.'));
  }
  const headers = key ? { 'x-api-key': key } : {};

  // The docs show a lat/long bounding box under $filter generally, but neither
  // /Metadata nor /Locations lists Latitude or Longitude in its own "Filter By"
  // set — and filtering on them returned HTTP 400 with an empty message, so the
  // request was rejected as malformed before authentication was even reached.
  // RegionId IS in both Filter By lists, so select Ontario at the API and
  // narrow to Muskoka here.
  const region = `RegionId eq '${DS_REGION}'`;
  console.log(dim(`  filter: ${region}, narrowed to the Muskoka box in this script`));
  const inBox = (r) => r.Latitude >= +MUSKOKA_BOX.latMin && r.Latitude <= +MUSKOKA_BOX.latMax
    && r.Longitude >= +MUSKOKA_BOX.lonMin && r.Longitude <= +MUSKOKA_BOX.lonMax;

  // A bare request with no filter at all. Two quite different filters returned
  // the same 400 with an empty body, so the query may not be the problem: some
  // gateways answer an unauthenticated request with 400 rather than 401. This
  // control separates "my query is malformed" from "no key". Without it, the
  // 400 was read as a query bug once already, wrongly.
  const control = await dsGet(`${base}/Metadata?$top=1`, headers,
    'CONTROL: no filter, no select, one row');
  if (!control) {
    console.log(dim('    A bare request failing too points at credentials or the'));
    console.log(dim('    endpoint itself, not at the Muskoka query below.'));
  }

  // 1. Which datasets cover this area, and under what licence?
  const meta = await dsGet(
    `${base}/Metadata?$filter=${encodeURIComponent(region)}`
    + `&$select=${encodeURIComponent('DOI,DatasetName,DataCollectionOrganization,Citation,Licence,TemporalExtent')}`
    + '&$top=25',
    headers, 'Metadata (datasets covering Muskoka)');
  if (meta) {
    const rows = meta.value || [];
    console.log(`    ${rows.length} dataset(s)`);
    for (const r of rows) {
      console.log(`    ${r.DatasetName ?? '—'}`);
      console.log(dim(`      DOI ${r.DOI ?? '—'} · ${r.DataCollectionOrganization ?? '—'} · extent ${JSON.stringify(r.TemporalExtent ?? null)}`));
      if (r.Licence) console.log(dim(`      licence: ${String(r.Licence).slice(0, 120)}`));
    }
    if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
  }

  // 2. Which monitoring locations sit inside the box?
  const locs = await dsGet(
    `${base}/Locations?$filter=${encodeURIComponent(region)}`
    + `&$select=${encodeURIComponent('Id,DOI,Name,Latitude,Longitude,MonitoringLocationType')}`
    + '&$top=10000',
    headers, 'Locations (Ontario)');
  let sampleLocationId = null;
  if (locs) {
    const all = locs.value || [];
    const rows = all.filter(inBox);
    console.log(`    ${all.length} in Ontario, ${rows.length} inside the Muskoka box`);
    summarise(rows, ['Id', 'Name', 'MonitoringLocationType', 'Latitude', 'Longitude'], 12);
    sampleLocationId = rows[0]?.Id ?? null;
  }

  // 3. What is actually measured at one of them, and over what period?
  if (sampleLocationId !== null) {
    const obs = await dsGet(
      `${base}/Observations?$filter=${encodeURIComponent(`LocationId eq '${sampleLocationId}'`)}`
      + `&$select=${encodeURIComponent('CharacteristicName,ResultValue,ResultUnit,ActivityStartDate,ActivityDepthHeightMeasure')}`
      + '&$top=200',
      headers, `Observations at location ${sampleLocationId}`);
    if (obs) {
      const rows = obs.value || [];
      const byChar = new Map();
      for (const r of rows) {
        const k = `${r.CharacteristicName} (${r.ResultUnit ?? 'no unit'})`;
        if (!byChar.has(k)) byChar.set(k, []);
        byChar.get(k).push(r.ActivityStartDate);
      }
      console.log(`    ${rows.length} observations across ${byChar.size} characteristic(s)`);
      for (const [k, dates] of byChar) {
        const sorted = dates.filter(Boolean).sort();
        console.log(`      ${k}: ${dates.length} readings, ${sorted[0] ?? '?'} → ${sorted[sorted.length - 1] ?? '?'}`);
      }
      if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
    }
  } else {
    console.log(dim('  no location id available, so the Observations shape stays unknown'));
  }
}

// ── Environment Canada: can the missing spring be had another way? ──
//
// The archive holds nothing between Jan 2026 and Jun 2026 because the
// daily-mean series publishes on a long lag and this project only started
// caching realtime readings in June. Three MSC GeoMet collections the project
// has never called might carry the current year sooner. All three draw on
// HYDAT, so they may lag identically — worth confirming rather than assuming.

const EC_BASE = 'https://api.weather.gc.ca/collections';
const EC_STATION = '02EB015';

async function probeEnvironmentCanada() {
  head('Environment Canada — collections not yet used (can we get spring 2026?)');

  for (const coll of ['hydrometric-annual-peaks', 'hydrometric-annual-statistics', 'hydrometric-monthly-mean']) {
    const url = `${EC_BASE}/${coll}/items?f=json&STATION_NUMBER=${EC_STATION}&limit=500`;
    const r = await get(url);
    if (!r.ok) {
      console.log(`  ${coll}: ${bad(`HTTP ${r.status || r.error}`)}`);
      continue;
    }
    try {
      const feats = JSON.parse(r.text).features || [];
      // Year lives under different property names across these collections, so
      // look for whichever is present rather than assuming one.
      // Each collection names its date differently: annual-peaks and
      // monthly-mean use DATE, annual-statistics uses MAX_DATE/MIN_DATE. An
      // earlier version checked only DATE and reported "none parsed" for
      // annual-statistics, then still printed "has 2026: no" — a conclusion it
      // had not actually earned.
      const years = feats.map(f => {
        const p = f.properties || {};
        const d = p.YEAR ?? p.DATE ?? p.MAX_DATE ?? p.MIN_DATE ?? p.MONTH ?? null;
        return d === null ? null : String(d).substring(0, 4);
      }).filter(Boolean).map(Number).filter(Number.isFinite);
      const uniq = [...new Set(years)].sort((a, b) => a - b);
      const newest = uniq[uniq.length - 1];
      console.log(`  ${coll}: ${ok(`HTTP 200`)}, ${feats.length} features`);
      console.log(`    years present: ${uniq.length ? `${uniq[0]}–${newest}` : dim('none parsed')}`);
      console.log(uniq.length === 0
        ? `    has 2026: ${dim('unknown — no year field parsed, so this says nothing')}`
        : `    has 2026: ${uniq.includes(2026) ? ok('YES — this fills the gap') : bad('no')}`);
      if (feats[0]) console.log(dim(`    properties: ${Object.keys(feats[0].properties || {}).join(', ')}`));
    } catch (e) {
      console.log(`  ${coll}: ${dim('unparseable: ' + e.message)}`);
    }
    await pause(300);
  }

  // How far back does the realtime pool actually reach? This matters more than
  // it looks: the daily-mean series ends 2025-12-31, so realtime is the only
  // thing that could cover spring 2026, and notify.mjs caps its paging at 20
  // pages of 500 (10,000 features). At the ~4.5-minute sampling this station
  // reports, 10,000 features is about 31 days — which is exactly how far back
  // the first cached run reached. So "realtime only keeps ~30 days" and "our
  // own cap truncated it at ~31 days" predict the identical observation, and
  // nothing in the archive can tell them apart. Ask the API directly.
  head('Environment Canada — realtime retention vs. our own paging cap');

  // numberMatched is the server's total for the query, independent of limit or
  // of how many pages we choose to walk. If it exceeds 10,000, our cap is the
  // binding constraint and raising it recovers data.
  const totalUrl = `${EC_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${EC_STATION}&limit=1`;
  const total = await get(totalUrl);
  if (!total.ok) {
    console.log(`  total count: ${bad(`HTTP ${total.status || total.error}`)}`);
  } else {
    try {
      const j = JSON.parse(total.text);
      const matched = j.numberMatched ?? null;
      console.log(`  numberMatched for ${EC_STATION}: ${matched === null ? dim('not reported') : ok(String(matched))}`);
      if (typeof matched === 'number') {
        console.log(matched > 10000
          ? `    ${bad('our maxPages:20 x 500 = 10,000 cap is truncating this')} — raising it gets more`
          : `    ${ok('under our 10,000 cap')} — the pool itself is the limit, not our paging`);
      }
    } catch (e) {
      console.log(`  total count: ${dim('unparseable: ' + e.message)}`);
    }
  }
  await pause(300);

  // The oldest reading the pool holds, asked for directly rather than inferred
  // by walking pages until they run out.
  for (const [label, sort] of [['oldest', 'DATETIME'], ['newest', '-DATETIME']]) {
    const r = await get(`${EC_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${EC_STATION}&limit=1&sortby=${sort}`);
    if (!r.ok) {
      console.log(`  ${label} reading: ${bad(`HTTP ${r.status || r.error}`)}`);
      continue;
    }
    try {
      const f = (JSON.parse(r.text).features || [])[0];
      const p = f ? f.properties || {} : {};
      console.log(`  ${label} reading: ${f ? ok(String(p.DATETIME ?? dim('no DATETIME field'))) : dim('no features')}`);
      if (label === 'oldest' && f && p.DATETIME) {
        const days = Math.round((Date.now() - new Date(p.DATETIME)) / 86400000);
        console.log(`    retention: ${days} days`);
        console.log(days > 60
          ? `    ${ok('deeper than 30 days')} — spring 2026 may still be recoverable`
          : `    ${dim('about a month, as documented')} — spring 2026 is gone from this collection`);
      }
    } catch (e) {
      console.log(`  ${label} reading: ${dim('unparseable: ' + e.message)}`);
    }
    await pause(300);
  }

  // Does the collection accept a datetime range at all? If it does, backfilling
  // becomes a bounded set of small requests instead of walking every page.
  const rangeUrl = `${EC_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${EC_STATION}`
    + `&datetime=2026-04-01T00:00:00Z/2026-04-08T00:00:00Z&limit=10`;
  const range = await get(rangeUrl);
  if (!range.ok) {
    console.log(`  datetime range filter: ${bad(`HTTP ${range.status || range.error}`)} — unsupported, or the range is empty`);
  } else {
    try {
      const j = JSON.parse(range.text);
      const n = j.numberMatched ?? (j.features || []).length;
      console.log(`  datetime range filter (first week of April 2026): ${ok('accepted')}, ${n} readings`);
      console.log(n > 0
        ? `    ${ok('SPRING 2026 IS AVAILABLE')} — the gap can be backfilled`
        : `    ${dim('filter works but the window is empty')} — confirms the pool does not reach back that far`);
    } catch (e) {
      console.log(`  datetime range filter: ${dim('unparseable: ' + e.message)}`);
    }
  }
  await pause(300);

  // The Water Office publishes per-station realtime archives separately from
  // the OGC API. Check the rules before considering it, same as for OPG.
  head('Water Office — historical realtime downloads');
  await robots('https://wateroffice.ec.gc.ca', '/download/');
  // robots permits /download/, so look at what the page offers rather than
  // guessing an endpoint. Still reporting only: nothing is parsed or stored.
  // /search/historical_e.html searches HYDAT — the same source that stops at
  // 2025, so it cannot hold spring 2026. Water Office keeps a separate realtime
  // pool with its own retention, which is the only part worth chasing.
  for (const path of ['/search/real_time_e.html', '/download/index_e.html']) {
    const r = await get('https://wateroffice.ec.gc.ca' + path);
    console.log(`  ${path}: ${r.ok ? ok(`HTTP ${r.status}`) : bad(`HTTP ${r.status || r.error}`)}`);
    if (!r.ok) continue;
    const forms = [...new Set((r.text.match(/<form[^>]*action=["']([^"']+)["']/gi) || [])
      .map(m => m.replace(/.*action=["']/i, '').replace(/["']$/, '')))].slice(0, 8);
    const csv = [...new Set((r.text.match(/href=["']([^"']*(?:csv|download|services)[^"']*)["']/gi) || [])
      .map(m => m.replace(/.*href=["']/i, '').replace(/["']$/, '')))].slice(0, 8);
    console.log(`    form actions: ${forms.length ? forms.join(', ') : dim('none')}`);
    console.log(`    csv/download/services links: ${csv.length ? csv.join(', ') : dim('none')}`);
    // Retention is the whole question: how far back does the realtime pool go?
    const dates = [...new Set((r.text.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g) || []))].sort();
    if (dates.length) console.log(`    dates mentioned on the page: ${dates[0]} … ${dates[dates.length - 1]}`);
    await pause(500);
  }

  // MSC Datamart is explicitly open data and publishes hydrometric CSVs
  // directly, with no form to drive.
  head('MSC Datamart — dd.weather.gc.ca hydrometric CSVs');
  for (const path of ['/hydrometric/csv/ON/daily/', '/hydrometric/csv/ON/hourly/']) {
    const r = await get('https://dd.weather.gc.ca' + path);
    console.log(`  ${path}: ${r.ok ? ok(`HTTP ${r.status}`) : bad(`HTTP ${r.status || r.error}`)}`);
    if (!r.ok) continue;
    const ours = [...new Set((r.text.match(/href=["']([^"']*02EB015[^"']*)["']/gi) || [])
      .map(m => m.replace(/.*href=["']/i, '').replace(/["']$/, '')))].slice(0, 5);
    const all = (r.text.match(/href=["'][^"']*\.csv["']/gi) || []).length;
    console.log(`    ${all} csv files listed; for 02EB015: ${ours.length ? ok(ours.join(', ')) : dim('none')}`);
    await pause(400);
  }
}

// A sandbox egress proxy also answers 403, which looks identical to a service
// refusing us. Check a host that is certainly reachable and certainly public
// first, so a blocked environment is reported as such instead of being
// misread as "the API needs a key".
async function egressWorks() {
  const r = await get('https://api.weather.gc.ca/collections?f=json', { timeout: 10000 });
  return r.ok;
}

async function main() {
  console.log('Probing prospective data sources. Writes nothing; reports only.');
  console.log(dim(`Run at ${new Date().toISOString()}`));

  if (!await egressWorks()) {
    console.log(`\n${bad('This environment cannot reach the open internet.')}`);
    console.log('A control request to api.weather.gc.ca — public, no auth — also failed,');
    console.log('so every 403 below is this network, not the service. Run the');
    console.log('"Probe data sources" Action on a GitHub runner instead.');
  }

  await probeEnvironmentCanada();
  await probeOpg();
  await probeDataStream();
  console.log(`\n${'─'.repeat(70)}`);
  console.log('Done. Design the integration against what is printed above,');
  console.log('not against what the API was assumed to return.');
}

main().catch(e => { console.error('Probe failed:', e); process.exit(1); });
