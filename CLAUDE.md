# Muskoka Tracker

A daily water report for Lake Muskoka and Lake Rosseau: a 7am email to family,
plus a public dashboard at https://petedilworth.github.io/muskoka-tracker/.
It covers lake levels, river flow and satellite water temperature back to 2002.

## Why I build things
- I build these projects to learn new systems and platforms. The learning is the point.
- I like to overbuild and go over the top. Aim for ambitious and polished.
- Don't talk me out of an idea because it's more than I need.
- Do tell me about real money costs and real risks.
- When we use something new to me, tell me what it is and why we're using it.

## How to work with me
- Always explain things in simple English. If you need a technical term, say what it means.
- Before we start, give me a short outline of what we're going to do.
- Then go one step at a time. Give me only the current step, then stop so I can ask questions.
- Don't put several detailed steps in one message. My questions get lost in the chat.
- If I'm not there (a scheduled run), don't wait for me. Finish the work and report at the end.

## Systems I have access to
I already have these. Check this list before asking me to sign up for something new.
Keys go in the repo's secrets or the host's settings, never in the repo.
How I set each one up (choices, click-by-click steps, traps, my usual
questions) is in `guides/platform-setup.md` in petedilworth/claude-templates.
Read the platform's section before writing setup steps for me, and update it
there when a screen has changed or a step was wrong.
- Claude: Claude Code, Cowork, Claude chat, Artifacts, Claude Docs, Claude API
- Code and hosting: GitHub, GitHub Actions, GitHub Pages, Vercel, Cloudflare Pages,
  Cloudflare Access, Cloudflare Workers
- Data and email: Supabase, Resend, Gmail (app password for sending mail)
- Logins and keys: Oura, Yahoo Fantasy, Companies House, DataStream
- Connected to Claude: Gmail, Google Calendar, Google Drive
- Available to connect: Strava
- Other tools: Python, VS Code, Google Sheets, iOS Shortcuts, Power Query, Power BI, LinkedIn
- Free tools, no account: Whisper, yt-dlp, SQLite, FastAPI, Astro, Playwright, Leaflet
- Public data, no account: ESPN, nflverse, Environment Canada, Open-Meteo,
  OpenStreetMap, football-data.co.uk

## Tracker
This repo reports to my Build Pipeline dashboard through ROADMAP.md.
- At the end of any session that changes the repo, update ROADMAP.md:
  tick finished items and move them to Done with the date;
  add new work you find under Later.
- One line per item, under 90 characters, plain words.
- Never reword or reorder existing items. The dashboard matches items
  by their exact text, and I set priority there.
- Delete items I've dropped; say so in the reply.

