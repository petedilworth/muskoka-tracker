// Offline stand-in for every host notify.mjs talks to. Serves Environment
// Canada's OGC collections out of the on-disk archive in the shape the real API
// returns, answers Resend with a fake id, and fails NOAA the way the live
// mirrors have been failing. Usage:
//
//   npm run smoke
//
// Purpose: reproduce a crash in the post-fetch path without any network.
import fs from 'node:fs';

const ARCH = new URL('../data/history/', import.meta.url);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const HYDAT_END = '2025-12-31';   // daily means lag; realtime covers the rest

function series(kind, stn) {
  try {
    return fs.readFileSync(new URL(`${kind}-${stn}.csv`, ARCH), 'utf8').trim().split('\n').slice(1)
      .map(l => { const [date, v] = l.split(','); return { date, value: parseFloat(v) }; })
      .filter(d => d.date && Number.isFinite(d.value));
  } catch { return []; }
}

function merged(stn, from, to) {
  const byDate = new Map();
  for (const d of series('level', stn)) if (d.date >= from && d.date <= to) byDate.set(d.date, { ...(byDate.get(d.date) || {}), LEVEL: d.value });
  for (const d of series('flow', stn)) if (d.date >= from && d.date <= to) byDate.set(d.date, { ...(byDate.get(d.date) || {}), DISCHARGE: d.value });
  return [...byDate].sort(([a], [b]) => a.localeCompare(b));
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const calls = [];

globalThis.fetch = async (input, opts = {}) => {
  const u = new URL(String(input));
  calls.push(u.hostname + u.pathname);

  if (u.hostname === 'api.weather.gc.ca') {
    const stn = u.searchParams.get('STATION_NUMBER');
    const limit = parseInt(u.searchParams.get('limit') || '500', 10);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);
    let feats = [];
    if (u.pathname.includes('hydrometric-realtime')) {
      feats = merged(stn, addDays(TODAY, -30), TODAY).map(([date, p]) => ({
        properties: { STATION_NUMBER: stn, DATETIME: date + 'T12:00:00Z', LEVEL: p.LEVEL ?? null, DISCHARGE: p.DISCHARGE ?? null },
      }));
    } else if (u.pathname.includes('hydrometric-daily-mean')) {
      const [from] = (u.searchParams.get('datetime') || '1900-01-01/').split('/');
      feats = merged(stn, from, HYDAT_END).map(([date, p]) => ({
        properties: { STATION_NUMBER: stn, DATE: date, LEVEL: p.LEVEL ?? null, DISCHARGE: p.DISCHARGE ?? null },
      }));
    }
    // annual-peaks and anything else: empty, which the code treats as "keep the archive"
    const page = feats.slice(offset, offset + limit);
    return json({ type: 'FeatureCollection', features: page, numberMatched: feats.length, numberReturned: page.length });
  }

  if (u.hostname === 'api.resend.com') {
    const body = JSON.parse(opts.body || '{}');
    console.log(`[stub] Resend would send: to=${JSON.stringify(body.to)} subject=${JSON.stringify(body.subject)} html=${(body.html || '').length}B text=${(body.text || '').length}B attachments=${(body.attachments || []).length}`);
    return json({ id: 'stub-email-id' });
  }

  // NOAA mirrors: the live sources have been failing; make the stub fail the same way
  throw new Error(`[stub] no route to ${u.hostname}`);
};

process.on('exit', () => {
  console.log(`[stub] ${calls.length} fetches; hosts: ${[...new Set(calls.map(c => c.split('/')[0]))].join(', ')}`);
});
