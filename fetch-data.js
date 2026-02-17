#!/usr/bin/env node
// Snow Monitor - Data Fetcher
// Fetches weather data from Open-Meteo and generates static HTML

const fs = require('fs');
const path = require('path');
const https = require('https');

const resorts = JSON.parse(fs.readFileSync(path.join(__dirname, 'resorts.json'), 'utf8'));

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SnowMonitor/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        else resolve(data);
      });
    }).on('error', reject);
  });
}

async function fetchOpenMeteo(resort) {
  const results = {};
  for (const [station, elev] of Object.entries(resort.elevations)) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${resort.lat}&longitude=${resort.lon}&elevation=${elev}&current=temperature_2m,apparent_temperature,snowfall,snow_depth,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m&hourly=temperature_2m,snowfall,snow_depth,weather_code&daily=temperature_2m_max,temperature_2m_min,snowfall_sum,weather_code&timezone=Europe/Rome&forecast_days=3`;
    try {
      const raw = await fetch(url);
      results[station] = JSON.parse(raw);
    } catch (e) {
      console.error(`Failed to fetch ${station} for ${resort.name}: ${e.message}`);
      results[station] = null;
    }
  }
  return results;
}

// WMO weather codes to descriptions and emoji
function weatherDesc(code) {
  const map = {
    0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'],
    3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
    51: ['Light drizzle', '🌧️'], 53: ['Drizzle', '🌧️'], 55: ['Heavy drizzle', '🌧️'],
    56: ['Freezing drizzle', '🌧️❄️'], 57: ['Heavy freezing drizzle', '🌧️❄️'],
    61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️❄️'], 67: ['Heavy freezing rain', '🌧️❄️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
    77: ['Snow grains', '❄️'], 80: ['Light showers', '🌦️'], 81: ['Showers', '🌦️'],
    82: ['Heavy showers', '🌦️'], 85: ['Light snow showers', '🌨️'],
    86: ['Heavy snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'],
    96: ['Thunderstorm + hail', '⛈️'], 99: ['Thunderstorm + heavy hail', '⛈️']
  };
  return map[code] || ['Unknown', '❓'];
}

// Avalanche danger scale
function avalancheBadge(level) {
  const colors = ['#4CAF50', '#FFEB3B', '#FF9800', '#F44336', '#000'];
  const labels = ['Low', 'Moderate', 'Considerable', 'High', 'Very High'];
  const i = Math.max(0, Math.min(4, level - 1));
  return { color: colors[i], label: labels[i], level };
}

function generateHTML(allData, timestamp) {
  const now = new Date(timestamp);
  const timeStr = now.toLocaleString('en-GB', { timeZone: 'Europe/Rome', dateStyle: 'full', timeStyle: 'short' });

  let resortCards = '';

  for (const { resort, data } of allData) {
    let stationRows = '';
    for (const station of ['top', 'mid', 'bottom']) {
      const d = data[station];
      if (!d || !d.current) continue;
      const c = d.current;
      const [desc, emoji] = weatherDesc(c.weather_code);
      const snowDepthCm = c.snow_depth ? Math.round(c.snow_depth * 100) : 0;

      // Next 24h snowfall from hourly
      let snow24h = 0;
      if (d.hourly && d.hourly.snowfall) {
        snow24h = d.hourly.snowfall.slice(0, 24).reduce((a, b) => a + (b || 0), 0);
      }

      stationRows += `
        <tr>
          <td class="station-name">${station.charAt(0).toUpperCase() + station.slice(1)}<br><span class="elev">${resort.elevations[station]}m</span></td>
          <td class="temp">${c.temperature_2m}°C<br><span class="feels">Feels ${c.apparent_temperature}°C</span></td>
          <td class="snow-depth">${snowDepthCm}cm</td>
          <td class="snow-new">${snow24h.toFixed(1)}cm</td>
          <td class="weather">${emoji} ${desc}</td>
          <td class="wind">${c.wind_speed_10m} km/h<br><span class="gusts">Gusts ${c.wind_gusts_10m}</span></td>
        </tr>`;
    }

    // Daily forecast
    let forecastRows = '';
    const topDaily = data.top?.daily;
    if (topDaily) {
      for (let i = 0; i < Math.min(3, topDaily.time.length); i++) {
        const [desc, emoji] = weatherDesc(topDaily.weather_code[i]);
        const day = new Date(topDaily.time[i]).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Rome' });
        forecastRows += `
          <tr>
            <td>${day}</td>
            <td>${emoji} ${desc}</td>
            <td>${topDaily.temperature_2m_min[i]}° / ${topDaily.temperature_2m_max[i]}°</td>
            <td>${topDaily.snowfall_sum[i]}cm</td>
          </tr>`;
      }
    }

    resortCards += `
      <div class="resort-card">
        <h2>${resort.name} <span class="area">${resort.area}</span></h2>
        <table class="stations">
          <thead>
            <tr><th>Station</th><th>Temp</th><th>Snow Depth</th><th>New Snow (24h)</th><th>Weather</th><th>Wind</th></tr>
          </thead>
          <tbody>${stationRows}</tbody>
        </table>
        <h3>3-Day Forecast (Top Station)</h3>
        <table class="forecast">
          <thead><tr><th>Day</th><th>Weather</th><th>Temp</th><th>Snowfall</th></tr></thead>
          <tbody>${forecastRows}</tbody>
        </table>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Snow Monitor</title>
<style>
  :root { --bg: #0f1923; --card: #1a2733; --text: #e0e6ed; --accent: #4fc3f7; --border: #2a3a4a; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 30px; }
  header h1 { font-size: 2em; color: var(--accent); margin-bottom: 4px; }
  header h1::before { content: '🏔️ '; }
  .updated { color: #8899aa; font-size: 0.85em; }
  .resort-card { background: var(--card); border-radius: 12px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border); }
  .resort-card h2 { color: var(--accent); margin-bottom: 16px; font-size: 1.4em; }
  .resort-card h2 .area { color: #8899aa; font-size: 0.65em; font-weight: normal; }
  .resort-card h3 { color: #aab; margin: 20px 0 10px; font-size: 1em; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #8899aa; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .station-name { font-weight: 600; }
  .elev { color: #8899aa; font-size: 0.8em; font-weight: normal; }
  .temp { font-size: 1.1em; font-weight: 600; }
  .feels { color: #8899aa; font-size: 0.8em; font-weight: normal; }
  .snow-depth { font-size: 1.2em; font-weight: 700; color: #81d4fa; }
  .snow-new { color: #aed581; font-weight: 600; }
  .gusts { color: #8899aa; font-size: 0.8em; }
  .forecast td { padding: 8px 12px; }

  @media (max-width: 640px) {
    body { padding: 10px; }
    .resort-card { padding: 14px; }
    table { font-size: 0.85em; }
    th, td { padding: 6px 6px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Snow Monitor</h1>
    <p class="updated">Updated: ${timeStr} CET</p>
  </header>
  ${resortCards}
  <footer style="text-align:center;color:#556;font-size:0.75em;margin-top:30px;">
    Data from <a href="https://open-meteo.com" style="color:#4fc3f7">Open-Meteo</a> · Auto-updated every 15 min
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  console.log('Fetching snow data...');
  const allData = [];

  for (const resort of resorts) {
    console.log(`  ${resort.name}...`);
    const data = await fetchOpenMeteo(resort);
    allData.push({ resort, data });
  }

  const timestamp = new Date().toISOString();
  const html = generateHTML(allData, timestamp);

  // Write to docs/ for GitHub Pages
  const outDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  // Also write raw data for debugging
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify({ timestamp, resorts: allData.map(d => ({ id: d.resort.id, name: d.resort.name, data: d.data })) }, null, 2));

  console.log(`Done! Written to docs/index.html at ${timestamp}`);
}

main().catch(e => { console.error(e); process.exit(1); });
