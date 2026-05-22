// Credentials are loaded directly from environment variables for Vercel secrets
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Local DB variables (prefer LokiJS for pure-JS local persistence)
let useLocalDb = false;
let localDb = null;

let deviceRegistry = new Map();
let trackerStatus = {
  lastError: null,
  lastErrorTime: null,
  lastSuccessTime: null,
  lastAttemptTime: null,
  authFailures: 0
};

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let persistenceEnabled = false;

async function loadState() {
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    // prefer LokiJS (pure JS) if available to avoid native builds
    try {
      const Loki = require('lokijs');
      const dbPath = path.join(DATA_DIR, 'state.db');
      localDb = new Loki(dbPath, { autosave: false, autoload: false });
      // load DB file if exists
      try {
        await new Promise((resolve, reject) => {
          localDb.loadDatabase({}, (err) => err ? reject(err) : resolve());
        });
      } catch (e) {
        // ignore load errors - we'll create collections
      }
      let devicesColl = localDb.getCollection('devices');
      if (!devicesColl) devicesColl = localDb.addCollection('devices', { unique: ['id'] });
      let statusColl = localDb.getCollection('trackerStatus');
      if (!statusColl) statusColl = localDb.addCollection('trackerStatus', { unique: ['k'] });

      // load devices into memory
      for (const r of devicesColl.find()) {
        try { deviceRegistry.set(r.id, r.data); } catch (e) { }
      }
      for (const r of statusColl.find()) {
        try { trackerStatus[r.k] = r.v; } catch (e) { trackerStatus[r.k] = r.v; }
      }

      useLocalDb = true;
      persistenceEnabled = true;
      return;
    } catch (e) {
      // loki not available; fall back to file
    }

    const raw = await fs.promises.readFile(STATE_FILE, 'utf8').catch(() => null);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.devices) {
      deviceRegistry = new Map(Object.entries(parsed.devices));
    }
    if (parsed && parsed.trackerStatus) trackerStatus = parsed.trackerStatus;
    persistenceEnabled = true;
  } catch (e) {
    persistenceEnabled = false;
    console.warn('Could not load persisted state:', e && e.message);
  }
}

async function saveState() {
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    if (useLocalDb && localDb) {
      const devicesColl = localDb.getCollection('devices') || localDb.addCollection('devices', { unique: ['id'] });
      const statusColl = localDb.getCollection('trackerStatus') || localDb.addCollection('trackerStatus', { unique: ['k'] });
      // upsert devices
      const existing = new Set(devicesColl.find().map(r => r.id));
      for (const [id, data] of deviceRegistry.entries()) {
        if (existing.has(id)) {
          const rec = devicesColl.findOne({ id });
          rec.data = data;
          devicesColl.update(rec);
        } else {
          devicesColl.insert({ id, data });
        }
      }
      // remove devices that no longer exist
      for (const rec of devicesColl.find()) {
        if (!deviceRegistry.has(rec.id)) devicesColl.remove(rec);
      }
      // upsert status
      for (const k of Object.keys(trackerStatus)) {
        const rec = statusColl.findOne({ k });
        if (rec) { rec.v = trackerStatus[k]; statusColl.update(rec); }
        else statusColl.insert({ k, v: trackerStatus[k] });
      }
      // save DB to disk
      await new Promise((resolve, reject) => {
        localDb.saveDatabase((err) => err ? reject(err) : resolve());
      });
      persistenceEnabled = true;
      return;
    }

    const devices = Object.fromEntries(deviceRegistry);
    const payload = { devices, trackerStatus };
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(payload), 'utf8');
    persistenceEnabled = true;
  } catch (e) {
    persistenceEnabled = false;
    console.warn('Could not save state:', e && e.message);
  }
}

// attempt to load persisted state on module load (async)
loadState().catch(() => {});

