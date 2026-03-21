const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

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
  fetchCsv(url, [], 5, res);
});

// Claude API — extract verbatim from question
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
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `You are analyzing customer/partner questions. Extract the core verbatim concern or query in 1 concise sentence. Do not add any explanation, just the verbatim.\n\nQuestion: ${text}\n\nVerbatim:`
        }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.json({ verbatim: data.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hardcoded sheet URLs
const PTL_CSV     = 'https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv';
const INBOUND_CSV = 'https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv&gid=1325902355';

app.get('/api/ptl-data',     (req, res) => fetchCsv(PTL_CSV,     [], 5, res));
app.get('/api/inbound-data', (req, res) => fetchCsv(INBOUND_CSV, [], 5, res));

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

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
