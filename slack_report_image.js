/**
 * slack_report_image.js
 * Generates a beautiful PNG report card and uploads it to Slack.
 * Usage: node slack_report_image.js
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const SLACK_TOKEN   = process.env.SLACK_BOT_TOKEN || '';  // set via env var
const SLACK_CHANNEL = process.argv[2] || 'C0AJZBS9GFM'; // channel from CLI arg or default

// ── helpers ──────────────────────────────────────────────────────────────────

function get(url, cookies = [], left = 6) {
  return new Promise((res, rej) => {
    if (left <= 0) return rej(new Error('Too many redirects'));
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookies.join('; ') } }, r => {
      const nc = [...cookies, ...(r.headers['set-cookie'] || []).map(c => c.split(';')[0])];
      if ([301,302,303,307,308].includes(r.statusCode)) { r.resume(); return res(get(r.headers.location, nc, left-1)); }
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    });
    req.on('error', rej);
    req.setTimeout(20000, () => { req.destroy(); rej(new Error('Timeout')); });
  }).then(v => v instanceof Promise ? v : v);
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const parseRow = line => {
    const vals = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim()); return vals;
  };
  const headers = parseRow(lines[0]).map(h => h.replace(/^"|"$/g,'').trim());
  return { headers, rows: lines.slice(1).map(l => { const v = parseRow(l); const o = {}; headers.forEach((h,i) => o[h] = v[i]||''); return o; }) };
}

function normDate(d) {
  if (!d) return null;
  const m1 = String(d).match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null;
}

function parseHrs(t) {
  const m = String(t||'').match(/^(\d+):(\d+):(\d+)/);
  return m ? +m[1] + +m[2]/60 + +m[3]/3600 : NaN;
}

function pct(a,b) { return b ? (a/b*100).toFixed(1)+'%' : 'N/A'; }
function fmtH(v)  { return isNaN(v)||v==null ? 'N/A' : v.toFixed(2)+' hrs'; }

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const i = (p/100)*(arr.length-1), lo = Math.floor(i), hi = Math.ceil(i);
  return arr[lo] + (arr[hi]-arr[lo])*(i-lo);
}

function fmtDate(dk) {
  return new Date(dk+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}

// ── PTL metrics ───────────────────────────────────────────────────────────────

function calcPTL(rows) {
  const total = rows.length;
  const roc   = rows.filter(r => String(r['Sub Status']||'').toLowerCase().includes('resolve')).length;
  const tickets = total - roc;
  const comp    = rows.filter(r => String(r['Sub Status']||'').toLowerCase().includes('complet'));
  const times   = comp.map(r => parseHrs(r['Diff Time Created And Resolve'])).filter(v=>!isNaN(v)).sort((a,b)=>a-b);
  const w4h     = times.filter(t=>t<=4).length;
  const now     = new Date();
  const openRows = rows.filter(r => String(r['Sub Status']||'').toLowerCase().includes('open'));
  let pend4h=0, pend48h=0;
  openRows.forEach(r => {
    const dk = normDate(r['Created Date']);
    if (!dk) return;
    const ts = String(r['Created Time'] || '').trim();
    let dt = new Date(`${dk}T${ts}`);
    if (isNaN(dt.getTime())) dt = new Date(`${dk}T00:00:00`); // fallback to midnight
    if (isNaN(dt.getTime())) return;
    const age = (now - dt) / 3600000;
    if (age > 4)  pend4h++;
    if (age > 48) pend48h++;
  });
  return { total, roc, rocPct: pct(roc,total), tickets, w4h, w4hPct: pct(w4h,tickets),
           p50: percentile(times,50), p90: percentile(times,90), pend4h, pend48h };
}

// ── Inbound metrics ───────────────────────────────────────────────────────────

function getTimeSecs(raw) {
  const p = String(raw||'').trim().split(' ');
  if (p.length < 2) return null;
  const tp = p[1].split(':'); const ampm = (p[2]||'').toUpperCase();
  let h = +tp[0], m = +tp[1]||0, s = +tp[2]||0;
  if (isNaN(h)) return null;
  if (ampm==='PM'&&h!==12) h+=12;
  if (ampm==='AM'&&h===12) h=0;
  return h*3600+m*60+s;
}

function calcInbound(rows) {
  let notLandW=0, notLandNW=0;
  rows.forEach(r => {
    if (!String(r['Queue Name']||'').trim()) {
      const s = getTimeSecs(r['Call Time']);
      if (s!==null && s>=39600 && s<=75600) notLandW++; else notLandNW++;
    }
  });
  const rcvd = rows.filter(r => String(r['Queue Name']||'').trim()).length;
  const ans  = rows.filter(r => String(r['Queue Name']||'').trim() && String(r['System Disposition']||'').trim().toUpperCase()==='CONNECTED').length;
  return { total: rows.length, notLandW, notLandNW, rcvd, ans, ansPct: pct(ans,rcvd) };
}

// ── HTML template ─────────────────────────────────────────────────────────────

function buildHtml(ftdKey, ptlFtd, ptlMtd, inbFtd, inbMtd, mo, yr) {
  const dateStr  = fmtDate(ftdKey);
  const moName   = new Date(`${yr}-${mo}-01`).toLocaleString('en-IN',{month:'long'});
  const now      = new Date().toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});

  const row = (label, ftdVal, mtdVal, color='#e2e8f0') => `
    <tr>
      <td class="label">${label}</td>
      <td class="val" style="color:${color}">${ftdVal}</td>
      <td class="val mtd" style="color:${color}">${mtdVal}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;padding:32px;width:720px}
  .card{background:#1e293b;border-radius:16px;padding:24px 28px;margin-bottom:20px;border:1px solid #334155}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
  .brand{font-size:26px;font-weight:800;color:#fbbf24;letter-spacing:1px}
  .brand span{color:#f59e0b;font-size:14px;font-weight:400;display:block;margin-top:2px}
  .datebadge{background:#1a2744;border:1px solid #3b5bdb;border-radius:10px;padding:8px 16px;text-align:right}
  .datebadge .ftd{font-size:15px;font-weight:700;color:#93c5fd}
  .datebadge .mtd{font-size:12px;color:#94a3b8;margin-top:2px}
  .section-title{font-size:12px;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .section-title::after{content:'';flex:1;height:1px;background:#475569}
  table{width:100%;border-collapse:collapse}
  thead th{font-size:11px;font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.5px;padding:0 0 10px 0;border-bottom:2px solid #475569}
  thead th:first-child{text-align:left}
  thead th:not(:first-child){text-align:right}
  .label{font-size:13px;color:#cbd5e1;padding:9px 0;border-bottom:1px solid #334155}
  .val{font-size:14px;font-weight:700;text-align:right;padding:9px 0;border-bottom:1px solid #334155}
  .mtd{color:#94a3b8!important;font-weight:600!important}
  .footer{text-align:center;color:#94a3b8;font-size:11px;margin-top:8px}
  .divider{height:1px;background:#334155;margin:20px 0}
  .tag{display:inline-block;background:#1a2744;border:1px solid #3b5bdb;border-radius:6px;padding:3px 10px;font-size:11px;color:#93c5fd;margin-right:6px}
</style></head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand">📊 PTL Management Report<span>Daily Performance Summary</span></div>
      <div class="datebadge">
        <div class="ftd">📅 FTD: ${dateStr}</div>
        <div class="mtd">MTD: ${moName} ${yr}</div>
      </div>
    </div>

    <!-- PTL Section -->
    <div class="section-title">📋 PTL Management</div>
    <table>
      <thead><tr>
        <th>Metric</th>
        <th>FTD</th>
        <th>MTD</th>
      </tr></thead>
      <tbody>
        ${row('Total Tickets Created',  ptlFtd.total,   ptlMtd.total,   '#e2e8f0')}
        ${row('Resolve on Call (ROC)',  ptlFtd.roc,     ptlMtd.roc,     '#22c55e')}
        ${row('ROC %',                  ptlFtd.rocPct,  ptlMtd.rocPct,  '#22c55e')}
        ${row('L2 Tickets',            ptlFtd.tickets, ptlMtd.tickets, '#e2e8f0')}
        ${row('Within 4 hrs',          ptlFtd.w4h,     ptlMtd.w4h,     '#818cf8')}
        ${row('W4h %',                 ptlFtd.w4hPct,  ptlMtd.w4hPct,  '#818cf8')}
        ${row('P50 Resolution',        fmtH(ptlFtd.p50), fmtH(ptlMtd.p50), '#fbbf24')}
        ${row('P90 Resolution',        fmtH(ptlFtd.p90), fmtH(ptlMtd.p90), '#fbbf24')}
        ${row('Pending > 4 hrs',       ptlFtd.pend4h,  ptlMtd.pend4h,  '#fb923c')}
        ${row('Pending > 48 hrs',      ptlFtd.pend48h, ptlMtd.pend48h, '#f87171')}
      </tbody>
    </table>

    <div class="divider"></div>

    <!-- Inbound Section -->
    <div class="section-title">📞 Inbound Calls</div>
    <table>
      <thead><tr>
        <th>Metric</th>
        <th>FTD</th>
        <th>MTD</th>
      </tr></thead>
      <tbody>
        ${row('Total Call Initiate',         inbFtd.total,    inbMtd.total,    '#e2e8f0')}
        ${row('Call Received (Landed)',      inbFtd.rcvd,     inbMtd.rcvd,     '#fbbf24')}
        ${row('Call Answered',               inbFtd.ans,      inbMtd.ans,      '#22c55e')}
        ${row('Answered %',                  inbFtd.ansPct,   inbMtd.ansPct,   '#22c55e')}
        ${row('Not Landed (Working Hrs)',    inbFtd.notLandW, inbMtd.notLandW, '#f87171')}
        ${row('Not Landed (Non-Work Hrs)',   inbFtd.notLandNW,inbMtd.notLandNW,'#fb923c')}
      </tbody>
    </table>
  </div>

  <div class="footer">Generated at ${now} &nbsp;|&nbsp; <span class="tag">PTL Report</span><span class="tag">Auto Report</span></div>
</body></html>`;
}

// ── Screenshot via Puppeteer ──────────────────────────────────────────────────

async function screenshot(html, outPath) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.setViewport({ width: 720, height: 10, deviceScaleFactor: 2 });
  const body = await page.$('body');
  await body.screenshot({ path: outPath, type: 'png' });
  await browser.close();
}

// ── Slack upload (new API) ────────────────────────────────────────────────────

function slackPost(path, payload, useForm = false) {
  return new Promise((res, rej) => {
    let body, contentType;
    if (useForm) {
      body = Object.entries(payload).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      contentType = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(payload);
      contentType = 'application/json';
    }
    const req = https.request({
      hostname: 'slack.com', path, method: 'POST',
      headers: { Authorization: 'Bearer '+SLACK_TOKEN, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}

function slackPut(uploadUrl, fileBuffer) {
  return new Promise((res, rej) => {
    const u = new URL(uploadUrl);
    const req = https.request({
      hostname: u.hostname, path: u.pathname+u.search, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SLACK_TOKEN,
        'Content-Type': 'image/png',
        'Content-Length': fileBuffer.length
      }
    }, r => {
      let d='';
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.end(fileBuffer);
  });
}

async function uploadImageToSlack(imgPath, ftdKey) {
  const buf   = fs.readFileSync(imgPath);
  const fname = `report_${ftdKey}.png`;

  // Step 1: get upload URL
  const urlResp = await slackPost('/api/files.getUploadURLExternal', { filename: fname, length: buf.length, content_type: 'image/png' }, true);
  if (!urlResp.ok) throw new Error('getUploadURLExternal failed: ' + urlResp.error);

  // Step 2: POST file to upload URL
  const putResp = await slackPut(urlResp.upload_url, buf);
  if (putResp.status !== 200) throw new Error('File upload failed: HTTP ' + putResp.status + ' | ' + putResp.body);

  // Step 3: complete upload
  const complete = await slackPost('/api/files.completeUploadExternal', {
    files: JSON.stringify([{ id: urlResp.file_id }])
  }, true);
  if (!complete.ok) throw new Error('completeUploadExternal failed: ' + complete.error);

  const permalink = complete.files?.[0]?.permalink;

  // Step 4: post message with permalink — Slack unfurls it as image
  const msgResp = await slackPost('/api/chat.postMessage', {
    channel: SLACK_CHANNEL,
    username: 'Trust Line Report',
    text: `*📊 PTL Management Report — ${fmtDate(ftdKey)}*\n_PTL Report | Auto-generated_\n${permalink}`,
    unfurl_links: true,
    unfurl_media: true
  });
  if (!msgResp.ok) throw new Error('chat.postMessage failed: ' + msgResp.error);
  return msgResp;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📥 Fetching PTL data...');
  const ptlCsv = await get('http://localhost:3001/api/sheet?url=' + encodeURIComponent('https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv'));
  const { rows: ptlRows } = parseCSV(ptlCsv);

  console.log('📥 Fetching Inbound data...');
  const inbCsv  = await get('https://docs.google.com/spreadsheets/d/1lbb8ZJn0az-ueBguxwkFQ6d6pvgADGHTEWmMmy7uPSI/export?format=csv&gid=1325902355');
  const inbRows = parseCSV(inbCsv).rows;

  // Group PTL by date
  const ptlByDate = {};
  ptlRows.forEach(r => { const d = normDate(r['Created Date']); if (d) { ptlByDate[d] = ptlByDate[d]||[]; ptlByDate[d].push(r); } });
  const ptlDates = Object.keys(ptlByDate).sort();
  if (!ptlDates.length) { console.log('No PTL data'); return; }
  const ftdKey = ptlDates[ptlDates.length-1];
  const [yr, mo] = ftdKey.split('-');

  const ptlFtd  = calcPTL(ptlByDate[ftdKey]);
  const ptlMtd  = calcPTL(ptlRows.filter(r => { const d=normDate(r['Created Date']); return d&&d.startsWith(`${yr}-${mo}`); }));
  const ptlAll  = calcPTL(ptlRows); // for total pending (current open count across all dates)
  ptlMtd.pend4h  = ptlAll.pend4h;
  ptlMtd.pend48h = ptlAll.pend48h;

  // Group Inbound by date
  const inbByDate = {};
  inbRows.forEach(r => { const d = normDate(String(r['Call Time']||'').split(' ')[0]); if (d) { inbByDate[d]=inbByDate[d]||[]; inbByDate[d].push(r); } });
  const inbFtd = inbByDate[ftdKey] ? calcInbound(inbByDate[ftdKey]) : { total:0, notLandW:0, notLandNW:0, rcvd:0, ans:0, ansPct:'N/A' };
  const inbMtd = calcInbound(inbRows.filter(r => { const d=normDate(String(r['Call Time']||'').split(' ')[0]); return d&&d.startsWith(`${yr}-${mo}`); }));

  console.log('🎨 Building report image...');
  const html    = buildHtml(ftdKey, ptlFtd, ptlMtd, inbFtd, inbMtd, mo, yr);
  const outPath = path.join('C:\\Users\\DELL', `report_${ftdKey}.png`);
  await screenshot(html, outPath);
  console.log('✅ Image saved:', outPath);

  console.log('📤 Uploading to Slack...');
  const result = await uploadImageToSlack(outPath, ftdKey);
  console.log('✅ Sent to Slack!', result.ok ? 'OK' : result.error);

  // Cleanup temp file
  try { fs.unlinkSync(outPath); } catch(e) {}
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