export default async function handler(req, res) {
  try {
    // ensure req.body exists; fallback to parse raw JSON body if necessary
    if (!req.body && (req.headers['content-type'] || '').includes('application/json')) {
      try {
        req.body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); }
          });
          req.on('error', () => resolve(null));
        });
      } catch (e) {
        req.body = null;
      }
    }
    
    const now = Date.now();
    const toRemove = [];
    for (const [id, data] of deviceRegistry.entries()) {
      if (now - data.timestamp > 24 * 60 * 60 * 1000) toRemove.push(id);
    }
    for (const id of toRemove) deviceRegistry.delete(id);


    if (req.method === 'GET') {
      // parse URL and query params reliably (works with /api/track?view and /api/track?action=view)
      let pathname = '';
      let searchParams = new URLSearchParams('');
      try {
        const parsed = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        pathname = parsed.pathname || '';
        searchParams = parsed.searchParams;
      } catch (e) {
        const raw = (req.url || '').toLowerCase();
        pathname = raw.split('?')[0] || '';
        searchParams = new URLSearchParams(raw.split('?')[1] || '');
      }

      const hasViewParam = pathname.toLowerCase().startsWith('/view') || searchParams.has('view') || searchParams.get('action') === 'view';

      if (hasViewParam) {
        const devicesArray = Array.from(deviceRegistry.entries()).map(([id, data]) => {
          const speedKmH = (data.speed * 3.6).toFixed(1);
          const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lng}`;
          return {
            id: id.replace(/_/g, ' '),
            lat: data.lat,
            lng: data.lng,
            accuracy: Math.round(data.accuracy),
            speed: speedKmH,
            bearing: Math.round(data.bearing),
            battery: data.batteryLevel,
            charging: data.isCharging,
            updated: data.time,
            maps: mapsUrl
          };
        });

        
        // build HTML for devices or status message
        const timeAgo = (ts) => {
          if (!ts) return 'never';
          const d = Math.floor((Date.now() - ts) / 1000);
          if (d < 60) return `${d}s ago`;
          if (d < 3600) return `${Math.floor(d/60)}m ago`;
          if (d < 86400) return `${Math.floor(d/3600)}h ago`;
          return `${Math.floor(d/86400)}d ago`;
        };

        let devicesHtml = '';
        if (devicesArray.length === 0) {
            let statusMsg = '📡 No tracking telemetry signatures stored in active cache memory.';
          if (trackerStatus.lastError) {
            statusMsg = `⚠️ Last error: ${trackerStatus.lastError} (${timeAgo(trackerStatus.lastErrorTime)})`;
          } else if (!trackerStatus.lastSuccessTime && trackerStatus.authFailures > 0) {
            statusMsg = '⚠️ Incorrect auth token used by device(s). Please check `AUTH_TOKEN`.';
          } else if (!trackerStatus.lastSuccessTime) {
            statusMsg = 'ℹ️ Tracker has not yet sent any successful data. Ensure devices POST to this endpoint with the correct `AUTH_TOKEN`.';
          } else {
            statusMsg = `ℹ️ Last successful update: ${timeAgo(trackerStatus.lastSuccessTime)}`;
          }
            // include persistence info
            const persistMsg = persistenceEnabled ? `✅ State persisted to disk` : `⚠️ No persistence available (in-memory only)`;
            devicesHtml = `\n              <div class="card no-data">\n                <div style="margin-bottom:8px">${statusMsg}</div>\n                <div style="font-size:12px; color:#8b949e">${persistMsg}</div>\n              </div>\n            `;
        } else {
          devicesHtml = devicesArray.map(dev => `
              <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #21262d; padding-bottom:10px; margin-bottom:10px;">
                  <strong style="color: #f0f6fc; font-size: 16px;">📱 ${dev.id}</strong>
                  <span style="font-size:12px; color:#8b949e; font-family:monospace;">🕒 Localized: ${dev.updated}</span>
                </div>
                <div class="grid">
                  <div class="metric"><div class="metric-title">Coordinates</div><div class="metric-value">${dev.lat}, ${dev.lng}</div></div>
                  <div class="metric"><div class="metric-title">Velocity</div><div class="metric-value">${dev.speed} km/h</div></div>
                  <div class="metric"><div class="metric-title">GPS Precision</div><div class="metric-value">± ${dev.accuracy} meters</div></div>
                  <div class="metric"><div class="metric-title">Battery</div><div class="metric-value">${dev.battery}% ${dev.charging ? '🔌 (Charging)' : '🔋'}</div></div>
                </div>
                <div style="margin-top:20px;">
                  <a href="${dev.maps}" target="_blank" class="btn btn-primary">🗺️ View Location on Maps</a>
                </div>
              </div>
            `).join('');
        }

        const htmlLayout = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>OmniTracker Web Console</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background-color: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
            .container { max-width: 900px; margin: 0 auto; }
            .header { border-bottom: 1px solid #21262d; padding-bottom: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
            h1 { font-size: 20px; color: #f0f6fc; margin: 0; font-weight: 600; display: flex; align-items: center; gap: 8px; }
            .badge { background: #238636; color: white; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
            .card { background-color: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 20px; margin-bottom: 16px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-top: 14px; }
            .metric { background: #0d1117; border: 1px solid #21262d; padding: 12px; border-radius: 4px; }
            .metric-title { font-size: 11px; font-weight: bold; color: #58a6ff; text-transform: uppercase; margin-bottom: 4px; }
            .metric-value { font-size: 14px; font-family: monospace; color: #e6edf3; }
            .btn { display: inline-block; background-color: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 16px; font-size: 13px; font-weight: 500; border-radius: 6px; text-decoration: none; cursor: pointer; text-align: center; width: 100%; box-sizing: border-box; transition: 0.2s; }
            .btn-primary { background-color: #238636; border-color: #2ea44f; color: #fff; }
            .btn-primary:hover { background-color: #2ea44f; }
            .no-data { text-align: center; padding: 40px; color: #8b949e; font-size: 14px; }
          </style>
          <script>
            setTimeout(() => { location.reload(); }, 12000);
          </script>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🛰️ OmniTracker Live</h1>
              <span class="badge">Active</span>
            </div>
            
            ${devicesHtml}
          </div>
        </body>
        </html>`;

        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(htmlLayout);
      }
    }

   
    if (req.body && req.body.callback_query) {
      const cb = req.body.callback_query;
      const callbackData = cb.data || '';
      const messageId = cb.message ? cb.message.message_id : null;
      
      if (callbackData === 'open_menu') {
        const devices = Array.from(deviceRegistry.keys());
        const inline_keyboard = devices.map(id => [
          { text: `🛰️ ${id.replace(/_/g, ' ')}`, callback_data: `locate_${id}` }
        ]);
        const targetChat = cb.message && cb.message.chat && cb.message.chat.id ? cb.message.chat.id : CHAT_ID;

        await sendTelegram('editMessageText', {
          chat_id: targetChat,
          message_id: messageId,
          text: devices.length > 0 ? '<b>Select a device to track:</b>' : '<b>No active devices online.</b>',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard }
        }).catch(() => {});

        await sendTelegram('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        return res.status(200).send('OK');
      }

      const deviceId = String(callbackData).replace('locate_', '');
      const data = deviceRegistry.get(deviceId);
      
      if (!data) {
        await sendTelegram('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '❌ Device offline or uninstalled',
          show_alert: true
        }).catch(() => {});
        return res.status(200).send('OK');
      }

      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lng}`;
      const batteryEmoji = data.isCharging ? '🔌' : (data.batteryLevel < 20 ? '🪫' : '🔋');
      const speedKmH = (data.speed * 3.6).toFixed(1);

      const textMessage = 
        `📱 <b>Device:</b> ${deviceId.replace(/_/g, ' ')}\n` +
        `⏱️ <b>Speed:</b> ${speedKmH} km/h | <b>Heading:</b> ${Math.round(data.bearing)}°\n` +
        `🎯 <b>GPS Accuracy:</b> Within ${Math.round(data.accuracy)} meters\n` +
        `${batteryEmoji} <b>Battery Status:</b> ${data.batteryLevel}% ${data.isCharging ? '(Charging)' : '(On Battery)'}\n` +
        `🕒 <b>Last Updated:</b> ${data.time}`;

      const inline_keyboard = [
        [{ text: '🗺️ Open Live Google Maps', url: mapsUrl }],
        [
          { text: '🔄 Refresh Data', callback_data: `locate_${deviceId}` },
          { text: '🎛️ Devices Menu', callback_data: 'open_menu' }
        ]
      ];

      await sendTelegram('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

      const targetChatForCallback = cb.message && cb.message.chat && cb.message.chat.id ? cb.message.chat.id : CHAT_ID;

      if (messageId) {
        await sendTelegram('editMessageText', {
          chat_id: targetChatForCallback,
          message_id: messageId,
          text: textMessage,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard }
        }).catch(async () => {
          await sendTelegram('sendMessage', {
            chat_id: targetChatForCallback,
            text: textMessage,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
          }).catch(() => {});
        });
      }
      return res.status(200).send('OK');
    }

    
    if (req.body && req.body.message) {
      const text = req.body.message.text || '';
      if (text === '/start' || text === '/menu') {
        const devices = Array.from(deviceRegistry.keys());
        const inline_keyboard = devices.map(id => [
          { text: `🛰️ ${id.replace(/_/g, ' ')}`, callback_data: `locate_${id}` }
        ]);
        const incomingChat = req.body.message && req.body.message.chat && req.body.message.chat.id ? req.body.message.chat.id : CHAT_ID;

        await sendTelegram('sendMessage', {
          chat_id: incomingChat,
          text: devices.length > 0 ? '<b>Select a device to locate:</b>' : '<b>No active devices online.</b>',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard }
        }).catch(() => {});
        return res.status(200).send('OK');
      }
    }

    
    if (req.method === 'POST' && req.body && req.body.deviceID) {
      const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
      const providedToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : authHeader;
      if (providedToken !== AUTH_TOKEN) {
        trackerStatus.lastError = 'Invalid auth token';
        trackerStatus.lastErrorTime = Date.now();
        trackerStatus.authFailures = (trackerStatus.authFailures || 0) + 1;
        trackerStatus.lastAttemptTime = Date.now();
        return res.status(401).send('Unauthorized');
      }

      const deviceID = String(req.body.deviceID).trim().slice(0, 200);
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);

      const accuracy = Number(req.body.accuracy) || 0;
      const speed = Number(req.body.speed) || 0;
      const bearing = Number(req.body.bearing) || 0;
      const batteryLevel = typeof req.body.batteryLevel !== 'undefined' && req.body.batteryLevel !== null ? Number(req.body.batteryLevel) : -1;
      const isCharging = req.body.isCharging === true || req.body.isCharging === 'true' || req.body.isCharging === '1' || req.body.isCharging === 1;

      trackerStatus.lastAttemptTime = Date.now();
      if (!isFinite(lat) || !isFinite(lng)) {
        trackerStatus.lastError = 'Invalid coordinates';
        trackerStatus.lastErrorTime = Date.now();
        return res.status(400).json({ success: false, error: 'Invalid coordinates' });
      }

      const isNewDevice = !deviceRegistry.has(deviceID);
      
      deviceRegistry.set(deviceID, {
        lat,
        lng,
        accuracy,
        speed,
        bearing,
        batteryLevel,
        isCharging,
        timestamp: Date.now(),
        time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })
      });

      // mark success
      trackerStatus.lastSuccessTime = Date.now();
      trackerStatus.lastError = null;
      // persist state asynchronously (best-effort)
      saveState().catch(() => {});

      if (isNewDevice) {
        const cleanName = deviceID.replace(/_/g, ' ');
        const inline_keyboard = [[
          { text: `🛰️ Track ${cleanName}`, callback_data: `locate_${deviceID}` }
        ]];
        
        if (CHAT_ID) {
          await sendTelegram('sendMessage', {
            chat_id: CHAT_ID,
            text: `🆕 <b>New Tracker Connected!</b>\n\n📱 <b>Model:</b> ${cleanName}\n🔋 <b>Battery:</b> ${batteryLevel}%\n\n🌍 Connection established successfully.`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
          }).catch(() => {});
        }
      }
      
      return res.status(200).json({ success: true });
    }

    return res.status(200).send('Tracker Endpoint Active');
  } catch (err) {
    console.error('Core routing breakdown', err);
    return res.status(500).send('Internal Server Error');
  }
}

async function sendTelegram(method, body) {
  if (!BOT_TOKEN) {
    console.warn('Telegram BOT_TOKEN missing; skipping Telegram call');
    return null;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const fetchFn = typeof fetch === 'undefined' && typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch : fetch;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => controller && controller.abort(), 5000);
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      clearTimeout(timeout);
      if (!resp) return null;
      if (resp.ok) return await resp.json();
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
      // small backoff
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }
  }
  console.error('sendTelegram failed after retries', lastErr && lastErr.message);
  return null;
}
