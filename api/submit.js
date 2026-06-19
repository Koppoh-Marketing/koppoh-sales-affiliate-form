const SHEET_ID = process.env.SALES_AFFILIATE_SHEET_ID || "16kETitvwChaGNRa2sH6wIs9rVhh2hWOfLAiD2sZra9c";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function prepareCredentials() {
  if (process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_JSON && !process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) {
    const p = path.join(os.tmpdir(), "gws-credentials.json");
    fs.writeFileSync(p, process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_JSON, { mode: 0o600 });
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = p;
  }
}

function getCredentials() {
  if (process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_JSON);
  }
  if (process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, "utf8"));
  }
  return null;
}

async function getAccessToken() {
  prepareCredentials();
  const creds = getCredentials();
  if (!creds?.client_id || !creds?.client_secret || !creds?.refresh_token) {
    throw new Error("Google credentials not configured");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function readSheet(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Applications!C2:C`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheet read failed: ${JSON.stringify(json)}`);
  return json.values || [];
}

async function appendRow(token, row) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Applications!A:R:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheet append failed: ${JSON.stringify(json)}`);
  return json;
}

function scoreApplication(data) {
  let score = 0;
  const hardFails = [];

  // Hard fails
  if (data.attendedWebinar === "No") hardFails.push("Did not attend webinar");
  if (data.morningCalls === "No") hardFails.push("Not willing to join morning calls");
  if (data.hoursPerDay === "Less than 1 hour") hardFails.push("Less than 1 hour per day");

  // Points
  const hoursScore = { "1 to 2 hours": 1, "2 to 4 hours": 2, "4 hours or more": 3 };
  score += hoursScore[data.hoursPerDay] || 0;
  score += data.morningCalls === "Yes" ? 2 : data.morningCalls === "Most days" ? 1 : 0;
  score += data.attendedWebinar === "Yes" ? 3 : data.attendedWebinar === "Watched the replay" ? 2 : 0;
  score += data.attendedOnboarding === "Yes" ? 2 : 0;
  score += data.soldBefore === "Yes" ? 2 : 0;
  score += data.hasNetwork === "Yes" ? 2 : data.hasNetwork === "Building one" ? 1 : 0;

  // Sales process answer quality
  const wordCount = String(data.salesProcess || "").trim().split(/\s+/).filter(Boolean).length;
  score += wordCount >= 40 ? 2 : wordCount >= 20 ? 1 : 0;

  let result;
  if (hardFails.length > 0) {
    result = "FAIL";
  } else if (score >= 8) {
    result = "PASS";
  } else if (score >= 5) {
    result = "BORDERLINE";
  } else {
    result = "FAIL";
  }

  return { score, hardFails, result };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!data.email || !data.name) {
      return res.status(400).json({ success: false, error: "Name and email are required" });
    }

    const token = await getAccessToken();

    // Check for duplicate email
    const existing = await readSheet(token);
    const emails = existing.flat().map(e => String(e).toLowerCase().trim());
    if (emails.includes(data.email.toLowerCase().trim())) {
      return res.status(409).json({ success: false, error: "DUPLICATE_EMAIL" });
    }

    const { score, hardFails, result } = scoreApplication(data);
    const timestamp = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });

    const row = [
      timestamp,
      data.name || "",
      data.email || "",
      data.phone || "",
      data.occupation || "",
      data.isStudent || "",
      data.hoursPerDay || "",
      data.morningCalls || "",
      data.attendedWebinar || "",
      data.attendedOnboarding || "",
      data.soldBefore || "",
      data.hasNetwork || "",
      data.salesProcess || "",
      data.whyJoin || "",
      data.heardFrom || "",
      score,
      hardFails.join("; ") || "None",
      result,
    ];

    await appendRow(token, row);

    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error("Submit error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
