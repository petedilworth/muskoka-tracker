#!/usr/bin/env python3
"""Recover water levels from the daily emails' own text.

    python3 scripts/extract-email-levels.py Takeout/Mail/*.mbox -o data/email-levels.csv

Environment Canada publishes its daily-mean series a year or more behind, and
the realtime feed keeps only about a month. Between the two, this project has
nothing at all for 2026-01-01 through 2026-06-06 -- the spring freshet, at every
gauge. But the notifier emailed a full station table every morning through that
window, and those emails are still in the mailbox. They are the only surviving
record of that period.

Reads a Gmail/Takeout mbox, pulls the level table out of each message, and
writes one flat CSV. Deliberately does no merging: scripts/merge-email-levels.mjs
owns the archive format and checks this output against known-good data before
anything is written. Standard library only, so there is nothing to install.

The emails are our own, so the format is known -- but it has drifted since the
first send in March 2026, and the repository's history only reaches 2026-04-15,
so the earliest layouts cannot be read from the source. Anything unrecognised is
reported with a sample rather than skipped quietly.
"""

import argparse
import csv
import email
import email.utils
import mailbox
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from html import unescape
from zoneinfo import ZoneInfo

LAKE_TZ = ZoneInfo("America/Toronto")

# Station name alone is ambiguous: "Bala" is both the Lake Muskoka level gauge
# (02EB015) and the Muskoka River flow gauge (02EB006), and "Port Carling"
# likewise. The body of water disambiguates, so key on the pair.
LEVEL_STATIONS = {
    ("Bala", "Lake Muskoka"): "02EB015",
    ("Beaumaris", "Lake Muskoka"): "02EB018",
    ("Port Carling", "Lake Rosseau"): "02EB020",
    ("Port Sydney", "N. Branch Muskoka R."): "02EB004",
    ("Baysville", "S. Branch Muskoka R."): "02EB008",
}

# "  Bala (Lake Muskoka): 225.350m | ..."  -- the plain-text alternative.
# The trailing "m" must butt against the number: flow rows read "234.5 m3/s",
# with a space, and must not be mistaken for a level.
TEXT_ROW = re.compile(
    r"^\s+(?P<name>[^(\n]+?)\s*\((?P<label>[^)\n]+)\):\s*(?P<value>-?\d+\.\d+)m(?![\w/])",
    re.MULTILINE,
)

# The email header line carries the date of the reading itself, derived from the
# newest gauge value rather than from when the mail was sent. That is the date
# we want; the Date: header is only a fallback.
DATE_LINE = re.compile(r"Water Levels\s*[—–-]\s*(.+?)\s*$", re.MULTILINE)

DATE_FORMATS = [
    "%A, %B %d, %Y",   # Thursday, August 13, 2026
    "%B %d, %Y",       # August 13, 2026
    "%A, %d %B %Y",
    "%Y-%m-%d",
]

TAG = re.compile(r"<[^>]+>")
ROW = re.compile(r"<tr\b.*?</tr>", re.IGNORECASE | re.DOTALL)
CELL = re.compile(r"<t[dh]\b.*?>(.*?)</t[dh]>", re.IGNORECASE | re.DOTALL)


def parse_reading_date(body, msg):
    """The date the readings describe, and how confident we are in it."""
    m = DATE_LINE.search(body)
    if m:
        raw = m.group(1).strip()
        for fmt in DATE_FORMATS:
            try:
                return datetime.strptime(raw, fmt).date().isoformat(), "body"
            except ValueError:
                continue
    # No parseable date line. The mail is sent at 7am lake time reporting the
    # newest reading available, so the send date is a close stand-in -- but it
    # is a stand-in, and gets labelled as one so the merge step can weigh it.
    hdr = msg.get("Date")
    if hdr:
        try:
            dt = email.utils.parsedate_to_datetime(hdr)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(LAKE_TZ).date().isoformat(), "header"
        except (TypeError, ValueError):
            pass
    return None, None


def body_parts(msg):
    """Plain text first, HTML second. Both are yielded so a message whose text
    part lost its table can still be read from the markup."""
    for want in ("text/plain", "text/html"):
        for part in msg.walk():
            if part.get_content_type() != want:
                continue
            if part.get_content_disposition() == "attachment":
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                yield want, payload.decode(charset, errors="replace")
            except LookupError:
                yield want, payload.decode("utf-8", errors="replace")


