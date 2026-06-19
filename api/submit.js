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

async function readEmailColumn(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Applications!C2:C`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheet read failed: ${JSON.stringify(json)}`);
  return (json.values || []).flat().map(e => String(e).toLowerCase().trim());
}

async function appendRow(token, row) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Applications!A:S:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
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

function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function hasKeywords(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.filter(k => lower.includes(k)).length;
}

function scoreApplication(data) {
  let score = 0;
  const hardFails = [];
  const scoreBreakdown = {};

  // ── Hard fails ───────────────────────────────────────────────
  if (data.morningCalls === "No") {
    hardFails.push("Not willing to join morning calls");
  }
  if (data.webinarAvailability === "No") {
    hardFails.push("Cannot attend Monday/Friday webinars");
  }
  if (data.hoursPerDay === "Less than 1 hour") {
    hardFails.push("Less than 1 hour per day");
  }
  if (data.attendedOnboarding === "No") {
    hardFails.push("Did not attend onboarding session");
  }

  // ── Availability (max 6) ─────────────────────────────────────
  const hoursScore = { "1 to 2 hours": 1, "2 to 4 hours": 2, "4 hours or more": 3 };
  const avHours = hoursScore[data.hoursPerDay] || 0;
  const avWebinar = data.webinarAvailability === "Yes" ? 3 : data.webinarAvailability === "Most weeks" ? 1 : 0;
  scoreBreakdown.availability = avHours + avWebinar;
  score += scoreBreakdown.availability;

  // ── Time commitment (max 4) ──────────────────────────────────
  const tcMorning = data.morningCalls === "Yes" ? 2 : data.morningCalls === "Most days" ? 1 : 0;
  const tcOnboarding = data.attendedOnboarding === "Yes" ? 2 : 0;
  scoreBreakdown.timeCommitment = tcMorning + tcOnboarding;
  score += scoreBreakdown.timeCommitment;

  // ── Experience & willingness (max 4) ─────────────────────────
  const expSold = data.soldBefore === "Yes" ? 2 : 0;
  const expNetwork = data.hasNetwork === "Yes" ? 2 : data.hasNetwork === "Building one" ? 1 : 0;
  scoreBreakdown.experience = expSold + expNetwork;
  score += scoreBreakdown.experience;

  // ── Sales process understanding (max 6) ──────────────────────
  const salesWords = words(data.salesProcess);
  const salesKeywords = ["find", "identify", "prospect", "qualify", "pitch", "present", "close",
    "follow", "objection", "convert", "lead", "client", "need", "solution", "relationship",
    "persuade", "communicate", "trust", "value", "revenue", "target"];
  const salesKwHits = hasKeywords(data.salesProcess, salesKeywords);
  const salesWordScore = salesWords.length >= 50 ? 3 : salesWords.length >= 25 ? 2 : salesWords.length >= 10 ? 1 : 0;
  const salesKwScore = salesKwHits >= 4 ? 3 : salesKwHits >= 2 ? 2 : salesKwHits >= 1 ? 1 : 0;
  scoreBreakdown.salesProcessScore = Math.min(6, salesWordScore + salesKwScore);
  score += scoreBreakdown.salesProcessScore;

  // ── Koppoh/BOP understanding (max 4) ─────────────────────────
  const bopWords = words(data.koppohUnderstanding);
  const bopKeywords = ["photography", "photographer", "business", "course", "programme", "program",
    "bedge", "koppoh", "bop", "income", "premium", "learn", "skill", "entrepreneur", "creative",
    "money", "booking", "client", "training", "mentor"];
  const bopKwHits = hasKeywords(data.koppohUnderstanding, bopKeywords);
  const bopWordScore = bopWords.length >= 40 ? 2 : bopWords.length >= 15 ? 1 : 0;
  const bopKwScore = bopKwHits >= 3 ? 2 : bopKwHits >= 1 ? 1 : 0;
  scoreBreakdown.bopUnderstanding = Math.min(4, bopWordScore + bopKwScore);
  score += scoreBreakdown.bopUnderstanding;

  // ── Result (total max 24) ─────────────────────────────────────
  let result;
  if (hardFails.length > 0) {
    result = "FAIL";
  } else if (score >= 15) {
    result = "PASS";
  } else if (score >= 10) {
    result = "BORDERLINE";
  } else {
    result = "FAIL";
  }

  return { score, hardFails, result, scoreBreakdown };
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

    // Duplicate email check
    const existingEmails = await readEmailColumn(token);
    if (existingEmails.includes(data.email.toLowerCase().trim())) {
      return res.status(409).json({ success: false, error: "DUPLICATE_EMAIL" });
    }

    const { score, hardFails, result, scoreBreakdown } = scoreApplication(data);
    const timestamp = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });

    const row = [
      timestamp,
      data.name || "",
      data.email || "",
      data.phone || "",
      data.occupation || "",
      data.hoursPerDay || "",
      data.morningCalls || "",
      data.webinarAvailability || "",
      data.attendedOnboarding || "",
      data.soldBefore || "",
      data.hasNetwork || "",
      data.salesProcess || "",
      data.koppohUnderstanding || "",
      data.whyJoin || "",
      data.heardFrom || "",
      score,
      hardFails.join("; ") || "None",
      result,
      JSON.stringify(scoreBreakdown),
    ];

    await appendRow(token, row);

    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error("Submit error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
