// ══════════════════════════════════════════════════════
// PTL Report — Google Apps Script Backend
// ══════════════════════════════════════════════════════

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('PTL Report')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Called from frontend via google.script.run
function analyzeText(text, apiKey) {
  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: 'You are analyzing customer/partner questions. Extract the core verbatim concern or query in 1 concise sentence. Do not add any explanation, just the verbatim.\n\nQuestion: ' + text + '\n\nVerbatim:'
      }]
    }),
    muteHttpExceptions: true
  });

  var data = JSON.parse(response.getContentText());
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text.trim();
}