## Git
- When the work is done, commit and push to main (or this repo's default
  branch, if that's different). Never leave a branch or pull request for
  me to merge – I don't review code.
- If you worked on a side branch, merge it and push before you finish.
- Before pushing, run this repo's tests or checks. If they fail, fix
  them. If you can't, don't push, and tell me why.
- If this repo publishes a website, check the change at phone width first.

## How this project works
- `.github/workflows/daily-notify.yml` runs at 11:00 UTC: 7am in summer,
  6am in winter. It runs the tests, then `notify.mjs`, then rebuilds the site
  and commits `data/` and `docs/`. The site still rebuilds if the email fails.
- `notify.mjs` gets levels and flow from Environment Canada's open data API
  (api.weather.gc.ca: `hydrometric-realtime` and `hydrometric-daily-mean`).
  Water temperature comes from NOAA's MUR satellite data for Bala Bay.
  It sends the email through Resend. Cost is $0.
- The gauge lists are at the top of `notify.mjs`. Levels: Bala (02EB015),
  Beaumaris, Port Carling, Port Sydney, Baysville. Flow: Big East River near
  Huntsville (02EB013), Port Sydney, Baysville. The flow gauge below Bala
  (02EB006) stopped in 2021 and is hidden on the site. There is no live flow
  gauge at Bala.
- `scripts/build-site.mjs` turns `data/` into the static site in `docs/`,
  served by GitHub Pages from main `/docs`. It does all the data shaping;
  `app.js` only formats numbers and draws charts. Chart.js and Leaflet are
  copied from `node_modules` into `docs/assets/`, not loaded from the web.
  Paths are relative. Pages carry `noindex` and `robots.txt` blocks crawling.
- The gauge map uses Leaflet on OpenStreetMap tiles. Gauge positions are
  cached in `data/history/stations.json`. Without that file the map is left out.

Data:
- `data/history/` has one CSV per gauge series, back to each gauge's start.
  `_manifest.json` records which series already have their full history.
  Normal runs fetch only the last five years.
- `data/water-temp.csv` is the temperature archive back to 2002. GitHub's
  servers are often blocked by NOAA's mirrors, so the email may lag a few days.
- Environment Canada publishes daily means one year at a time, about seven
  months after the year ends. The live feed keeps about a month. So no gauge
  has data for 2026-01-01 to 2026-06-06, the whole spring flood. It should
  fill itself around July 2027. Until then the daily emails are the only record.
- To recover that gap from the emails: export them from Gmail with Takeout, then
  `python3 scripts/extract-email-levels.py Takeout/Mail/*.mbox -o data/email-levels.csv`
  `node scripts/merge-email-levels.mjs data/email-levels.csv` (dry run first)
  `node scripts/merge-email-levels.mjs data/email-levels.csv --apply`
  The merge checks the emails against days we already have. It refuses if they
  differ by more than 2 cm, overlap too little, or fall outside the gauge's range.
  Environment Canada's official numbers replace email figures when 2026 is published.

## How to check things here
- `npm test` runs the unit tests on the data logic. No network, no keys.
  The daily workflow runs them first and stops the email if they fail.
- `npm run build:site` rebuilds `docs/` from `data/`. No network. Run it after
  any change to `scripts/build-site.mjs` or `scripts/lib/`, and commit `docs/`.
- Preview the site with `python3 -m http.server -d docs 8000`, then check each
  page at phone width (about 390px) with Playwright.
- `node notify.mjs --dry-run` builds the email into `preview.html` without
  sending. It needs Environment Canada and NOAA, which this sandbox blocks.
- `npm run smoke` runs the whole notifier offline against fake servers.
- `node notify.mjs --fetch-only` updates only `data/water-temp.csv`. Run it
  from a home connection when NOAA blocks GitHub's servers.
- `node notify.mjs --backfill` fetches every gauge's full history in one go.
- `node scripts/probe-sources.mjs` (or the "Probe data sources" Action) checks
  what OPG and DataStream serve. It writes nothing.

Rules for this repo:
- Never edit files in `docs/` by hand. They are built. Edit `scripts/lib/`
  (`app.js`, `site.css`) or `scripts/build-site.mjs`, then rebuild.
- A bot commits new data to main every morning. Pull right before you push.
- The daily run only uses main. Work on a branch won't reach the email until
  it is merged.
- Keep "vs July avg" a five-year average. A longer one would quietly change
  the headline number in the email and on the site.
- `data/history/` CSVs are append-only. Change them only through `notify.mjs`
  or `scripts/merge-email-levels.mjs`, never by hand.
- Figures recovered from emails never overwrite existing values.
- `npm run smoke` can write fake gauge positions to `data/history/stations.json`
  and touch other data files. Run `git status` after it and undo with
  `git checkout data/` before committing.
- This sandbox can't reach outside data sites (OPG, DataStream, NOAA). To see
  what one serves, run the "Probe data sources" Action and read its log.
  Don't write a parser against a guessed response.
- Keys (`RESEND_API_KEY`, `EMAIL_TO`, `EMAIL_FROM`, `DATASTREAM_API_KEY`) live
  in GitHub Actions secrets only.
