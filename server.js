const express = require("express");
const multer = require("multer");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 8080;

// In-memory "database" (reset when server restarts)
const calls = [];

// File upload handler
const upload = multer({ dest: "/tmp" });

// Gemini client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// --- Helper: safe JSON parsing from model output ---
function safeParseJson(text) {
  if (!text) return null;

  // strip ```json ... ``` if present
  const codeBlockMatch = text.match(/```json([\s\S]*?)```/i);
  const raw = codeBlockMatch ? codeBlockMatch[1] : text;

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to parse JSON from Gemini:", e.message);
    return null;
  }
}

// --- Helper: call Gemini to analyze the call ---
async function analyzeWithGemini({ agentName, notes }) {
  // Fallback if key not set
  const fallback = {
    qualityScore: 78,
    appointmentOutcome: "FollowUp", // Booked | FollowUp | NoNextStep
    scriptAdherence: 0.72, // 0–1
    skills: {
      discovery: 0.8,
      objectionHandling: 0.65,
      closing: 0.7,
      rapport: 0.9,
    },
    coachingSummary:
      "Focus on slowing down during discovery, confirming pain points, and being clearer on next steps. Overall, good rapport and tone.",
    raw: null,
  };

  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set – using fallback mock analysis.");
    return fallback;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a senior sales call coach for a telemarketing team.
You receive rough notes from the manager about a call.

Use the notes to INFER:
- overall call quality score (0–100)
- whether an APPOINTMENT was successfully booked
- how closely the agent followed the company's call script
- skill scores

Return ONLY valid JSON (no explanation, no backticks) with this shape:

{
  "qualityScore": 0-100 integer,
  "appointmentOutcome": "Booked" | "FollowUp" | "NoNextStep",
  "scriptAdherencePercent": 0-100 number,
  "skills": {
    "discovery": 0-100,
    "objectionHandling": 0-100,
    "closing": 0-100,
    "rapport": 0-100
  },
  "coachingSummary": "one short paragraph of coaching suggestions"
}

Agent name: ${agentName || "Unknown"}
Call notes:
"""${notes || "No notes provided."}"""
    `.trim();

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();

    const json = safeParseJson(text);
    if (!json) return { ...fallback, raw: text };

    const qualityScore =
      typeof json.qualityScore === "number" ? json.qualityScore : fallback.qualityScore;
    const appointmentOutcome =
      json.appointmentOutcome || fallback.appointmentOutcome;
    const scriptAdherencePercent =
      typeof json.scriptAdherencePercent === "number"
        ? json.scriptAdherencePercent
        : 100 * fallback.scriptAdherence;
    const skills = json.skills || fallback.skills;
    const coachingSummary = json.coachingSummary || fallback.coachingSummary;

    return {
      qualityScore,
      appointmentOutcome,
      scriptAdherence: scriptAdherencePercent / 100,
      skills,
      coachingSummary,
      raw: text,
    };
  } catch (err) {
    console.error("Gemini analysis error:", err);
    return fallback;
  }
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static UI
app.use(express.static(path.join(__dirname, "public")));

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload endpoint – now calls Gemini
app.post("/upload", upload.single("audio"), async (req, res) => {
  const { agentName, notes } = req.body;

  const ai = await analyzeWithGemini({ agentName, notes });

  let sentiment = "Needs Improvement";
  if (ai.qualityScore >= 85) sentiment = "Positive";
  else if (ai.qualityScore >= 75) sentiment = "Neutral";

  const callRecord = {
    id: calls.length + 1,
    agentName: agentName || "Unknown",
    notes: notes || "",
    filename: req.file ? req.file.originalname : "No file",
    analysis: ai.coachingSummary, // text shown in future detailed view
    qualityScore: ai.qualityScore,
    sentiment,
    appointmentOutcome: ai.appointmentOutcome, // Booked / FollowUp / NoNextStep
    scriptAdherence: ai.scriptAdherence, // 0–1
    skills: ai.skills,
    createdAt: new Date().toISOString(),
  };

  calls.unshift(callRecord);
  res.redirect("/");
});

// API for call history
app.get("/api/calls", (req, res) => {
  res.json(calls);
});

app.listen(port, () => {
  console.log(`CallCoach server running on port ${port}`);
});
