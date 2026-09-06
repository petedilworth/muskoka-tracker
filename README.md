# 🌊 Muskoka Tracker

Daily water conditions for Lake Muskoka and Lake Rosseau — a morning email plus
a static dashboard, both rebuilt automatically and hosted for free.

Covers nine gauge slots: water levels at Bala, Beaumaris, Port Carling, Port
Sydney and Baysville, and river flow on both branches of the Muskoka River and
the Indian River. Water temperature comes from satellite, with an archive going
back to 2002.

## How it works

1. A GitHub Actions workflow runs every morning at ~7am ET
2. It fetches levels and flow from Environment Canada's open data API, and water
   temperature from NOAA's MUR SST satellite analysis
3. It computes deltas against the 5-year July average, the 7-day trend, and how
   today's temperature ranks against every year on record
4. It emails an HTML summary via Resend, rebuilds the dashboard, and commits the
   refreshed data

**Cost: $0.** GitHub Actions is free for public repos, and Resend's free tier covers 100 emails/day.

---

## Setup (one-time, ~10 minutes)

### Step 1: Create a Resend account

1. Go to [resend.com](https://resend.com) and sign up (free)
2. In the dashboard, go to **API Keys** → **Create API Key**
3. Copy the key (starts with `re_...`) — you'll need it in Step 3

> **Optional but recommended:** To send from a custom address (like `bala@yourdomain.com`), add and verify your domain in Resend under **Domains**. Otherwise, emails will come from `onboarding@resend.dev` which works fine but may land in spam initially.

### Step 2: Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it something like `muskoka-tracker`
3. Make it **Public** (required for free GitHub Actions minutes)
4. Upload the files from this project:
   - `notify.mjs` (in the root)
   - `.github/workflows/daily-notify.yml` (in the `.github/workflows/` folder)

### Step 3: Add your secrets

In your GitHub repo:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add these three:

| Secret name | Value | Example |
|---|---|---|
| `RESEND_API_KEY` | Your Resend API key | `re_abc123...` |
| `EMAIL_TO` | Comma-separated email addresses | `pedro@example.com,dad@example.com` |
| `EMAIL_FROM` | Sender address (optional) | `Muskoka Tracker <onboarding@resend.dev>` |

> For `EMAIL_FROM`: if you haven't verified a custom domain in Resend, use `Muskoka Tracker <onboarding@resend.dev>`.

### Step 4: Test it

1. Go to **Actions** tab in your repo
2. Click **Daily Muskoka Water Levels** on the left
3. Click **Run workflow** → **Run workflow**
4. Watch it run — you should get an email within a minute!

### Step 5: Done

The workflow will now run automatically every morning. GitHub will email you if it ever fails.

---

## What the email looks like

```
Subject: 🌊 Muskoka: -0.9 in vs July avg · 20.0°C

🌊 Muskoka Water Levels — Sunday, August 30, 2026

Current: -0.9 in vs July avg
Water temp (Aug 28): 20.0°C (68°F)
  Aug 25-Aug 31 historically: 18.2-24.8°C (median 21.3°C) across 2002-2025
  — ranks 22nd warmest of 25 years on record — median temp expected to
  cool ~0.2°C over next 7 days (24-yr pattern)

7-day trend: +0.2 in ↗ rising

[year-over-year temperature chart]
[daily anomaly chart]
[water level + river flow charts per station]
```

---

## The dashboard site

Alongside the email, a static dashboard is generated into `docs/` and served by
GitHub Pages. It carries the full archive the email can't: 25 years of daily
water temperature, plus level and flow history for every gauge.

```bash
npm run build:site   # reads data/, writes docs/ — no network, no secrets
```

The generator does all the data shaping; `docs/assets/app.js` only formats
numbers and draws charts. Chart.js is vendored into `docs/assets/` rather than
loaded from a CDN, so the site works anywhere.

### Publishing it

Not enabled yet. To turn it on:

1. Repo **Settings → Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main`, folder **`/docs`** → Save

It lands at **https://petedilworth.github.io/muskoka-tracker/** within a minute
or two. The daily workflow rebuilds and commits `docs/` each morning, so the
site refreshes itself from then on.

Every asset path is relative, so the site works at any base path — renaming the
repo again would not break it. Pages carry a `noindex` meta tag and
`robots.txt` disallows crawling, so it stays out of search results.

---

## Running it locally

```bash
npm install
npm test             # 23 unit tests over the data logic

# Build the email and write preview.html / preview.txt — no secrets, no send.
# Open preview.html in a browser to see exactly what would go out.
node notify.mjs --dry-run

# Update data/water-temp.csv only (useful for seeding history from an IP that
# the NOAA ERDDAP mirrors haven't blocked — GitHub runner IPs often are).
node notify.mjs --fetch-only

# Fetch every gauge's FULL period of record from HYDAT in one go, rather than
# letting the daily job pick up two series at a time.
node notify.mjs --backfill
```

> **Note:** the daily cron always runs the **default branch** (`main`). Changes
> pushed to a feature branch won't show up in the morning email until they're
> merged.

---

## Customization

**Change the schedule:** Edit `.github/workflows/daily-notify.yml` and modify the cron expression. Use [crontab.guru](https://crontab.guru) to build the schedule.

**Add more recipients:** Update the `EMAIL_TO` secret with additional comma-separated addresses.

**Change the station:** Edit `notify.mjs` and change the `STATION` constant. Find station IDs at [wateroffice.ec.gc.ca](https://wateroffice.ec.gc.ca/search/real_time_e.html).

---

## Data

`data/history/` holds one append-only CSV per gauge series, covering each
station's full period of record from HYDAT. A daily run adds a line or two per
file, so git stores it as a small delta rather than rewriting a blob.

The deep history is fetched **once** per series and recorded in
`data/history/_manifest.json`. Ordinary runs then request only a five-year
window, since everything older is already archived; `--backfill` does every
series at once. Note that "vs July avg" stays a deliberate **five-year**
average even though the archive runs much deeper — widening it would silently
redefine the headline number on both the email and the site.

### The 2026 gap, and recovering it from email

Environment Canada publishes its daily means one calendar year at a time,
roughly seven months after that year ends: 2025 appeared in a single step on
2026-07-23. The realtime feed retains about a month. Between them, nothing
covers **2026-01-01 to 2026-06-06** at any gauge, which is the entire spring
freshet. It will fill itself around July 2027, because every run re-requests the
last five years and merges whatever comes back.

Until then the daily emails are the only record of that period. Two scripts
recover it:

```bash
# Export just these messages from Gmail via Takeout, then:
python3 scripts/extract-email-levels.py Takeout/Mail/*.mbox -o data/email-levels.csv
node scripts/merge-email-levels.mjs data/email-levels.csv          # dry run
node scripts/merge-email-levels.mjs data/email-levels.csv --apply
```

The extractor is standard-library Python, since reading an mbox needs no
dependencies there. The merge stays in Node, because the archive format and
`mergeSeries` already live in `notify.mjs` and are covered by tests.

The merge verifies before it writes. The emails also cover 2026-06-07 onward,
where the archive already holds first-hand data, so that overlap tests the
extraction: reproduce the days we can check, and the days we cannot become
credible. A median disagreement over 2 cm, a thin overlap, or a reading outside
the gauge's recorded range all refuse the merge outright.

Email figures never overwrite existing values, and Environment Canada's official
numbers supersede them automatically when 2026 is finally published.

## Data source

All data comes from Environment Canada's MSC Open Data OGC API:
- **Realtime readings:** [api.weather.gc.ca/collections/hydrometric-realtime](https://api.weather.gc.ca/collections/hydrometric-realtime)
- **Historical daily means (HYDAT):** [api.weather.gc.ca/collections/hydrometric-daily-mean](https://api.weather.gc.ca/collections/hydrometric-daily-mean)
