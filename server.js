require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');
const fs = require('fs');

const METABASE_URL     = process.env.METABASE_URL     || '';
const METABASE_API_KEY = process.env.METABASE_API_KEY || '';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/appsscript', express.static(path.join(__dirname, 'appsscript')));
app.use(express.json({ limit: '10mb' }));

// Follow redirects with cookies
function fetchCsv(url, cookies, redirectsLeft, res) {
  if (redirectsLeft <= 0) return res.status(500).json({ error: 'Too many redirects' });
  const protocol = url.startsWith('https') ? https : http;
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': cookies.join('; ')
    }
  };
  const req = protocol.get(url, options, (response) => {
    const setCookie = response.headers['set-cookie'] || [];
    const newCookies = [...cookies, ...setCookie.map(c => c.split(';')[0])];
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) return res.status(500).json({ error: 'Redirect with no location' });
      response.resume();
      return fetchCsv(location, newCookies, redirectsLeft - 1, res);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.pipe(res);
  });
  req.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  req.setTimeout(15000, () => { req.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Timeout' }); });
}

app.get('/api/sheet', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!url.includes('docs.google.com/spreadsheets') && !url.includes('googleusercontent.com')) {
    return res.status(400).json({ error: 'Only Google Sheets URLs allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  fetchCsv(url + '&t=' + Date.now(), [], 5, res);
});

// Claude API — extract sub_category + verbatim from partner question
app.post('/api/analyze', async (req, res) => {
  const { text, apiKey } = req.body;
  if (!text || !apiKey) return res.status(400).json({ error: 'Missing text or apiKey' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are analyzing customer/partner questions in a contact center. Analyze the question and provide:
1. sub_category: A concise 2-4 word category label in English (e.g., "Billing Query", "Delivery Issue", "Account Problem", "Technical Support", "Refund Request", "Product Info", "Order Status")
2. verbatim: A clear enhanced verbatim of the core concern in English (1-2 sentences)

Respond ONLY with valid JSON in this exact format:
{"sub_category": "...", "verbatim": "..."}

Question: ${text}`
        }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const rawText = data.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { sub_category: 'General Query', verbatim: rawText };
    }
    res.json({
      verbatim: parsed.verbatim || rawText,
      sub_category: parsed.sub_category || 'General Query'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hardcoded sheet URLs
const PTL_CSV     = 'https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv';
const INBOUND_CSV = 'https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv&gid=1325902355';
const PSAT_CSV    = 'https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv&gid=2057574254';

app.get('/api/ptl-data',     (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  fetchCsv(PTL_CSV     + '&t=' + Date.now(), [], 5, res);
});
app.get('/api/inbound-data', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  fetchCsv(INBOUND_CSV + '&t=' + Date.now(), [], 5, res);
});
app.get('/api/psat-data',    (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  fetchCsv(PSAT_CSV    + '&t=' + Date.now(), [], 5, res);
});

// Slack — list channels
app.get('/api/slack-channels', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const response = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await response.json();
    if (!data.ok) return res.status(400).json({ error: data.error });
    const channels = data.channels.filter(c => c.is_member).map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name));
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Slack — send message proxy
app.post('/api/slack', async (req, res) => {
  const { token, channel, text } = req.body;
  if (!token || !channel || !text) return res.status(400).json({ error: 'Missing token, channel or text' });
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text })
    });
    const data = await response.json();
    if (data.ok) res.json({ ok: true });
    else res.status(400).json({ error: data.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Slack — upload chart image (PNG)
app.post('/api/slack-upload', async (req, res) => {
  const { token, channel, imageBase64, filename, title } = req.body;
  if (!token || !channel || !imageBase64) return res.status(400).json({ error: 'Missing params' });
  try {
    const buf = Buffer.from(imageBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
    const fname = filename || 'chart.png';

    // Step 1: Get upload URL
    const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `filename=${encodeURIComponent(fname)}&length=${buf.length}`
    });
    const urlData = await urlRes.json();
    if (!urlData.ok) return res.status(400).json({ error: urlData.error });

    // Step 2: Upload file content
    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf
    });

    // Step 3: Complete upload and share to channel
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ id: urlData.file_id, title: title || fname }], channel_id: channel })
    });
    const completeData = await completeRes.json();
    if (completeData.ok) res.json({ ok: true });
    else res.status(400).json({ error: completeData.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Publish report as image to Slack
app.post('/api/publish-image', (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'Missing channel' });
  const script = path.join(__dirname, 'slack_report_image.js');
  const child = spawn(process.execPath, [script, channel], { cwd: __dirname });
  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', code => {
    if (code === 0) res.json({ ok: true, log: out.trim() });
    else res.status(500).json({ ok: false, error: err.trim() || out.trim() });
  });
  child.on('error', e => res.status(500).json({ ok: false, error: e.message }));
});

// Deploy — trigger Railway redeploy from latest GitHub commit
app.post('/api/deploy', async (req, res) => {
  const token = process.env.RAILWAY_DEPLOY_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const envId = process.env.RAILWAY_ENV_ID;
  if (!token || !serviceId || !envId) return res.status(500).json({ error: 'Railway deploy config missing' });
  try {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        query: `mutation { serviceInstanceDeploy(serviceId: "${serviceId}", environmentId: "${envId}") }`
      })
    });
    const data = await response.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase proxy — fetch any card/question data
app.get('/api/metabase/card/:id', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const response = await fetch(`${METABASE_URL}/api/card/${req.params.id}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': METABASE_API_KEY
      },
      body: JSON.stringify({ ignore_cache: false })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase proxy — list all cards (questions)
app.get('/api/metabase/cards', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const response = await fetch(`${METABASE_URL}/api/card`, {
      headers: { 'x-api-key': METABASE_API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase — all available dates for campaign filter
app.get('/api/live-dates', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({
        database: 113,
        native: { query: `SELECT DISTINCT DATE(CALL_TIME) AS dt FROM PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT WHERE CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign' ORDER BY dt DESC` },
        type: 'native'
      })
    });
    const d = await r.json();
    const dates = (d.data?.rows || []).map(row => row[0]).filter(Boolean);
    res.json({ dates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase — Daily Inbound Call report (date range, date-wise + agent-wise)
app.get('/api/daily-inbound', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  const mbQuery = async (sql) => {
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, native: { query: sql }, type: 'native' })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.data ? d.data.rows : [];
  };
  try {
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const toIST    = `DATE(CALL_TIME)`;
    const hrIST    = `HOUR(CALL_TIME)`;
    const RCV_Q    = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const NL_COND  = `(QUEUE_NAME IS NULL OR QUEUE_NAME NOT IN ('PartnerSupportQueue','PartnerTestQueue'))`;
    let fromDate = req.query.from;
    let toDate   = req.query.to;
    if (!fromDate || !toDate) {
      const r = await mbQuery(`SELECT MAX(${toIST}) FROM ${TBL} WHERE ${CAMPAIGN}`);
      toDate   = toDate   || r[0][0];
      fromDate = fromDate || r[0][0];
    }
    const dateFilter = `${CAMPAIGN} AND ${toIST} BETWEEN '${fromDate}' AND '${toDate}'`;
    const IVR = `COALESCE(TRY_CAST(IVR_TIME AS FLOAT), 0)`;
    const NLW = `${INBOUND} AND ${NL_COND} AND ${hrIST} BETWEEN 11 AND 20`;
    const NLNW = `${INBOUND} AND ${NL_COND} AND (${hrIST} < 11 OR ${hrIST} >= 21)`;

    const selectMetrics = (prefix) => `
        COUNT(CASE WHEN ${INBOUND} THEN 1 END) AS ${prefix}initiated,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END) AS ${prefix}received,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS ${prefix}answered,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END) AS ${prefix}missed,
        COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} THEN 1 END) AS ${prefix}not_landed,
        COUNT(CASE WHEN ${NLW} THEN 1 END) AS ${prefix}nl_work,
        COUNT(CASE WHEN ${NLNW} THEN 1 END) AS ${prefix}nl_nonwork,
        COUNT(CASE WHEN ${NLW} AND ${IVR} <= 5  THEN 1 END) AS ${prefix}nlw_0_5,
        COUNT(CASE WHEN ${NLW} AND ${IVR} > 5  AND ${IVR} <= 10 THEN 1 END) AS ${prefix}nlw_5_10,
        COUNT(CASE WHEN ${NLW} AND ${IVR} > 10 AND ${IVR} <= 15 THEN 1 END) AS ${prefix}nlw_10_15,
        COUNT(CASE WHEN ${NLW} AND ${IVR} > 15 THEN 1 END) AS ${prefix}nlw_gt15,
        COUNT(CASE WHEN ${NLNW} AND ${hrIST} = 10 THEN 1 END) AS ${prefix}nlnw_10_11,
        COUNT(CASE WHEN ${NLNW} AND ${hrIST} = 21 THEN 1 END) AS ${prefix}nlnw_21_22,
        COUNT(CASE WHEN ${NLNW} AND (${hrIST} >= 22 OR ${hrIST} < 10) THEN 1 END) AS ${prefix}nlnw_rest`;

    const mapRow = (r, offset = 0) => ({
      initiated: Number(r[offset]),   received:   Number(r[offset+1]),
      answered:  Number(r[offset+2]), missed:     Number(r[offset+3]),
      not_landed:Number(r[offset+4]), nl_work:    Number(r[offset+5]),
      nl_nonwork:Number(r[offset+6]),
      nlw_0_5:   Number(r[offset+7]), nlw_5_10:   Number(r[offset+8]),
      nlw_10_15: Number(r[offset+9]), nlw_gt15:   Number(r[offset+10]),
      nlnw_10_11:Number(r[offset+11]),nlnw_21_22: Number(r[offset+12]),
      nlnw_rest: Number(r[offset+13])
    });

    const [totRows, dateRows, agentRows] = await Promise.all([
      mbQuery(`SELECT ${selectMetrics('')} FROM ${TBL} WHERE ${dateFilter}`),
      mbQuery(`SELECT ${toIST} AS dt, ${selectMetrics('')} FROM ${TBL} WHERE ${dateFilter} GROUP BY dt ORDER BY dt DESC`),
      mbQuery(`SELECT COALESCE(USER_NAME,'Unknown'), COUNT(*) FROM ${TBL}
               WHERE ${dateFilter} AND ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED'
               GROUP BY 1 ORDER BY 2 DESC LIMIT 50`)
    ]);

    const s = mapRow(totRows[0]);
    res.json({
      from: fromDate, to: toDate,
      summary: {
        ...s,
        ans_pct:     s.received ? ((s.answered / s.received) * 100).toFixed(1) : '0',
        missed_rate: s.received ? ((s.missed   / s.received) * 100).toFixed(1) : '0'
      },
      dates:  dateRows.map(r => ({ dt: r[0], ...mapRow(r, 1) })),
      agents: agentRows.map(r => ({ name: r[0], answered: Number(r[1]) }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase — Daily hour-wise matrix (date × hour heatmap, working hours 11–21)
app.get('/api/daily-hour-matrix', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const RCV_Q    = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    let fromDate = req.query.from, toDate = req.query.to;
    if (!fromDate || !toDate) {
      const r = await fetch(`${METABASE_URL}/api/dataset`, {
        method:'POST', headers:{'Content-Type':'application/json','x-api-key':METABASE_API_KEY},
        body: JSON.stringify({ database:113, type:'native', native:{ query:`SELECT MAX(DATE(CALL_TIME)) FROM ${TBL} WHERE ${CAMPAIGN}` }})
      });
      const d = await r.json(); const latest = d.data?.rows[0][0];
      toDate = toDate || latest; fromDate = fromDate || latest;
    }
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':METABASE_API_KEY},
      body: JSON.stringify({ database:113, type:'native', native:{ query:`
        SELECT
          DATE(CALL_TIME)                                                          AS dt,
          HOUR(CALL_TIME)                                                          AS hr,
          COUNT(CASE WHEN ${INBOUND} THEN 1 END)                                  AS initiated,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END)                     AS received,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS answered,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END) AS missed
        FROM ${TBL}
        WHERE ${CAMPAIGN}
          AND DATE(CALL_TIME) BETWEEN '${fromDate}' AND '${toDate}'
          AND HOUR(CALL_TIME) BETWEEN 11 AND 21
        GROUP BY dt, hr
        ORDER BY dt, hr
      `}})
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const rows = (d.data?.rows || []).map(row => ({
      dt: row[0], hr: Number(row[1]),
      initiated: Number(row[2]), received: Number(row[3]),
      answered: Number(row[4]), missed: Number(row[5])
    }));
    res.json({ from: fromDate, to: toDate, rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Metabase — Live inbound dashboard data (all metrics in one call)
app.get('/api/live-data', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });

  const mbQuery = async (sql) => {
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, native: { query: sql }, type: 'native' })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.data ? d.data.rows : [];
  };

  try {
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const TBL = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const toIST = `DATE(CALL_TIME)`;
    const hrIST = `HOUR(CALL_TIME)`;
    const RCV_Q   = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const NL_COND = `(QUEUE_NAME IS NULL OR QUEUE_NAME NOT IN ('PartnerSupportQueue','PartnerTestQueue'))`;

    // Resolve from/to dates (fall back to latest date if not provided)
    let fromDate = req.query.from || null;
    let toDate   = req.query.to   || null;
    if (!fromDate || !toDate) {
      const latestRows = await mbQuery(`SELECT MAX(${toIST}) FROM ${TBL} WHERE ${CAMPAIGN}`);
      const latest = latestRows[0][0];
      fromDate = fromDate || latest;
      toDate   = toDate   || latest;
    }
    const dateFilter = `${CAMPAIGN} AND ${toIST} BETWEEN '${fromDate}' AND '${toDate}'`;

    // Summary totals (includes NL breakdown — saves one round-trip)
    const summaryRows = await mbQuery(`
      SELECT
        COUNT(CASE WHEN ${INBOUND} THEN 1 END) AS initiated,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END) AS received,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS answered,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END) AS missed,
        COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} THEN 1 END) AS not_landed,
        COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND ${hrIST} BETWEEN 11 AND 20 THEN 1 END) AS nl_work,
        COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND (${hrIST} < 11 OR ${hrIST} >= 21) THEN 1 END) AS nl_nonwork
      FROM ${TBL}
      WHERE ${CAMPAIGN} AND ${dateFilter}
    `);
    const [initiated, received, answered, missed, not_landed, nl_work, nl_nonwork] = summaryRows[0].map(Number);

    // Hourly breakdown
    const hourlyRows = await mbQuery(`
      SELECT
        ${hrIST} AS hr,
        COUNT(CASE WHEN ${INBOUND} THEN 1 END) AS initiated,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END) AS received,
        COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS answered
      FROM ${TBL}
      WHERE ${CAMPAIGN} AND ${dateFilter}
      GROUP BY hr ORDER BY hr
    `);

    // Agent-wise
    const agentRows = await mbQuery(`
      SELECT
        COALESCE(USER_NAME,'Unknown') AS agent,
        COUNT(*) AS answered
      FROM ${TBL}
      WHERE ${CAMPAIGN} AND ${dateFilter}
        AND ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED'
      GROUP BY agent ORDER BY answered DESC LIMIT 30
    `);

    // Queue-wise (only the two campaign queues)
    const queueRows = await mbQuery(`
      SELECT
        QUEUE_NAME,
        COUNT(*) AS received,
        COUNT(CASE WHEN SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS answered
      FROM ${TBL}
      WHERE ${CAMPAIGN} AND ${dateFilter}
        AND ${RCV_Q}
      GROUP BY QUEUE_NAME ORDER BY received DESC
    `);

    res.json({
      date: toDate, from: fromDate, to: toDate,
      summary: {
        initiated, received, answered, missed, not_landed, nl_work, nl_nonwork,
        ans_pct: received ? ((answered / received) * 100).toFixed(1) : '0',
        missed_rate: received ? ((missed / received) * 100).toFixed(1) : '0'
      },
      hourly: hourlyRows.map(r => ({ hr: Number(r[0]), initiated: Number(r[1]), received: Number(r[2]), answered: Number(r[3]) })),
      agents: agentRows.map(r => ({ name: r[0], answered: Number(r[1]) })),
      queues: queueRows.map(r => ({ name: r[0], received: Number(r[1]), answered: Number(r[2]) }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase — Hourly breakdown for daily inbound chart
app.get('/api/hourly-inbound', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const RCV_Q    = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const toIST    = `DATE(CALL_TIME)`;
    const hrIST    = `HOUR(CALL_TIME)`;
    let fromDate = req.query.from, toDate = req.query.to;
    if (!fromDate || !toDate) {
      const r = await fetch(`${METABASE_URL}/api/dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
        body: JSON.stringify({ database: 113, native: { query: `SELECT MAX(${toIST}) FROM ${TBL} WHERE ${CAMPAIGN}` }, type: 'native' })
      });
      const d = await r.json(); toDate = toDate || d.data.rows[0][0]; fromDate = fromDate || toDate;
    }
    const dateFilter = `${CAMPAIGN} AND ${toIST} BETWEEN '${fromDate}' AND '${toDate}'`;
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, native: { query: `
        SELECT ${hrIST} AS hr,
          COUNT(CASE WHEN ${INBOUND} THEN 1 END) AS initiated,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END) AS received,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END) AS answered,
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END) AS missed
        FROM ${TBL} WHERE ${dateFilter}
        GROUP BY hr ORDER BY hr
      `}, type: 'native' })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const rows = (d.data?.rows || []).map(r => ({
      hr: Number(r[0]), initiated: Number(r[1]), received: Number(r[2]),
      answered: Number(r[3]), missed: Number(r[4])
    }));
    res.json({ from: fromDate, to: toDate, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
// New CSP — Google Sheet + Snowflake per-partner call stats
// Sheet: Col A = phone, B = partner name, C = role, D = launch date
// ─────────────────────────────────────────────────
const NEWCSP_SHEET_ID = '15kAWIDIQWr5WZguZrILiGuumljrihe_5DwQ4-bZEDHs';
let newcspCache = null; // { ts, data }

function parseCSVLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  result.push(cur.trim()); return result;
}

function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function parseSheetDate(raw) {
  if (!raw) return null;
  raw = raw.trim().replace(/['"]/g, '');
  let m;
  // DD/MM/YYYY or DD-MM-YYYY
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // DD-Mon-YYYY
  const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  m = raw.match(/^(\d{1,2})[\/\-]([a-zA-Z]{3})[\/\-](\d{4})$/);
  if (m) { const mo = months[m[2].toLowerCase()]; if (mo) return `${m[3]}-${mo}-${m[1].padStart(2,'0')}`; }
  // DD/MM/YY
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

async function fetchNewCSPPartners() {
  const url = `https://docs.google.com/spreadsheets/d/${NEWCSP_SHEET_ID}/export?format=csv&gid=0`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Sheet fetch failed: ${r.status}`);
  const text = await r.text();
  const partners = [];
  for (const line of text.trim().split('\n')) {
    const cols = parseCSVLine(line);
    const phone = normPhone(cols[0]);
    if (!phone) continue;                         // skip header / blank rows
    const launchDate = parseSheetDate(cols[3]);
    if (!launchDate) continue;
    partners.push({ phone, name: (cols[1]||'').trim(), role: (cols[2]||'').trim(), launchDate });
  }
  return partners;
}

app.get('/api/newcsp-data', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    // 3-minute server cache (skip on ?refresh=1)
    const now = Date.now();
    if (!req.query.refresh && newcspCache && (now - newcspCache.ts) < 3 * 60 * 1000)
      return res.json(newcspCache.data);

    const partners = await fetchNewCSPPartners();
    if (!partners.length) return res.json({ partners: [], summary: { total_partners:0, initiated:0, received:0, answered:0, missed:0, not_landed:0 } });

    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const RCV_Q    = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const NL_COND  = `(QUEUE_NAME IS NULL OR QUEUE_NAME NOT IN ('PartnerSupportQueue','PartnerTestQueue'))`;

    // One query: per-phone + campaign + launch-date floor
    const cond = partners.map(p =>
      `(${CAMPAIGN} AND RIGHT(REGEXP_REPLACE(COALESCE(PHONE,''),'[^0-9]',''),10)='${p.phone}' AND DATE(CALL_TIME)>='${p.launchDate}')`
    ).join(' OR ');

    const mbQ = async (sql) => {
      const r = await fetch(`${METABASE_URL}/api/dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
        body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d.data?.rows || [];
    };

    // Run per-partner totals + date-wise breakdown in parallel
    const [partnerRows, dateRows] = await Promise.all([
      mbQ(`SELECT
          RIGHT(REGEXP_REPLACE(COALESCE(PHONE,''),'[^0-9]',''),10) AS ph,
          COUNT(CASE WHEN ${INBOUND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND HOUR(CALL_TIME) BETWEEN 11 AND 20 THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND (HOUR(CALL_TIME) < 11 OR HOUR(CALL_TIME) >= 21) THEN 1 END),
          MIN(DATE(CALL_TIME)), MAX(DATE(CALL_TIME))
        FROM ${TBL} WHERE (${cond}) GROUP BY ph`),
      mbQ(`SELECT
          DATE(CALL_TIME) AS dt,
          COUNT(CASE WHEN ${INBOUND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND HOUR(CALL_TIME) BETWEEN 11 AND 20 THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND (HOUR(CALL_TIME) < 11 OR HOUR(CALL_TIME) >= 21) THEN 1 END)
        FROM ${TBL} WHERE (${cond}) GROUP BY dt ORDER BY dt DESC`)
    ]);

    const callMap = {};
    partnerRows.forEach(row => {
      callMap[String(row[0])] = {
        initiated: Number(row[1]), received: Number(row[2]),
        answered: Number(row[3]), missed: Number(row[4]),
        not_landed: Number(row[5]), nl_work: Number(row[6]), nl_nonwork: Number(row[7]),
        first_call: row[8], last_call: row[9]
      };
    });

    const result = partners.map(p => ({
      ...p,
      ...(callMap[p.phone] || { initiated:0, received:0, answered:0, missed:0, not_landed:0, nl_work:0, nl_nonwork:0, first_call:null, last_call:null })
    }));

    const summary = result.reduce((a, p) => ({
      total_partners: a.total_partners + 1,
      initiated:  a.initiated  + p.initiated,
      received:   a.received   + p.received,
      answered:   a.answered   + p.answered,
      missed:     a.missed     + p.missed,
      not_landed: a.not_landed + p.not_landed,
      nl_work:    a.nl_work    + p.nl_work,
      nl_nonwork: a.nl_nonwork + p.nl_nonwork,
    }), { total_partners:0, initiated:0, received:0, answered:0, missed:0, not_landed:0, nl_work:0, nl_nonwork:0 });

    const dates = dateRows.map(r => ({
      dt: r[0], initiated: Number(r[1]), received: Number(r[2]),
      answered: Number(r[3]), missed: Number(r[4]),
      not_landed: Number(r[5]), nl_work: Number(r[6]), nl_nonwork: Number(r[7])
    }));

    const payload = { partners: result, dates, summary, fetchedAt: new Date().toISOString() };
    newcspCache = { ts: now, data: payload };
    res.json(payload);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// New CSP — date-wise breakdown for a specific partner (or subset)
app.get('/api/newcsp-dates', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    // phones=7012345678,9876543210  froms=2026-04-22,2026-04-29
    const phones = (req.query.phones || '').split(',').map(s => s.trim()).filter(Boolean);
    const froms  = (req.query.froms  || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!phones.length || phones.length !== froms.length)
      return res.status(400).json({ error: 'phones and froms required (same length)' });

    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign'`;
    const INBOUND  = `CALL_TYPE = 'inbound.call.dial'`;
    const RCV_Q    = `QUEUE_NAME IN ('PartnerSupportQueue','PartnerTestQueue')`;
    const NL_COND  = `(QUEUE_NAME IS NULL OR QUEUE_NAME NOT IN ('PartnerSupportQueue','PartnerTestQueue'))`;
    const cond     = phones.map((ph, i) =>
      `(${CAMPAIGN} AND RIGHT(REGEXP_REPLACE(COALESCE(PHONE,''),'[^0-9]',''),10)='${ph}' AND DATE(CALL_TIME)>='${froms[i]}')`
    ).join(' OR ');

    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: `
        SELECT DATE(CALL_TIME) AS dt,
          COUNT(CASE WHEN ${INBOUND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION='CONNECTED' THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${RCV_Q} AND SYSTEM_DISPOSITION IN ('CALL_NOT_PICKED','CALL_HANGUP') THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND HOUR(CALL_TIME) BETWEEN 11 AND 20 THEN 1 END),
          COUNT(CASE WHEN ${INBOUND} AND ${NL_COND} AND (HOUR(CALL_TIME) < 11 OR HOUR(CALL_TIME) >= 21) THEN 1 END)
        FROM ${TBL} WHERE (${cond}) GROUP BY dt ORDER BY dt DESC
      `}})
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    res.json({ dates: (d.data?.rows || []).map(r => ({
      dt: r[0], initiated: Number(r[1]), received: Number(r[2]),
      answered: Number(r[3]), missed: Number(r[4]),
      not_landed: Number(r[5]), nl_work: Number(r[6]), nl_nonwork: Number(r[7])
    }))});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Metabase — Raw call records for daily inbound
app.get('/api/raw-data', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  const mbQuery = async (sql) => {
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, native: { query: sql }, type: 'native' })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.data ? d.data.rows : [];
  };
  try {
    const CAMPAIGN = `CAMPAIGN_NAME = 'PartnerSupport-InboundCampaign' AND CALL_TYPE = 'inbound.call.dial'`;
    const TBL      = `PROD_DB.PUBLIC.AMEYO_CALL_DETAILS_REPORT`;
    const toIST    = `DATE(CALL_TIME)`;
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const limit    = 500;
    const offset   = (page - 1) * limit;
    let fromDate = req.query.from;
    let toDate   = req.query.to;
    if (!fromDate || !toDate) {
      const r = await mbQuery(`SELECT MAX(${toIST}) FROM ${TBL} WHERE ${CAMPAIGN}`);
      toDate = toDate || r[0][0]; fromDate = fromDate || r[0][0];
    }
    const dateFilter = `${CAMPAIGN} AND ${toIST} BETWEEN '${fromDate}' AND '${toDate}'`;

    const [countRow, dataRows] = await Promise.all([
      mbQuery(`SELECT COUNT(*) FROM ${TBL} WHERE ${dateFilter}`),
      mbQuery(`
        SELECT
          TO_CHAR(CONVERT_TIMEZONE('Asia/Kolkata', CALL_TIME::TIMESTAMP_TZ), 'DD-Mon-YYYY HH24:MI:SS') AS call_time,
          COALESCE(PHONE, '')                AS phone,
          COALESCE(DID, '')                  AS did,
          COALESCE(QUEUE_NAME, '')           AS queue_name,
          COALESCE(SYSTEM_DISPOSITION, '')   AS disposition,
          COALESCE(HANGUP_DETAILS, '')       AS hangup_details,
          COALESCE(IVR_TIME, '')             AS ivr_time,
          COALESCE(CUSTOMER_TALK_TIME, '')   AS customer_talk_time,
          COALESCE(USER_TALK_TIME, '')       AS user_talk_time,
          COALESCE(ACW_DURATION, '')         AS acw_duration,
          COALESCE(USER_NAME, '')            AS agent,
          COALESCE(CALL_NOTES, '')           AS call_notes
        FROM ${TBL}
        WHERE ${dateFilter}
        ORDER BY CALL_TIME DESC
        LIMIT ${limit} OFFSET ${offset}
      `)
    ]);

    const total = Number(countRow[0][0]);
    res.json({
      total, page, pages: Math.ceil(total / limit),
      rows: dataRows.map(r => ({
        call_time: r[0], phone: r[1], did: r[2], queue_name: r[3],
        disposition: r[4], hangup_details: r[5], ivr_time: r[6],
        customer_talk_time: r[7], user_talk_time: r[8], acw_duration: r[9],
        agent: r[10], call_notes: r[11]
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase proxy — list databases
app.get('/api/metabase/databases', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const response = await fetch(`${METABASE_URL}/api/database`, {
      headers: { 'x-api-key': METABASE_API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase proxy — run native SQL query
app.post('/api/metabase/query', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  const { database, sql } = req.body;
  if (!database || !sql) return res.status(400).json({ error: 'database and sql required' });
  try {
    const response = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database, native: { query: sql }, type: 'native' })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metabase proxy — list all dashboards
app.get('/api/metabase/dashboards', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const response = await fetch(`${METABASE_URL}/api/dashboard`, {
      headers: { 'x-api-key': METABASE_API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Kapture Ticket Detail — drill-down download ────────────────────────────
app.get('/api/kapture-tickets-detail', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const { from, to, queue } = req.query;
    if (!from || !to || !queue) return res.status(400).json({ error: 'from, to, queue required' });

    const ALL_QUEUES = ['Partner Trust Line','HH and HL','Bug Front','NQT','PTL to CX','New CSP App','Inventory Team','FInance Team','HH/HL'];
    const qIn = ALL_QUEUES.map(q => `'${q}'`).join(',');
    const queueFilter = queue === 'ALL'
      ? `(CURRENT_QUEUE_NAME IN (${qIn}) OR (CURRENT_QUEUE_NAME = 'CC' AND LANDING_FOLDER = 'Partner'))`
      : queue === 'CC (Partner)'
        ? `CURRENT_QUEUE_NAME = 'CC' AND LANDING_FOLDER = 'Partner'`
        : `CURRENT_QUEUE_NAME = '${queue.replace(/'/g, "''")}'`;

    const sql = `
      SELECT *
      FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
      WHERE (${queueFilter})
        AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') BETWEEN '${from}' AND '${to}'
        AND TRY_TO_NUMBER(LEFT(CREATED_TIME, 2)) BETWEEN 11 AND 20
        AND NOT (SUB_STATUS = 'Unattended' AND TRIM(COALESCE(DISPOSITION_FOLDER_LEVEL_3, '')) = '')
      QUALIFY ROW_NUMBER() OVER (PARTITION BY TICKET_NO ORDER BY INGESTED_AT DESC) = 1
      ORDER BY TO_DATE(CREATED_DATE, 'DD/MM/YYYY') DESC, CREATED_TIME DESC
    `;
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const cols = (d.data?.cols || []).map(c => c.name);
    const rows = d.data?.rows || [];
    // Return as CSV
    const escape = v => `"${(v ?? '').toString().replace(/"/g, '""')}"`;
    const csv = [cols.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kapture_${queue.replace(/[^a-z0-9]/gi,'_')}_${from}_${to}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── New CSP Ticket Metrics (GSheet phone+launchDate matched against Kapture PHONE column) ──
app.get('/api/newcsp-tickets', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const t          = new Date();
    const today      = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
    const monthStart = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-01`;
    const fromDate   = req.query.from || monthStart;
    const toDate     = req.query.to   || today;

    // 1. Partner list — use phones/froms params if provided (partner filter), else fetch all from GSheet
    let partners;
    const qPhones = (req.query.phones || '').split(',').map(s => s.trim()).filter(Boolean);
    const qFroms  = (req.query.froms  || '').split(',').map(s => s.trim()).filter(Boolean);
    if (qPhones.length && qPhones.length === qFroms.length) {
      partners = qPhones.map((ph, i) => ({ phone: ph, launchDate: qFroms[i] }));
    } else {
      partners = await fetchNewCSPPartners();
    }
    if (!partners.length) return res.json({ rows: [], from: fromDate, to: toDate });

    const DIFF     = `TRIM(COALESCE(DIFF_TIME_CREATED_AND_RESOLVE,''))`;
    const MINS     = `(TRY_TO_NUMBER(SPLIT_PART(DIFF_TIME_CREATED_AND_RESOLVE,':',1))*60 + TRY_TO_NUMBER(SPLIT_PART(DIFF_TIME_CREATED_AND_RESOLVE,':',2)))`;
    const AGE_MINS = `DATEDIFF('minute', TRY_TO_TIMESTAMP(CREATED_DATE||' '||CREATED_TIME,'DD/MM/YYYY HH24:MI:SS'), CURRENT_TIMESTAMP())`;

    // 2. Build per-partner condition (Kapture PHONE is stored as float → cast to INTEGER::VARCHAR)
    const cond = partners.map(p =>
      `(RIGHT(TRY_TO_NUMBER(COALESCE(PHONE,'0'))::INTEGER::VARCHAR,10)='${p.phone}' AND TO_DATE(CREATED_DATE,'DD/MM/YYYY')>='${p.launchDate}')`
    ).join(' OR ');

    const sql = `
      SELECT
        TO_DATE(CREATED_DATE, 'DD/MM/YYYY') AS dt,
        COUNT(DISTINCT TICKET_NO)                                                                                                 AS total,
        COUNT(DISTINCT CASE WHEN SUB_STATUS = 'Resolved on Call' THEN TICKET_NO END)                                             AS resolve_on_call,
        COUNT(DISTINCT CASE WHEN SUB_STATUS != 'Resolved on Call' THEN TICKET_NO END)                                            AS l2_tickets,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS}<=60   THEN TICKET_NO END) AS resolved_1hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS}<=240  THEN TICKET_NO END) AS resolved_4hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS}<=1440 THEN TICKET_NO END) AS resolved_24hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS}<=2880 THEN TICKET_NO END) AS resolved_48hr,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
          CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' THEN ${MINS} ELSE NULL END), 1) AS p50_mins,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
          CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' THEN ${MINS} ELSE NULL END), 1) AS p90_mins,
        COUNT(DISTINCT CASE WHEN STATUS!='Complete' AND SUB_STATUS!='Resolved on Call' AND ${AGE_MINS} > 240  THEN TICKET_NO END) AS pending_4hr,
        COUNT(DISTINCT CASE WHEN STATUS!='Complete' AND SUB_STATUS!='Resolved on Call' AND ${AGE_MINS} > 2880 THEN TICKET_NO END) AS pending_48hr
      FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
      WHERE (${cond})
        AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') BETWEEN '${fromDate}' AND '${toDate}'
        AND TRY_TO_NUMBER(LEFT(CREATED_TIME, 2)) BETWEEN 11 AND 20
        AND NOT (SUB_STATUS = 'Unattended' AND TRIM(COALESCE(DISPOSITION_FOLDER_LEVEL_3, '')) = '')
      GROUP BY 1
      ORDER BY 1 DESC
    `;

    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    const rows = (d.data?.rows || []).map(row => ({
      dt:              (row[0] || '').split('T')[0],
      total:           Number(row[1]),
      resolve_on_call: Number(row[2]),
      l2_tickets:      Number(row[3]),
      resolved_1hr:    Number(row[4]),
      resolved_4hr:    Number(row[5]),
      resolved_24hr:   Number(row[6]),
      resolved_48hr:   Number(row[7]),
      p50_mins:        row[8]  != null ? Number(row[8])  : null,
      p90_mins:        row[9]  != null ? Number(row[9])  : null,
      pending_4hr:     Number(row[10]),
      pending_48hr:    Number(row[11])
    }));

    res.json({ from: fromDate, to: toDate, rows, partners: partners.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Kapture Summary Dashboard ──────────────────────────────────────────────
app.get('/api/kapture-summary', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const today    = new Date().toISOString().slice(0, 10);
    const d30      = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fromDate = req.query.from || d30;
    const toDate   = req.query.to   || today;
    const QUEUES   = ['Partner Trust Line','HH and HL','Bug Front','NQT','PTL to CX','New CSP App','Inventory Team','FInance Team','HH/HL'];
    const qIn      = QUEUES.map(q => `'${q}'`).join(',');
    const DIFF     = `TRIM(COALESCE(DIFF_TIME_CREATED_AND_RESOLVE,''))`;
    const MINS     = `(TRY_TO_NUMBER(SPLIT_PART(DIFF_TIME_CREATED_AND_RESOLVE,':',1))*60 + TRY_TO_NUMBER(SPLIT_PART(DIFF_TIME_CREATED_AND_RESOLVE,':',2)))`;
    const AGE_MINS = `DATEDIFF('minute', TRY_TO_TIMESTAMP(CREATED_DATE||' '||CREATED_TIME,'DD/MM/YYYY HH24:MI:SS'), CURRENT_TIMESTAMP())`;
    const sql = `
      SELECT
        TO_DATE(CREATED_DATE, 'DD/MM/YYYY') AS dt,
        COUNT(DISTINCT TICKET_NO) AS total,
        COUNT(DISTINCT CASE WHEN SUB_STATUS = 'Resolved on Call' THEN TICKET_NO END) AS resolve_on_call,
        COUNT(DISTINCT CASE WHEN SUB_STATUS != 'Resolved on Call' THEN TICKET_NO END) AS l2_tickets,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS} <= 60   THEN TICKET_NO END) AS resolved_1hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS} <= 240  THEN TICKET_NO END) AS resolved_4hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS} <= 1440 THEN TICKET_NO END) AS resolved_24hr,
        COUNT(DISTINCT CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!='' AND ${MINS} <= 2880 THEN TICKET_NO END) AS resolved_48hr,
        COUNT(DISTINCT CASE WHEN SUB_STATUS = 'Resolved on Call' AND CURRENT_QUEUE_NAME = 'PTL to CX' THEN TICKET_NO END) AS resolve_on_call_ptl,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
          CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!=''
               THEN ${MINS} ELSE NULL END
        ), 1) AS p50_mins,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY
          CASE WHEN STATUS='Complete' AND SUB_STATUS!='Resolved on Call' AND ${DIFF}!=''
               THEN ${MINS} ELSE NULL END
        ), 1) AS p90_mins,
        COUNT(DISTINCT CASE WHEN STATUS!='Complete' AND SUB_STATUS!='Resolved on Call'
          AND ${AGE_MINS} > 240  THEN TICKET_NO END) AS pending_4hr,
        COUNT(DISTINCT CASE WHEN STATUS!='Complete' AND SUB_STATUS!='Resolved on Call'
          AND ${AGE_MINS} > 2880 THEN TICKET_NO END) AS pending_48hr
      FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
      WHERE (
        CURRENT_QUEUE_NAME IN (${qIn})
        OR (CURRENT_QUEUE_NAME = 'CC' AND LANDING_FOLDER = 'Partner')
      )
        AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') BETWEEN '${fromDate}' AND '${toDate}'
        AND TRY_TO_NUMBER(LEFT(CREATED_TIME, 2)) BETWEEN 11 AND 20
        AND NOT (SUB_STATUS = 'Unattended' AND TRIM(COALESCE(DISPOSITION_FOLDER_LEVEL_3, '')) = '')
      GROUP BY 1
      ORDER BY 1 DESC
    `;
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const rows = (d.data?.rows || []).map(r => ({
      dt:                  (r[0] || '').split('T')[0],
      total:               Number(r[1]),
      resolve_on_call:     Number(r[2]),
      l2_tickets:          Number(r[3]),
      resolved_1hr:        Number(r[4]),
      resolved_4hr:        Number(r[5]),
      resolved_24hr:       Number(r[6]),
      resolved_48hr:       Number(r[7]),
      resolve_on_call_ptl: Number(r[8]),
      p50_mins:            r[9]  != null ? Number(r[9])  : null,
      p90_mins:            r[10] != null ? Number(r[10]) : null,
      pending_4hr:         Number(r[11]),
      pending_48hr:        Number(r[12])
    }));
    res.json({ from: fromDate, to: toDate, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Kapture Ticket Report — date-wise queue breakdown ──────────────────────
app.get('/api/kapture-tickets', async (req, res) => {
  if (!METABASE_URL || !METABASE_API_KEY) return res.status(500).json({ error: 'Metabase not configured' });
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const d30    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fromDate = req.query.from || d30;
    const toDate   = req.query.to   || today;
    const QUEUES = ['Partner Trust Line','HH and HL','Bug Front','NQT','PTL to CX','New CSP App','Inventory Team','FInance Team','HH/HL'];
    const qIn = QUEUES.map(q => `'${q}'`).join(',');
    const sql = `
      SELECT
        TO_DATE(CREATED_DATE, 'DD/MM/YYYY') AS dt,
        CASE
          WHEN CURRENT_QUEUE_NAME = 'CC' AND LANDING_FOLDER = 'Partner' THEN 'CC (Partner)'
          ELSE CURRENT_QUEUE_NAME
        END AS queue,
        COUNT(DISTINCT TICKET_NO) AS cnt
      FROM PROD_DB.PUBLIC.KAPTURE_PARTNER_TICKETS_REPORT
      WHERE (
        CURRENT_QUEUE_NAME IN (${qIn})
        OR (CURRENT_QUEUE_NAME = 'CC' AND LANDING_FOLDER = 'Partner')
      )
        AND TO_DATE(CREATED_DATE, 'DD/MM/YYYY') BETWEEN '${fromDate}' AND '${toDate}'
        AND TRY_TO_NUMBER(LEFT(CREATED_TIME, 2)) BETWEEN 11 AND 20
        AND NOT (SUB_STATUS = 'Unattended' AND TRIM(COALESCE(DISPOSITION_FOLDER_LEVEL_3, '')) = '')
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2
    `;
    const r = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': METABASE_API_KEY },
      body: JSON.stringify({ database: 113, type: 'native', native: { query: sql } })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const rows = (d.data?.rows || []).map(r => ({
      dt: (r[0] || '').split('T')[0], queue: r[1], cnt: Number(r[2])
    }));
    res.json({ from: fromDate, to: toDate, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
