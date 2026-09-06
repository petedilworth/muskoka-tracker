#!/usr/bin/env node
// Fold email-recovered levels into the archive, but only after they prove
// themselves against data we already trust.
//
//   node scripts/merge-email-levels.mjs data/email-levels.csv          (dry run)
//   node scripts/merge-email-levels.mjs data/email-levels.csv --apply
//
// The emails are the only record of 2026-01-01 through 2026-06-06, but they are
// second-hand: each one reports what the notifier computed from realtime samples
// that morning, not Environment Canada's published daily mean. Those are
// different quantities, and the difference is worth measuring rather than
// assuming away.
//
// So this checks before it writes. The emails also cover 2026-06-07 onward,
// where the archive already holds first-hand data, and that overlap is a free
// test of the extraction: if the emails reproduce the days we can verify, they
// can be believed on the days we cannot. If they do not, the merge refuses.
//
// Existing archive values always win. Email figures fill holes and never
// overwrite. When Environment Canada finally publishes 2026 -- one calendar year
// at a time, roughly seven months after it ends -- the ordinary daily run merges
// with the official values winning, and these estimates are quietly superseded.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSeries } from '../notify.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARCHIVE_DIR = path.join(ROOT, 'data', 'history');

// Beyond this the extraction is misreading something, not merely measuring
// differently. Realtime daily averages and published daily means for the same
// day typically sit within a centimetre or two of each other.
const MAX_MEDIAN_DIFF_M = 0.02;
const MIN_OVERLAP_DAYS = 20;

const inches = (m) => (m * 100 / 2.54).toFixed(1);

function parseCsv(text) {
  const [header, ...lines] = text.trim().split('\n');
  const cols = header.split(',');
  return lines.filter(Boolean).map(line => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function loadSeries(station) {
  const file = path.join(ARCHIVE_DIR, `level-${station}.csv`);
  try {
    const text = await fs.readFile(file, 'utf8');
    return parseCsv(text).map(r => ({ date: r.date, value: parseFloat(r.value) }))
      .filter(d => d.date && Number.isFinite(d.value));
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvPath = args.find(a => !a.startsWith('--'));
  if (!csvPath) {
    console.error('usage: node scripts/merge-email-levels.mjs <email-levels.csv> [--apply]');
    process.exit(2);
  }

  const rows = parseCsv(await fs.readFile(csvPath, 'utf8'))
    .map(r => ({ date: r.date, station: r.station, value: parseFloat(r.value), dateSource: r.date_source }))
    .filter(r => r.date && r.station && Number.isFinite(r.value));

  if (rows.length === 0) {
    console.error('No usable rows in ' + csvPath);
    process.exit(1);
  }

  const inferredDates = rows.filter(r => r.dateSource === 'header').length;
  console.log(`${rows.length} email readings, ${rows[0].date} to ${rows[rows.length - 1].date}`);
  if (inferredDates > 0) {
    console.log(`  ${inferredDates} carry a date inferred from the send time rather than `
      + `stated in the body — a day either way is possible on those`);
  }

  const byStation = new Map();
  for (const r of rows) {
    if (!byStation.has(r.station)) byStation.set(r.station, []);
    byStation.get(r.station).push({ date: r.date, value: r.value });
  }

  let blocked = false;
  const plans = [];

  for (const [station, fresh] of [...byStation].sort()) {
    const archive = await loadSeries(station);
    const known = new Map(archive.map(d => [d.date, d.value]));

    // The overlap is the whole argument. Without it this is a guess.
    const diffs = [];
    for (const d of fresh) {
      if (known.has(d.date)) diffs.push(d.value - known.get(d.date));
    }
    const absDiffs = diffs.map(Math.abs);
    const med = median(absDiffs);
    const worst = absDiffs.length ? Math.max(...absDiffs) : null;

    // A datum mix-up would show as a value nowhere near this gauge's range.
    // Bala reads about 225 m above sea level; the others read single digits.
    const vals = archive.map(d => d.value);
    const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const offScale = archive.length ? fresh.filter(d => d.value < lo || d.value > hi) : [];

    const novel = fresh.filter(d => !known.has(d.date));
    const novelDates = novel.map(d => d.date).sort();

    console.log(`\n${station} — ${archive.length} archived days, ${fresh.length} from email`);
    if (diffs.length === 0) {
      console.log('  overlap: none — nothing to check these readings against');
    } else {
      const within = absDiffs.filter(d => d <= 0.01).length;
      console.log(`  overlap: ${diffs.length} days both sources cover`);
      console.log(`    median difference ${(med * 1000).toFixed(1)} mm (${inches(med)} in)`);
      console.log(`    worst difference  ${(worst * 1000).toFixed(1)} mm (${inches(worst)} in)`);
      console.log(`    within 1 cm: ${within}/${diffs.length}`);
    }
    if (offScale.length) {
      console.log(`  ${offScale.length} readings fall outside this gauge's entire recorded range `
        + `(${lo.toFixed(2)}–${hi.toFixed(2)} m) — e.g. ${offScale[0].date} = ${offScale[0].value}`);
    }
    console.log(`  would add ${novel.length} days`
      + (novelDates.length ? `, ${novelDates[0]} to ${novelDates[novelDates.length - 1]}` : ''));

    // Refuse rather than half-trust. A thin overlap is not proof of anything.
    const reasons = [];
    if (diffs.length === 0) reasons.push('no overlap to verify against');
    else if (diffs.length < MIN_OVERLAP_DAYS) reasons.push(`overlap of ${diffs.length} days is too thin to be evidence`);
    if (med !== null && med > MAX_MEDIAN_DIFF_M) reasons.push(`median difference ${(med * 1000).toFixed(0)} mm exceeds the ${MAX_MEDIAN_DIFF_M * 1000} mm limit`);
    if (offScale.length) reasons.push(`${offScale.length} readings outside the gauge's range`);

    if (reasons.length) {
      console.log(`  REFUSED: ${reasons.join('; ')}`);
      blocked = true;
    } else if (novel.length === 0) {
      console.log('  nothing new to add');
    } else {
      // Archive second, so archive wins: email values fill holes only.
      plans.push({ station, merged: mergeSeries(fresh, archive), added: novel.length });
      console.log('  verified');
    }
  }

  console.log('');
  if (blocked) {
    console.log('Nothing written. Fix the extraction, or explain the disagreement, before merging.');
    process.exitCode = 1;
    return;
  }
  if (plans.length === 0) {
    console.log('Nothing to add.');
    return;
  }
  if (!apply) {
    console.log(`Dry run. Re-run with --apply to write ${plans.reduce((n, p) => n + p.added, 0)} days `
      + `across ${plans.length} stations.`);
    return;
  }
  for (const p of plans) {
    const file = path.join(ARCHIVE_DIR, `level-${p.station}.csv`);
    await fs.writeFile(file, 'date,value\n' + p.merged.map(d => `${d.date},${d.value}`).join('\n') + '\n', 'utf8');
    console.log(`  wrote ${path.relative(ROOT, file)} (+${p.added} days)`);
  }
  console.log('\nThese days are email-derived estimates. Environment Canada\'s published '
    + 'values will overwrite them automatically when 2026 is released.');
}

main().catch(e => { console.error(e); process.exit(1); });
