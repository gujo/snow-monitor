#!/usr/bin/env node
// Snow Monitor - Data Fetcher
// Fetches weather + lift/piste data and generates a compact static page

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const resorts = JSON.parse(fs.readFileSync(path.join(__dirname, 'resorts.json'), 'utf8'));

function fetch(url) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SnowMonitor/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(data);
      });
    }).on('error', reject);
  });
}

async function fetchOpenMeteo(resort) {
  const results = {};
  for (const [station, elev] of Object.entries(resort.elevations)) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${resort.lat}&longitude=${resort.lon}&elevation=${elev}&current=temperature_2m,apparent_temperature,snowfall,snow_depth,weather_code,wind_speed_10m,wind_gusts_10m&daily=snowfall_sum&timezone=Europe/Rome&past_days=3&forecast_days=7`;
    try {
      const raw = await fetch(url);
      results[station] = JSON.parse(raw);
    } catch (e) {
      console.error(`  Failed ${station}: ${e.message}`);
      results[station] = null;
    }
  }
  return results;
}

async function fetchLiftPisteData(resort) {
  const result = { liftsOpen: null, liftsTotal: null, runsOpen: null, runsTotal: null, kmOpen: null, baseDepth: null, summitDepth: null, condition: null };
  try {
    const html = await fetch(resort.onTheSnowUrl);
    // Parse key stats from the text
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    let m;
    m = text.match(/Lifts\s*Open\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) { result.liftsOpen = parseInt(m[1]); result.liftsTotal = parseInt(m[2]); }

    m = text.match(/Runs\s*Open\s*(\d+)\s*\/\s*(\d+)/i);
    if (m) { result.runsOpen = parseInt(m[1]); result.runsTotal = parseInt(m[2]); }

    m = text.match(/(\d+)\s*km\s*open/i);
    if (m) result.kmOpen = parseInt(m[1]);

    // Snow depths
    m = text.match(/Base\s*(\d+)\s*cm/i);
    if (m) result.baseDepth = parseInt(m[1]);
    m = text.match(/Summit\s*(\d+)\s*cm/i);
    if (m) result.summitDepth = parseInt(m[1]);

    // Condition — look near Base/Summit context
    m = text.match(/(?:Base|Summit)\s*\d+\s*cm\s*(Machine Groomed|Powder|Packed Powder|Spring Conditions|Hard Pack|Icy|Variable|Frozen Granular)/i);
    if (m) result.condition = m[1];

  } catch (e) {
    console.error(`  Lift data failed: ${e.message}`);
  }
  return result;
}

async function fetchLiftSchedule(resort) {
  if (!resort.liftScheduleUrl) return { hours: {}, generalOpen: null, generalClose: null };
  try {
    const html = await fetch(resort.liftScheduleUrl);
    // Structure: <p>..LiftName (N)..</p> followed by <ul><li>HH.MM – HH.MM ..</li>..</ul>
    const blockRe = /<p[^>]*>(.*?)<\/p>\s*<ul[^>]*>(.*?)<\/ul>/gis;
    const liftTypeRe = /^(?:Gondola|Chairlift|Funicular|Funifor|Cableway|Tapis(?:\s+Roulant?)?)\s+/i;
    const timeRe = /(\d+)[.:](\d+)\s*[–\-]\s*(\d+)[.:](\d+)/;
    const hours = {};
    let earliest = null, latest = null;
    let m;
    while ((m = blockRe.exec(html)) !== null) {
      const pText = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const ulText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!liftTypeRe.test(pText)) continue;
      const timeMatch = ulText.match(timeRe);
      if (!timeMatch) continue;
      const name = pText.replace(liftTypeRe, '').replace(/\s*\([\d,\-\s]+\).*/, '').trim().toUpperCase();
      const oH = parseInt(timeMatch[1]), oM = parseInt(timeMatch[2]);
      const cH = parseInt(timeMatch[3]), cM = parseInt(timeMatch[4]);
      hours[name] = { open: `${oH}:${oM.toString().padStart(2,'0')}`, close: `${cH}:${cM.toString().padStart(2,'0')}` };
      const oMins = oH * 60 + oM, cMins = cH * 60 + cM;
      if (earliest === null || oMins < earliest) earliest = oMins;
      if (latest === null || cMins > latest) latest = cMins;
    }
    const toTime = mins => `${Math.floor(mins/60)}:${(mins%60).toString().padStart(2,'0')}`;
    return { hours, generalOpen: earliest !== null ? toTime(earliest) : null, generalClose: latest !== null ? toTime(latest) : null };
  } catch (e) {
    console.error(`  Schedule failed: ${e.message}`);
    return { hours: {}, generalOpen: null, generalClose: null };
  }
}

function matchLiftHours(liftName, hours) {
  const name = liftName.toUpperCase().replace(/\s+/g, ' ');
  if (hours[name]) return hours[name];
  // Try key-contains or name-contains
  for (const [key, val] of Object.entries(hours)) {
    if (name === key || name.includes(key) || key.includes(name)) return val;
  }
  // Word overlap (≥2 meaningful words)
  const nameWords = name.split(/[\s\-]+/).filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const [key, val] of Object.entries(hours)) {
    const keyWords = key.split(/[\s\-]+/).filter(w => w.length > 2);
    const overlap = nameWords.filter(w => keyWords.includes(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = val; }
  }
  return bestScore >= 2 ? best : null;
}

async function fetchSkiramaData(resort) {
  if (!resort.skiramaUrl) return { lifts: [], pistes: [] };
  try {
    const html = await fetch(resort.skiramaUrl);
    const pattern = /data-x='[^']*'\s+data-y='[^']*'\s+data-status='([^']+)'\s+data-type='([^']+)'\s+title='([^']+)'/g;
    const lifts = [], pistes = [];
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const [, status, type, name] = m;
      const entry = { name, status }; // status: open | closed | evaluating
      if (type === 'lift') lifts.push(entry);
      else if (type === 'slope') pistes.push(entry);
    }
    return { lifts, pistes };
  } catch (e) {
    console.error(`  Skirama data failed: ${e.message}`);
    return { lifts: [], pistes: [] };
  }
}

function weatherDesc(code) {
  const map = {
    0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'],
    3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
    51: ['Light drizzle', '🌧️'], 53: ['Drizzle', '🌧️'], 55: ['Heavy drizzle', '🌧️'],
    56: ['Freezing drizzle', '🧊'], 57: ['Heavy freezing drizzle', '🧊'],
    61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🧊'], 67: ['Heavy freezing rain', '🧊'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
    77: ['Snow grains', '❄️'], 80: ['Light showers', '🌦️'], 81: ['Showers', '🌦️'],
    82: ['Heavy showers', '🌦️'], 85: ['Snow showers', '🌨️'],
    86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'],
    96: ['T-storm + hail', '⛈️'], 99: ['T-storm + hail', '⛈️']
  };
  return map[code] || ['Unknown', '❓'];
}

function generateHTML(allData, timestamp) {
  const now = new Date(timestamp);
  const timeStr = now.toLocaleString('en-GB', { timeZone: 'Europe/Rome', dateStyle: 'medium', timeStyle: 'short' });

  let resortCards = '';

  for (const { resort, weather, lifts, skirama, avalanche, schedule } of allData) {
    // Station rows - compact
    let stationRows = '';
    for (const station of ['top', 'mid', 'bottom']) {
      const d = weather[station];
      if (!d || !d.current) continue;
      const c = d.current;
      const [desc, emoji] = weatherDesc(c.weather_code);
      const snowCm = c.snow_depth ? Math.round(c.snow_depth * 100) : 0;
      const label = station === 'top' ? '⛰️ Top' : station === 'mid' ? '🏔️ Mid' : '🏠 Base';
      stationRows += `
        <div class="station">
          <div class="st-label">${label}<span class="elev">${resort.elevations[station]}m</span></div>
          <div class="st-temp">${c.temperature_2m}°</div>
          <div class="st-weather">${emoji}</div>
          <div class="st-snow">${snowCm}cm</div>
          <div class="st-wind">${c.wind_speed_10m}<span class="unit">km/h</span></div>
        </div>`;
    }

    // Lift/piste status — removed; info shown in foldable detail sections below

    // Expandable lift and piste details
    let detailSections = '';
    if (skirama && (skirama.lifts.length > 0 || skirama.pistes.length > 0)) {
      const statusBadge = (s) =>
        s === 'open' ? '<span class="badge open">●</span>' :
        s === 'evaluating' ? '<span class="badge eval">●</span>' :
        '<span class="badge closed">●</span>';

      const liftRows = skirama.lifts.map(l => {
        const h = schedule ? matchLiftHours(l.name, schedule.hours) : null;
        const timeStr = h ? `<span class="detail-time">${h.open}–${h.close}</span>` : '';
        return `<div class="detail-row">${statusBadge(l.status)}<span class="detail-name">${l.name}</span>${timeStr}</div>`;
      }).join('');

      const pisteRows = skirama.pistes.map(p =>
        `<div class="detail-row">${statusBadge(p.status)}<span class="detail-name">${p.name}</span></div>`
      ).join('');

      const openLifts = skirama.lifts.filter(l => l.status === 'open').length;
      const openPistes = skirama.pistes.filter(p => p.status === 'open').length;

      detailSections = `
        <details class="detail-section">
          <summary>🚡 Lifts <span class="detail-count">${openLifts}/${skirama.lifts.length} open</span></summary>
          <div class="detail-list">${liftRows}</div>
        </details>
        <details class="detail-section">
          <summary>⛷️ Pistes <span class="detail-count">${openPistes}/${skirama.pistes.length} open</span></summary>
          <div class="detail-list">${pisteRows}</div>
        </details>`;
    }

    // Snow depths from OnTheSnow (more accurate than Open-Meteo for resort-reported)
    let snowInfo = '';
    if (lifts.baseDepth !== null || lifts.summitDepth !== null) {
      snowInfo = `
        <div class="snow-report">
          ${lifts.summitDepth !== null ? `<div class="snow-stat"><span class="snow-val">${lifts.summitDepth}cm</span><span class="snow-lbl">Summit</span></div>` : ''}
          ${lifts.baseDepth !== null ? `<div class="snow-stat"><span class="snow-val">${lifts.baseDepth}cm</span><span class="snow-lbl">Base</span></div>` : ''}
          ${lifts.condition ? `<div class="snow-stat"><span class="snow-val cond">${lifts.condition}</span><span class="snow-lbl">Condition</span></div>` : ''}
        </div>`;
    }

    // Fresh snow (last 3 days) & forecast (next 3 & 7 days) — use top elevation
    let snowForecastInfo = '';
    const topW = weather['top'];
    if (topW && topW.daily && topW.daily.snowfall_sum && topW.daily.time) {
      const times = topW.daily.time;
      const snows = topW.daily.snowfall_sum;
      const today = new Date().toISOString().slice(0, 10);
      const todayIdx = times.indexOf(today);
      // Past 3 days: indices before today
      let fresh3 = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] < today) fresh3 += (snows[i] || 0);
      }
      // Next 3 days & 7 days (including today)
      let next3 = 0, next7 = 0;
      let futureCount = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] >= today) {
          next7 += (snows[i] || 0);
          if (futureCount < 3) next3 += (snows[i] || 0);
          futureCount++;
        }
      }
      snowForecastInfo = '<div class="snow-forecast">' +
          '<div class="sf-item"><span class="sf-val">' + fresh3.toFixed(1) + 'cm</span><span class="sf-lbl">Fresh (3d)</span></div>' +
          '<div class="sf-item"><span class="sf-val">' + next3.toFixed(1) + 'cm</span><span class="sf-lbl">Next 3d</span></div>' +
          '<div class="sf-item"><span class="sf-val">' + next7.toFixed(1) + 'cm</span><span class="sf-lbl">Next 7d</span></div>' +
        '</div>';
    }

    // Avalanche risk
    let avalancheInfo = '';
    if (avalanche) {
      avalancheInfo = `
        <div class="avy-bar" style="border-left:3px solid ${avalanche.color}">
          <span class="avy-emoji">${avalanche.emoji}</span>
          <span class="avy-level">Avalanche Risk: <strong>${avalanche.label}</strong> (${avalanche.level}/5)</span>
          <a href="${avalanche.url}" class="avy-link" target="_blank">↗</a>
        </div>`;
    }

    // Resort operating hours
    let hoursBar = '';
    if (schedule && schedule.generalOpen && schedule.generalClose) {
      hoursBar = `
        <div class="hours-bar">
          <span class="hours-icon">🕐</span>
          <span class="hours-text">Lifts open <strong>${schedule.generalOpen}</strong> – <strong>${schedule.generalClose}</strong></span>
        </div>`;
    }

    resortCards += `
      <div class="card">
        <div class="card-header">
          <h2>${resort.name}</h2>
          <span class="area">${resort.area}</span>
        </div>
        ${avalancheInfo}
        ${hoursBar}
        ${snowForecastInfo}
        ${detailSections}
        ${snowInfo}
        <div class="stations">${stationRows}</div>
        <div class="stations-legend">
          <span></span><span>Temp</span><span></span><span>Snow</span><span>Wind</span>
        </div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0d1520">
<title>Snow Monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro',system-ui,sans-serif;background:#0d1520;color:#d8e3f0;-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) 12px 20px}
.wrap{max-width:420px;margin:0 auto}
header{text-align:center;padding:16px 0 12px}
header h1{font-size:1.3em;color:#7ec8f0;letter-spacing:-.5px}
header h1::before{content:'🏔️ '}
.updated{color:#5a6a7a;font-size:.72em;margin-top:2px}

.card{background:#151f2e;border-radius:14px;padding:16px;margin-bottom:14px;border:1px solid #1e2d3d}
.card-header{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.card-header h2{font-size:1.15em;color:#e8f0f8}
.area{color:#5a7a8a;font-size:.7em}

.lift-grid{display:flex;gap:12px;margin-bottom:14px}
.lift-stat{flex:1;text-align:center}
.lift-num{font-size:1.4em;font-weight:700;color:#fff}
.lift-total{font-size:.6em;color:#5a7a8a;font-weight:400}
.lift-label{font-size:.65em;color:#5a7a8a;text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.lift-bar{height:4px;background:#1a2a3a;border-radius:2px;margin-top:4px;overflow:hidden}
.lift-fill{height:100%;background:#4ecdc4;border-radius:2px;transition:width .3s}
.piste-fill{background:#7eb8da}

.snow-forecast{display:flex;gap:8px;margin-bottom:14px;padding:10px 12px;background:#0d1a28;border-radius:10px}
.sf-item{flex:1;text-align:center}
.sf-val{display:block;font-size:1.2em;font-weight:700;color:#b3e5fc}
.sf-lbl{font-size:.6em;color:#5a7a8a;text-transform:uppercase;letter-spacing:.5px}

.snow-report{display:flex;gap:12px;margin-bottom:14px;padding:10px 12px;background:#0d1a28;border-radius:10px}
.snow-stat{flex:1;text-align:center}
.snow-val{display:block;font-size:1.2em;font-weight:700;color:#81d4fa}
.snow-val.cond{font-size:.8em;color:#aed581}
.snow-lbl{font-size:.6em;color:#5a7a8a;text-transform:uppercase;letter-spacing:.5px}

.stations{display:flex;flex-direction:column;gap:1px}
.station{display:grid;grid-template-columns:1fr 50px 28px 44px 50px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.station:last-child{border:none}
.st-label{font-size:.82em;font-weight:600}
.elev{display:block;font-size:.72em;color:#5a7a8a;font-weight:400}
.st-temp{font-size:.95em;font-weight:600;text-align:right}
.st-weather{text-align:center;font-size:1.1em}
.st-snow{font-size:.9em;font-weight:700;color:#81d4fa;text-align:right}
.st-wind{font-size:.8em;text-align:right;color:#8899aa}
.unit{font-size:.7em;color:#5a7a8a}

.stations-legend{display:grid;grid-template-columns:1fr 50px 28px 44px 50px;padding:4px 0 0;font-size:.55em;color:#3a4a5a;text-transform:uppercase;letter-spacing:.5px}
.stations-legend span:nth-child(2),.stations-legend span:nth-child(4),.stations-legend span:nth-child(5){text-align:right}

.avy-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0d1a28;border-radius:8px;margin-bottom:8px;font-size:.82em}
.avy-emoji{font-size:1.1em}
.avy-level{flex:1}
.avy-level strong{color:#e8f0f8}
.avy-link{color:#4a6a8a;font-size:.9em;text-decoration:none}

.hours-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;background:#0d1a28;border-radius:8px;margin-bottom:12px;font-size:.82em;border-left:3px solid #2a6a8a}
.hours-icon{font-size:1em}
.hours-text{color:#8ab8d0}
.hours-text strong{color:#b3e5fc}

.detail-time{margin-left:auto;font-size:.8em;color:#5a8aaa;white-space:nowrap;font-variant-numeric:tabular-nums}

footer{text-align:center;color:#2a3a4a;font-size:.6em;padding:8px 0}
footer a{color:#3a6a8a}

.detail-section{margin-bottom:8px;border-radius:8px;background:#0d1a28;overflow:hidden}
.detail-section summary{display:flex;align-items:center;justify-content:space-between;padding:11px 12px;font-size:.95em;font-weight:600;cursor:pointer;list-style:none;user-select:none;color:#c8d8e8}
.detail-section summary::-webkit-details-marker{display:none}
.detail-section summary::before{content:'▶';font-size:.65em;margin-right:8px;transition:transform .2s;color:#5a7a8a}
.detail-section[open] summary::before{transform:rotate(90deg)}
.detail-count{font-size:.85em;color:#5a7a8a;font-weight:400;margin-left:4px}
.detail-list{padding:4px 12px 10px}
.detail-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.9em}
.detail-row:last-child{border:none}
.badge{font-size:1.2em;flex-shrink:0}
.badge.open{color:#4ecdc4}
.badge.closed{color:#e05a5a}
.badge.eval{color:#f0a040}
.detail-name{color:#9ab0c0;text-transform:capitalize;font-size:.95em}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Snow Monitor</h1>
    <p class="updated">${timeStr} CET</p>
  </header>
  ${resortCards}
  <footer>Data: <a href="https://open-meteo.com">Open-Meteo</a> · <a href="https://www.onthesnow.co.uk">OnTheSnow</a> · Updated every 15 min</footer>
</div>
</body>
</html>`;
}

async function fetchAvalancheData() {
  try {
    // Fetch EUREGIO bulletin (covers Tyrol-Trentino region, nearest reliable data for western Alps)
    const raw = await fetch('https://static.avalanche.report/bulletins/latest/EUREGIO_en_CAAMLv6.json');
    const data = JSON.parse(raw);
    // Get highest danger level across all bulletins
    let maxDanger = 'low';
    let maxLevel = 1;
    const dangerMap = { low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5 };
    const labelMap = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Very High' };
    const colorMap = { 1: '#4CAF50', 2: '#FFEB3B', 3: '#FF9800', 4: '#F44336', 5: '#000' };
    const emojiMap = { 1: '🟢', 2: '🟡', 3: '🟠', 4: '🔴', 5: '⚫' };

    for (const b of (data.bulletins || [])) {
      for (const r of (b.dangerRatings || [])) {
        const level = dangerMap[r.mainValue] || 1;
        if (level > maxLevel) { maxLevel = level; maxDanger = r.mainValue; }
      }
    }
    const validTime = data.bulletins?.[0]?.validTime;
    return {
      level: maxLevel,
      label: labelMap[maxLevel],
      color: colorMap[maxLevel],
      emoji: emojiMap[maxLevel],
      validFrom: validTime?.startTime,
      validTo: validTime?.endTime,
      source: 'EUREGIO (Tyrol-Trentino)',
      url: 'https://avalanche.report'
    };
  } catch (e) {
    console.error(`  Avalanche data failed: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('Fetching snow data...');
  const allData = [];

  const avalanche = await fetchAvalancheData();
  console.log(`  Avalanche: ${avalanche ? avalanche.label : 'N/A'}`);

  for (const resort of resorts) {
    console.log(`  ${resort.name}...`);
    const weather = await fetchOpenMeteo(resort);
    const lifts = await fetchLiftPisteData(resort);
    const skirama = await fetchSkiramaData(resort);
    const schedule = await fetchLiftSchedule(resort);
    console.log(`  Lifts: ${skirama.lifts.length}, Pistes: ${skirama.pistes.length}, Schedule: ${Object.keys(schedule.hours).length} entries`);
    allData.push({ resort, weather, lifts, skirama, avalanche, schedule });
  }

  const timestamp = new Date().toISOString();
  const html = generateHTML(allData, timestamp);

  const outDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify({ timestamp, resorts: allData }, null, 2));

  console.log(`Done! ${timestamp}`);
}

main().catch(e => { console.error(e); process.exit(1); });