def rows_from_text(body):
    out = []
    for m in TEXT_ROW.finditer(body):
        key = (m.group("name").strip(), m.group("label").strip())
        if key in LEVEL_STATIONS:
            out.append((LEVEL_STATIONS[key], key[0], key[1], float(m.group("value"))))
    return out


def rows_from_html(body):
    """Read the station table out of the markup. The first three cells of each
    row are name, body of water and level; later cells are derived comparisons
    we do not want, since they can be recomputed from the level."""
    out = []
    for raw_row in ROW.findall(body):
        cells = [unescape(TAG.sub("", c)).strip() for c in CELL.findall(raw_row)]
        if len(cells) < 3:
            continue
        key = (cells[0], cells[1])
        if key not in LEVEL_STATIONS:
            continue
        try:
            value = float(cells[2])
        except ValueError:
            continue
        out.append((LEVEL_STATIONS[key], key[0], key[1], value))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mbox", nargs="+", help="one or more .mbox files")
    ap.add_argument("-o", "--out", default="data/email-levels.csv")
    ap.add_argument("--subject", default="Muskoka|Bala",
                    help="regex a subject must match; other mail is ignored")
    ap.add_argument("--show-unparsed", type=int, default=2,
                    help="how many unreadable messages to print in full")
    args = ap.parse_args()

    subject_re = re.compile(args.subject, re.IGNORECASE)
    # (date, station) -> value. Two emails can report the same reading date;
    # later ones win, being the more settled value.
    readings = {}
    meta = {}
    seen = considered = 0
    source_counts = Counter()
    date_counts = Counter()
    unparsed = []

    for path in args.mbox:
        try:
            box = mailbox.mbox(path)
        except (OSError, IOError) as e:
            print(f"cannot open {path}: {e}", file=sys.stderr)
            continue
        for msg in box:
            seen += 1
            subject = str(msg.get("Subject", ""))
            if not subject_re.search(subject):
                continue
            considered += 1
            date, date_source = None, None
            found = []
            for kind, body in body_parts(msg):
                if date is None:
                    # In markup the date sits inside a heading, so the tags have
                    # to come off before the line can be recognised.
                    plain = unescape(TAG.sub("\n", body)) if kind == "text/html" else body
                    date, date_source = parse_reading_date(plain, msg)
                found = rows_from_text(body) if kind == "text/plain" else rows_from_html(body)
                if found:
                    source_counts[kind] += 1
                    break
            if not found or not date:
                unparsed.append((path, subject, msg.get("Date"), date, len(found)))
                continue
            date_counts[date_source] += 1
            for station, name, label, value in found:
                readings[(date, station)] = value
                meta[(date, station)] = (name, label, date_source)

    if not readings:
        print("No level rows recovered. Check --subject, and that the export "
              "actually contains these messages.", file=sys.stderr)

    rows = sorted(readings.items())
    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "station", "value", "name", "label", "date_source"])
        for (date, station), value in rows:
            name, label, date_source = meta[(date, station)]
            w.writerow([date, station, f"{value:.3f}", name, label, date_source])

    dates = sorted({d for d, _ in readings})
    print(f"{seen} messages scanned, {considered} matched the subject filter")
    print(f"read from: " + ", ".join(f"{k} {v}" for k, v in source_counts.items()) or "read from: nothing")
    print(f"reading date taken from: " + ", ".join(f"{k} {v}" for k, v in date_counts.items()))
    print(f"{len(rows)} readings across {len(dates)} days"
          + (f", {dates[0]} to {dates[-1]}" if dates else ""))
    per_station = Counter(s for _, s in readings)
    for station, n in sorted(per_station.items()):
        print(f"  {station}: {n}")
    print(f"wrote {args.out}")

    if unparsed:
        print(f"\n{len(unparsed)} messages matched the subject but yielded nothing.")
        print("The format before 2026-04-15 predates this repository's history, "
              "so it may need a new pattern. Samples:")
        for path, subject, hdr, date, n in unparsed[:args.show_unparsed]:
            print(f"  {hdr} | {subject!r} | date={date} rows={n}")
        print("Run again with --show-unparsed to see more.")


if __name__ == "__main__":
    main()
