/* Muskoka Tracker dashboard — dumb renderer.
   All shaping happens in scripts/build-site.mjs. This file formats numbers and
   draws charts; it computes nothing the generator could have computed. */
(function () {
  'use strict';

  var C = {
    ink: '#0B1D33', muted: '#6B6B6B', grid: '#F0EDE8', axis: '#E0DAD2',
    blue: '#2D6A9F', blueSoft: 'rgba(74,155,217,0.18)',
    green: '#5BA88A', orange: '#E07B4C', red: '#C0392B',
    band: 'rgba(107,142,173,0.16)', bandInner: 'rgba(107,142,173,0.28)',
    grey: 'rgba(150,150,150,0.5)'
  };

  // ── the single formatter ──
  // Every number on the site goes through here, keyed by the `format` field the
  // generator emits. Formatting the same value two different ways in two places
  // is how a dashboard starts contradicting itself.
  function fmt(value, format) {
    if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return '—';
    switch (format) {
      case 'int': return Math.round(value).toLocaleString('en-CA');
      case 'f0': return value.toFixed(0);
      case 'f1': return value.toFixed(1);
      case 'f2': return value.toFixed(2);
      case 'f3': return value.toFixed(3);
      case 'signed1': return (value > 0 ? '+' : '') + value.toFixed(1);
      case 'signed2': return (value > 0 ? '+' : '') + value.toFixed(2);
      case 'pct0': return Math.round(value) + '%';
      case 'ordinal': return ordinal(value);
      case 'date': return shortDate(value);
      default: return String(value);
    }
  }

  function ordinal(n) {
    var r = n % 100;
    if (r >= 11 && r <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function shortDate(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    return MONTHS[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10);
  }

  function monthLabel(iso, withYear) {
    var p = String(iso).split('-');
    var m = MONTHS[parseInt(p[1], 10) - 1];
    return withYear === undefined ? m + ' ' + p[0] : m + ' ' + p[0];
  }

  function longDate(iso) {
    if (!iso) return '—';
    var p = String(iso).split('-');
    return MONTHS[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
  }

  // Day-of-year -> "Aug 28", for the temperature charts whose x axis is the
  // day number so years can be overlaid.
  var MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  function dayOfYearLabel(day) {
    for (var i = MONTH_STARTS.length - 1; i >= 0; i--) {
      if (day >= MONTH_STARTS[i]) return MONTHS[i] + ' ' + (day - MONTH_STARTS[i] + 1);
    }
    return 'Day ' + day;
  }

  // ── chart defaults ──

  function baseOptions(opts) {
    opts = opts || {};
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: opts.xMin, max: opts.xMax,
          ticks: {
            callback: opts.xTick || function (v) { return v; },
            font: { size: 10 }, color: C.muted,
            // Seven date labels overlap at phone width ("Sep 19Sep 28"); five fit.
            maxRotation: 0, autoSkip: true,
            maxTicksLimit: opts.xTicks || (window.innerWidth < 520 ? 5 : 7)
          },
          grid: { display: false, drawBorder: true, borderColor: C.axis }
        },
        y: {
          title: opts.yLabel ? { display: true, text: opts.yLabel, font: { size: 10 }, color: C.muted } : { display: false },
          min: opts.yHard ? opts.yMin : undefined,
          max: opts.yHard ? opts.yMax : undefined,
          suggestedMin: opts.yHard ? undefined : opts.yMin,
          suggestedMax: opts.yHard ? undefined : opts.yMax,
          ticks: {
            callback: function (v) { return fmt(v, opts.yFormat || 'f1'); },
            font: { size: 10 }, color: C.muted, maxTicksLimit: 6,
            // With hard bounds the padded edge values would otherwise be
            // printed as ticks ("225.544"); let the scale pick round ones.
            includeBounds: false
          },
          grid: { color: C.grid, drawBorder: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(11,29,51,0.94)',
          titleFont: { size: 11 }, bodyFont: { size: 11 },
          padding: 8, displayColors: true, boxWidth: 8, boxHeight: 8,
          callbacks: {
            title: function (items) { return opts.tipTitle ? opts.tipTitle(items[0]) : String(items[0].parsed.x); },
            label: function (ctx) {
              if (ctx.parsed.y === null) return null;
              return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, opts.yFormat || 'f1') + (opts.unit ? ' ' + opts.unit : '');
            }
          }
        }
      }
    };
  }

  function pad(values, extra, frac, floor) {
    var all = values.concat(extra || []).filter(function (v) { return v !== null && v !== undefined && isFinite(v); });
    if (all.length === 0) return { min: undefined, max: undefined };
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var p = Math.max((hi - lo) * (frac === undefined ? 0.15 : frac), floor === undefined ? 0.02 : floor);
    return { min: lo - p, max: hi + p };
  }

  // ── distribution strip ──
  // Renders min · p25 · median · p75 · max as a box, with the current value
  // marked, so "today" is legible against the whole record rather than a
  // sparkline with no scale.
  function renderDist(el, d, value, format, unit) {
    if (!d || d.min === null || d.max === null) { el.innerHTML = ''; return; }
    var span = d.max - d.min || 1;
    var pos = function (v) { return Math.max(0, Math.min(100, ((v - d.min) / span) * 100)); };
    // The label is centred on the marker, so a reading at either extreme would
    // otherwise overhang the card. Pin it inside at the edges.
    var p = pos(value);
    var shift = p < 12 ? 'translateX(0)' : p > 88 ? 'translateX(-100%)' : 'translateX(-50%)';
    var markerHtml = (value === null || value === undefined) ? '' :
      '<div class="dist-marker" style="left:' + p + '%;--label-shift:' + shift + '" data-label="now ' + fmt(value, format) + '"></div>';
    el.innerHTML =
      '<div class="dist-track">' +
        '<div class="dist-box" style="left:' + pos(d.p25) + '%;width:' + (pos(d.p75) - pos(d.p25)) + '%"></div>' +
        '<div class="dist-median" style="left:' + pos(d.p50) + '%"></div>' +
        markerHtml +
      '</div>' +
      '<div class="dist-scale">' +
        '<span>min ' + fmt(d.min, format) + '</span>' +
        '<span>median ' + fmt(d.p50, format) + '</span>' +
        '<span>max ' + fmt(d.max, format) + ' ' + (unit || '') + '</span>' +
      '</div>';
  }

  // ── charts ──

  // One year against the envelope of every other year, by day of the year.
  // Two stacked fills give the p25–p75 band inside the min–max band; both are
  // emitted as explicit paired traces rather than relying on fill-to-dataset
  // across nulls. Serves temperature, level and flow alike: the payload shape
  // is the same, only the unit and format differ.
  //
  //   payload: { climatology: [[day, min, p25, p50, p75, max], …],
  //              current: { year, series: [[day, v], …] },
  //              previous: { year, series }, latest: { dayOfYear, value } }
  function seasonal(canvas, payload, opts) {
    opts = opts || {};
    var clim = payload.climatology;
    var xMin = opts.xMin || 1, xMax = opts.xMax || 366;
    var unit = opts.unit || '', format = opts.format || 'f1';
    var pick = function (i) {
      return clim.filter(function (r) { return r[0] >= xMin && r[0] <= xMax; })
                 .map(function (r) { return { x: r[0], y: r[i] }; });
    };
    var series = function (arr) {
      return (arr || []).filter(function (p) { return p[0] >= xMin && p[0] <= xMax; })
                        .map(function (p) { return { x: p[0], y: p[1] }; });
    };
    var cur = series(payload.current.series);
    var prev = payload.previous ? series(payload.previous.series) : [];

    var ys = cur.concat(pick(1), pick(5)).map(function (p) { return p.y; });
    var b = pad(ys, [], 0.08, opts.floor === undefined ? 0.5 : opts.floor);
    // Discharge cannot go negative; do not pad a river below zero.
    var seen = ys.filter(function (v) { return v !== null && isFinite(v); });
    if (seen.length && Math.min.apply(null, seen) >= 0 && b.min < 0) b.min = 0;

    var ds = [
      { label: 'Record low', data: pick(1), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.3 },
      { label: 'Record high', data: pick(5), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: C.band, tension: 0.3 },
      { label: '25th pct', data: pick(2), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.3 },
      { label: '75th pct', data: pick(4), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: C.bandInner, tension: 0.3 },
      { label: 'Median', data: pick(3), borderColor: C.muted, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.3 }
    ];
    if (prev.length) ds.push({ label: String(payload.previous.year), data: prev, borderColor: C.red, borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3, spanGaps: false });
    ds.push({ label: String(payload.current.year), data: cur, borderColor: C.blue, borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.3, spanGaps: false });
    if (payload.latest && payload.latest.dayOfYear >= xMin && payload.latest.dayOfYear <= xMax) {
      ds.push({
        label: 'Latest', data: [{ x: payload.latest.dayOfYear, y: payload.latest.value }],
        showLine: false, pointRadius: 5, pointBackgroundColor: C.orange,
        pointBorderColor: '#fff', pointBorderWidth: 1.5
      });
    }

    var o = baseOptions({
      xMin: xMin, xMax: xMax, yMin: b.min, yMax: b.max, yHard: true,
      yLabel: unit, yFormat: format, unit: unit,
      xTick: function (v) { return dayOfYearLabel(v); },
      tipTitle: function (item) { return dayOfYearLabel(item.parsed.x); }
    });
    o.plugins.tooltip.filter = function (ctx) { return ctx.dataset.borderWidth > 0 || ctx.dataset.label === 'Latest'; };
    return new Chart(canvas, { type: 'line', data: { datasets: ds }, options: o });
  }

  function tempClimatology(canvas, payload, opts) {
    return seasonal(canvas, payload, { xMin: opts.xMin, xMax: opts.xMax, unit: '°C', format: 'f1', floor: 0.5 });
  }

  // A level or flow station carries its envelope and two years of dated rows.
  // Re-keying those rows by day of the year is indexing, not computation — the
  // same dayOfYear() the envelope lookup already uses — so it is done here
  // rather than shipping every series a second time in a second shape.
  function seasonalFromStation(station, currentYear) {
    var byYear = {};
    (station.series || []).forEach(function (r) {
      if (!r[0] || r[1] === null) return;
      var y = parseInt(r[0].substring(0, 4), 10);
      (byYear[y] = byYear[y] || []).push([dayOfYear(r[0]), r[1]]);
    });
    var latest = station.latest || null;
    return {
      climatology: station.normal.envelope,
      current: { year: currentYear, series: byYear[currentYear] || [] },
      previous: { year: currentYear - 1, series: byYear[currentYear - 1] || [] },
      latest: latest ? { dayOfYear: dayOfYear(latest.date), value: latest.value } : null
    };
  }

  // Yearly means as bars. The current year is partial and drawn hollow so it
  // cannot be read as a full-year figure.
  function yearBars(canvas, yearMeans, currentYear, opts) {
    opts = opts || {};
    var rows = yearMeans.filter(function (r) { return r[1] !== null; });
    var minDays = opts.minDays || 350;
    var partial = function (r) { return r[0] === currentYear || r[2] < minDays; };
    var ys = rows.map(function (r) { return r[1]; });
    var b = pad(ys, [], 0.15, 0.5);
    var o = baseOptions({
      xMin: rows[0][0] - 0.6, xMax: rows[rows.length - 1][0] + 0.6,
      yMin: opts.fromZero ? 0 : b.min, yMax: b.max, yHard: true,
      yLabel: opts.unit || '', yFormat: opts.format || 'f1', unit: opts.unit || '',
      xTicks: 13,
      xTick: function (v) { return Number.isInteger(v) ? String(v) : ''; },
      tipTitle: function (item) {
        var r = rows[item.dataIndex];
        return String(r[0]) + (partial(r) ? ' (partial year, ' + r[2] + ' days)' : '');
      }
    });
    o.scales.x.ticks.autoSkip = true;
    return new Chart(canvas, {
      type: 'bar',
      data: {
        datasets: [{
          label: opts.label || 'Mean',
          data: rows.map(function (r) { return { x: r[0], y: r[1] }; }),
          backgroundColor: rows.map(function (r) { return partial(r) ? 'transparent' : C.blue; }),
          borderColor: C.blue,
          borderWidth: rows.map(function (r) { return partial(r) ? 2 : 0; }),
          barPercentage: 0.85, categoryPercentage: 1
        }]
      },
      options: o
    });
  }

  // The gauges on a real map. Leaflet is vendored next to Chart.js; tiles come
  // from OpenStreetMap at view time. Circle markers rather than the default
  // pins, so no image assets are needed. Each marker links to its gauge card.
  function gaugeMap(el, stations, opts) {
    if (!window.L || !el || !stations || !stations.length) return null;
    opts = opts || {};
    var map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    var pts = [];
    stations.forEach(function (st) {
      if (!isFinite(st.lat) || !isFinite(st.lon)) return;
      var colour = st.measure === 'flow' ? C.green : C.blue;
      var m = L.circleMarker([st.lat, st.lon], {
        radius: 7, color: '#fff', weight: 2, fillColor: colour, fillOpacity: 0.95
      }).addTo(map);
      var line = '<strong>' + st.name + '</strong><br>' + st.label + (st.reading ? '<br>' + st.reading : '');
      m.bindTooltip(line, { direction: 'top', offset: [0, -8] });
      if (st.href) m.on('click', function () { window.location.href = st.href; });
      pts.push([st.lat, st.lon]);
    });
    if (pts.length) map.fitBounds(pts, { padding: [28, 28], maxZoom: opts.maxZoom || 11 });
    return map;
  }

  function tempAllYears(canvas, all, current) {
    var ds = all.series.map(function (entry) {
      var year = entry[0];
      var isCur = year === all.meta.currentYear;
      var isPrev = year === all.meta.currentYear - 1;
      return {
        label: String(year),
        data: entry[1].map(function (p) { return { x: p[0], y: p[1] }; }),
        borderColor: isCur ? C.blue : isPrev ? C.red : C.grey,
        borderWidth: isCur ? 2.5 : isPrev ? 1.8 : 0.8,
        pointRadius: 0, fill: false, tension: 0.3,
        order: isCur ? 0 : isPrev ? 1 : 2
      };
    }).sort(function (a, b) { return b.order - a.order; });

    var ys = [];
    all.series.forEach(function (e) { e[1].forEach(function (p) { if (p[1] !== null) ys.push(p[1]); }); });
    var bounds = pad(ys, [], 0.04, 0.5);
    var o = baseOptions({
      xMin: 1, xMax: 366, yMin: bounds.min, yMax: bounds.max, yHard: true,
      yLabel: '°C', yFormat: 'f1', unit: '°C',
      xTick: function (v) { return dayOfYearLabel(v); },
      tipTitle: function (item) { return dayOfYearLabel(item.parsed.x); }
    });
    o.interaction = { mode: 'nearest', intersect: false };
    return new Chart(canvas, { type: 'line', data: { datasets: ds }, options: o });
  }

  function tempAnomaly(canvas, payload) {
    var pts = payload.anomaly.filter(function (p) { return p[1] !== null; });
    var o = baseOptions({
      xMin: 1, xMax: Math.max(payload.latest.dayOfYear, 2),
      yLabel: '°C vs median', yFormat: 'signed1', unit: '°C',
      xTick: function (v) { return dayOfYearLabel(v); },
      tipTitle: function (item) { return dayOfYearLabel(item.parsed.x); }
    });
    o.scales.y.grid.color = function (ctx) { return ctx.tick.value === 0 ? C.axis : C.grid; };
    return new Chart(canvas, {
      type: 'bar',
      data: {
        datasets: [{
          label: 'Anomaly',
          data: pts.map(function (p) { return { x: p[0], y: p[1] }; }),
          backgroundColor: pts.map(function (p) { return p[1] >= 0 ? C.orange : C.blue; }),
          barPercentage: 1, categoryPercentage: 1
        }]
      },
      options: o
    });
  }

  // Matches withDayOfYear() in payloads.mjs so the browser indexes the envelope
  // exactly as the generator built it.
  function dayOfYear(iso) {
    var y = parseInt(iso.substring(0, 4), 10);
    return Math.floor((Date.parse(iso + 'T00:00:00Z') - Date.UTC(y, 0, 1)) / 86400000) + 1;
  }

  function daysApart(a, b) {
    return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
  }

  // Trailing window by calendar date. Taking the last N rows instead would
  // reach across any hole in the record — the level cache still carries a
  // 158-day one — and silently mislabel the axis.
  function windowByDate(rows, days) {
    if (rows.length === 0 || days >= 9999) return rows;
    var last = rows[rows.length - 1][0];
    return rows.filter(function (r) { return daysApart(r[0], last) < days; });
  }

  // Insert a null row wherever the record skips more than a couple of days, so
  // the line breaks there instead of drawing a straight edge across missing
  // data and implying readings nobody took.
  function breakGaps(rows, maxGap) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (i > 0 && daysApart(rows[i - 1][0], rows[i][0]) > (maxGap || 2)) out.push([null, null]);
      out.push(rows[i]);
    }
    return out;
  }

  // Dated series (level / flow). x is an index into `labels` so gaps in the
  // record stay visible as gaps rather than being interpolated away.
  //
  // Only the recent years ship at daily resolution; the deep archive comes as
  // monthly means, so the whole-record view reads from that instead. Both are
  // dated series, so the same drawing code handles them.
  function datedSeries(canvas, station, days, refLine) {
    var monthly = days >= 9999 && station.monthly && station.monthly.length > 0;
    // Monthly rows are [date, mean, min, max, n] — carry the whole row through
    // so the within-month range can be drawn, then split it out below.
    var source = monthly ? station.monthly : station.series;
    // A monthly series steps ~30 days at a time; the daily gap rule would break
    // it at every point.
    var rows = monthly ? breakGaps(source, 62) : breakGaps(windowByDate(source, days));
    var labels = rows.map(function (r) { return r[0]; });
    var values = rows.map(function (r) { return r[1]; });
    var lows = monthly ? rows.map(function (r) { return r[0] === null ? null : r[2]; }) : null;
    var highs = monthly ? rows.map(function (r) { return r[0] === null ? null : r[3]; }) : null;
    // Include the band in the axis window so it is not clipped, but only the
    // middle half — the all-time record range for a date can be far wider than
    // a 90-day window and would squash the actual readings to a flat line.
    var bandVals = [];
    if (!monthly && station.normal && station.normal.envelope) {
      var e = station.normal.envelope;
      labels.forEach(function (d) {
        if (!d) return;
        var row = e[dayOfYear(d) - 1];
        if (row) { bandVals.push(row[2], row[4]); }
      });
    }
    var b = pad(values.concat(lows || [], highs || [], bandVals),
      refLine === null || refLine === undefined ? [] : [refLine],
      0.15, station.decimals === 3 ? 0.01 : 0.1);
    // Discharge cannot go negative, and Port Sydney's record runs to 0.0 m³/s,
    // so padding below the minimum put a quarter of the plot below zero on
    // values that cannot exist. Only bites series that approach zero: a lake
    // level near 225 m is nowhere near the floor.
    var observed = values.concat(lows || []).filter(function (v) {
      return v !== null && v !== undefined && isFinite(v);
    });
    if (observed.length && Math.min.apply(null, observed) >= 0 && b.min < 0) b.min = 0;

    var ds = [];

    // "Normal for this date": the day-of-year envelope shaded behind the line,
    // so the whole window reads against normal rather than only today's number
    // doing so. Daily views only — the monthly view already carries its own
    // within-month range band, and stacking the two would be unreadable.
    if (!monthly && station.normal && station.normal.envelope) {
      var env = station.normal.envelope;
      var at = function (i, col) {
        if (!labels[i]) return null;
        var row = env[dayOfYear(labels[i]) - 1];
        return row ? row[col] : null;
      };
      var band = function (label, col, fillTo, colour) {
        return {
          label: label,
          data: labels.map(function (_, i) { return { x: i, y: at(i, col) }; }),
          borderWidth: 0, pointRadius: 0, tension: 0.25, spanGaps: false,
          fill: fillTo, backgroundColor: colour
        };
      };
      ds.push(band('Record low for date', 1, false));
      ds.push(band('Record range', 5, '-1', C.band));
      ds.push(band('25th pct', 2, false));
      ds.push(band('Middle half', 4, '-1', C.bandInner));
      ds.push({
        label: 'Normal', data: labels.map(function (_, i) { return { x: i, y: at(i, 3) }; }),
        borderColor: C.muted, borderWidth: 1, borderDash: [4, 3],
        pointRadius: 0, fill: false, tension: 0.25, spanGaps: false
      });
    }

    // Monthly means alone flatten the thing worth seeing: a flood or a drawdown
    // is a month whose RANGE blew out, not one whose average moved much. Draw
    // the min-max envelope behind the mean, as a paired fill like the
    // temperature climatology bands.
    if (monthly) {
      ds.push({
        label: 'Monthly low', data: lows.map(function (v, i) { return { x: i, y: v }; }),
        borderWidth: 0, pointRadius: 0, fill: false, tension: 0.25, spanGaps: false
      });
      ds.push({
        label: 'Monthly range', data: highs.map(function (v, i) { return { x: i, y: v }; }),
        borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: C.band,
        tension: 0.25, spanGaps: false
      });
    }

    ds.push({
      label: monthly ? 'Monthly mean' : station.name,
      data: values.map(function (v, i) { return { x: i, y: v }; }),
      borderColor: C.blue, backgroundColor: C.blueSoft,
      borderWidth: 2, tension: 0.25, spanGaps: false,
      fill: (monthly || (station.normal && station.normal.envelope)) ? false : 'start',
      pointRadius: values.map(function (v, i) { return (v !== null && i === values.length - 1) ? 4 : 0; }),
      pointBackgroundColor: C.orange, pointBorderColor: '#fff', pointBorderWidth: 1.5
    });
    if (refLine !== null && refLine !== undefined) {
      ds.push({
        label: 'July average',
        data: values.map(function (v, i) { return { x: i, y: v === null ? null : refLine }; }),
        borderColor: C.green, borderWidth: 1.5, borderDash: [5, 4],
        pointRadius: 0, fill: false, spanGaps: false
      });
    }
    return new Chart(canvas, {
      type: 'line',
      data: { datasets: ds },
      // Hard bounds, not suggestions. The bounds above deliberately leave the
      // full-range band out so a record flood cannot squash three months of
      // readings into a flat line — but a suggested axis grows to fit every
      // dataset drawn, band included, and that is exactly what the flow charts
      // did. Clipping the band at the top is the intended result.
      options: baseOptions({
        xMin: 0, xMax: values.length - 1, yMin: b.min, yMax: b.max, yHard: true,
        yLabel: station.unit, yFormat: station.format, unit: station.unit,
        xTick: function (v) {
          if (!labels[v]) return '';
          return monthly ? monthLabel(labels[v]) : shortDate(labels[v]);
        },
        tipTitle: function (item) {
          var d = labels[item.parsed.x];
          if (!d) return '';
          return monthly ? monthLabel(d, true) : longDate(d);
        }
      })
    });
  }

  // The one chart where stations share an axis — only legal because the values
  // are inches from each station's own July mean, not raw gauge readings on
  // five different datums.
  function comparison(canvas, cmp, days, measure) {
    var rows = breakGaps(windowByDate(cmp.series, days));
    var labels = rows.map(function (r) { return r[0]; });
    var palette = [C.blue, C.orange, C.green, C.red, '#7B5EA7'];
    var ds = cmp.stations.map(function (st, i) {
      return {
        label: st.name,
        data: rows.map(function (r, j) { return { x: j, y: r[0] === null ? null : r[i + 1] }; }),
        borderColor: palette[i % palette.length],
        borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0.25, spanGaps: false
      };
    });
    // Flow is normalised as a ratio, so its baseline is 100% rather than 0.
    var isFlow = measure === 'flow';
    var baseline = isFlow ? 100 : 0;
    var o = baseOptions({
      xMin: 0, xMax: rows.length - 1,
      yLabel: isFlow ? '% of July average' : 'inches vs July avg',
      yFormat: isFlow ? 'f0' : 'signed1',
      unit: isFlow ? '%' : 'in',
      xTick: function (v) { return labels[v] ? shortDate(labels[v]) : ''; },
      tipTitle: function (item) { return labels[item.parsed.x] ? longDate(labels[item.parsed.x]) : ''; }
    });
    o.scales.y.grid.color = function (ctx) { return ctx.tick.value === baseline ? C.axis : C.grid; };
    return new Chart(canvas, { type: 'line', data: { datasets: ds }, options: o });
  }

  // ── wiring ──

  function toggleGroup(el, onPick) {
    if (!el) return;
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-value]');
      if (!btn) return;
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      onPick(btn.dataset.value, btn);
    });
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.json();
    });
  }

  window.Muskoka = {
    fmt: fmt, ordinal: ordinal, shortDate: shortDate, longDate: longDate,
    dayOfYearLabel: dayOfYearLabel, dayOfYearOf: dayOfYear, renderDist: renderDist,
    charts: {
      seasonal: seasonal, seasonalFromStation: seasonalFromStation,
      tempClimatology: tempClimatology, tempAllYears: tempAllYears,
      tempAnomaly: tempAnomaly, datedSeries: datedSeries, comparison: comparison,
      yearBars: yearBars
    },
    gaugeMap: gaugeMap,
    toggleGroup: toggleGroup, getJSON: getJSON
  };
})();
