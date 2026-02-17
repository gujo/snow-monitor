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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${resort.lat}&longitude=${resort.lon}&elevation=${elev}&current=temperature_2m,apparent_temperature,snowfall,snow_depth,weather_code,wind_speed_10m,wind_gusts_10m&timezone=Europe/Rome&forecast_days=1`;
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

  for (const { resort, weather, lifts } of allData) {
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
          <div class="st-temp">${c.temperature_2m}°<span class="feels">${c.apparent_temperature}°</span></div>
          <div class="st-weather">${emoji}</div>
          <div class="st-snow">${snowCm}cm</div>
          <div class="st-wind">${c.wind_speed_10m}<span class="unit">km/h</span></div>
        </div>`;
    }

    // Lift/piste status
    let liftInfo = '';
    if (lifts.liftsOpen !== null) {
      const liftPct = Math.round(lifts.liftsOpen / lifts.liftsTotal * 100);
      const runPct = lifts.runsOpen !== null ? Math.round(lifts.runsOpen / lifts.runsTotal * 100) : null;
      liftInfo = `
        <div class="lift-grid">
          <div class="lift-stat">
            <div class="lift-num">${lifts.liftsOpen}<span class="lift-total">/${lifts.liftsTotal}</span></div>
            <div class="lift-label">Lifts</div>
            <div class="lift-bar"><div class="lift-fill" style="width:${liftPct}%"></div></div>
          </div>
          ${lifts.runsOpen !== null ? `
          <div class="lift-stat">
            <div class="lift-num">${lifts.runsOpen}<span class="lift-total">/${lifts.runsTotal}</span></div>
            <div class="lift-label">Pistes</div>
            <div class="lift-bar"><div class="lift-fill piste-fill" style="width:${runPct}%"></div></div>
          </div>` : ''}
          ${lifts.kmOpen !== null ? `
          <div class="lift-stat">
            <div class="lift-num">${lifts.kmOpen}<span class="lift-total">km</span></div>
            <div class="lift-label">Open</div>
          </div>` : ''}
        </div>`;
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

    resortCards += `
      <div class="card">
        <div class="card-header">
          <h2>${resort.name}</h2>
          <span class="area">${resort.area}</span>
        </div>
        ${liftInfo}
        ${snowInfo}
        <div class="stations">${stationRows}</div>
        <div class="stations-legend">
          <span>Temp</span><span>Feels</span><span></span><span>Snow</span><span>Wind</span>
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

.snow-report{display:flex;gap:12px;margin-bottom:14px;padding:10px 12px;background:#0d1a28;border-radius:10px}
.snow-stat{flex:1;text-align:center}
.snow-val{display:block;font-size:1.2em;font-weight:700;color:#81d4fa}
.snow-val.cond{font-size:.8em;color:#aed581}
.snow-lbl{font-size:.6em;color:#5a7a8a;text-transform:uppercase;letter-spacing:.5px}

.stations{display:flex;flex-direction:column;gap:1px}
.station{display:grid;grid-template-columns:1fr 60px 28px 44px 50px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.station:last-child{border:none}
.st-label{font-size:.82em;font-weight:600}
.elev{display:block;font-size:.72em;color:#5a7a8a;font-weight:400}
.st-temp{font-size:.95em;font-weight:600;text-align:right}
.feels{display:block;font-size:.7em;color:#5a7a8a;font-weight:400}
.st-weather{text-align:center;font-size:1.1em}
.st-snow{font-size:.9em;font-weight:700;color:#81d4fa;text-align:right}
.st-wind{font-size:.8em;text-align:right;color:#8899aa}
.unit{font-size:.7em;color:#5a7a8a}

.stations-legend{display:grid;grid-template-columns:1fr 60px 28px 44px 50px;padding:4px 0 0;font-size:.55em;color:#3a4a5a;text-transform:uppercase;letter-spacing:.5px}
.stations-legend span:nth-child(2),.stations-legend span:nth-child(4),.stations-legend span:nth-child(5){text-align:right}

footer{text-align:center;color:#2a3a4a;font-size:.6em;padding:8px 0}
footer a{color:#3a6a8a}
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

async function main() {
  console.log('Fetching snow data...');
  const allData = [];

  for (const resort of resorts) {
    console.log(`  ${resort.name}...`);
    const weather = await fetchOpenMeteo(resort);
    const lifts = await fetchLiftPisteData(resort);
    allData.push({ resort, weather, lifts });
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
