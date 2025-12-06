// server.js
require("dotenv").config();

const express = require("express");
const path = require("path");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Gemini setup ---
let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.warn(
    "WARNING: GEMINI_API_KEY is not set. Using fallback mock analysis."
  );
}

// --- Middleware & static files ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- File upload (in memory for now) ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// --- In-memory storage for calls (later you can move this to a DB) ---
let calls = [];

// --- Helpers ---

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn("Failed to parse JSON from Gemini:", e.message);
    return null;
  }
}

// Main AI function – detailed coaching + script adherence
async function analyzeWithGemini({ agentName, notes, transcript }) {
  const fallback = {
    qualityScore: 78,
    appointmentOutcome: "FollowUp",
    conversionLikelihood: "Medium",
    scriptAdherence: 0.75,
    skills: {
      discovery: 80,
      objectionHandling: 65,
      closing: 70,
      rapport: 90,
    },
    coachingSummary:
      "Good rapport. Improve discovery questions and make the closing clearer.",
    callTimeline: [
      {
        label: "Script Adherence",
        description: "Good opening and value statement.",
      },
      {
        label: "Objection",
        description: "Client raised price concerns mid-call.",
      },
    ],
    keyObjections: ["Price sensitivity"],
    strengths: ["Warm tone and rapport", "Clear explanation of benefits"],
    improvements: ["Ask more open-ended discovery questions"],
    coachingPlan: [
      "Roleplay 3 common price objections.",
      "Practice summarizing benefits before revealing price.",
    ],
    recommendedPhrases: [
      "What would make this valuable enough for you to test it for a month?",
    ],
    phrasesToAvoid: ["It's just our standard package."],
    raw: null,
  };

  if (!genAI) {
    return fallback;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a senior sales call coach for a telemarketing team that books discovery appointments.

You will receive:
1) Optional manager notes
2) Optional full transcript of the call

Your job is to analyze the call and tell us:
- Overall quality score
- How likely this call is to convert into an appointment
- How well the agent followed the script
- Which skills are strong / weak
- A coaching plan we can give to the agent
- What to KEEP (good phrases)
- What to REMOVE or avoid saying next time

IMPORTANT: Return ONLY valid JSON. No explanation, no backticks. Use this exact structure:

{
  "qualityScore": 0-100 integer,
  "appointmentOutcome": "Booked" | "FollowUp" | "NoNextStep",
  "conversionLikelihood": "High" | "Medium" | "Low",
  "scriptAdherencePercent": 0-100 number,
  "skills": {
    "discovery": 0-100,
    "objectionHandling": 0-100,
    "closing": 0-100,
    "rapport": 0-100
  },
  "coachingSummary": "short paragraph",
  "callTimeline": [
    {
      "label": "Script Adherence" | "Objection" | "InsightMoment",
      "description": "short description"
    }
  ],
  "keyObjections": ["list"],
  "strengths": ["what the agent did well"],
  "improvements": ["what to improve"],
  "coachingPlan": ["step-by-step coaching actions"],
  "recommendedPhrases": ["good phrases to use"],
  "phrasesToAvoid": ["phrases to avoid"]
}

Agent name: ${agentName || "Unknown"}

Manager notes:
"""${notes || "No notes provided."}"""

Transcript (if available):
"""${transcript || "Transcript not available."}"""
    `.trim();

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const json = safeParseJson(text);

    if (!json) {
      return { ...fallback, raw: text };
    }

    const scriptAdhPct =
      typeof json.scriptAdherencePercent === "number"
        ? json.scriptAdherencePercent
        : 100 * fallback.scriptAdherence;

    return {
      qualityScore: json.qualityScore ?? fallback.qualityScore,
      appointmentOutcome:
        json.appointmentOutcome ?? fallback.appointmentOutcome,
      conversionLikelihood:
        json.conversionLikelihood ?? fallback.conversionLikelihood,
      scriptAdherence: scriptAdhPct / 100,
      skills: json.skills ?? fallback.skills,
      coachingSummary: json.coachingSummary ?? fallback.coachingSummary,
      callTimeline: json.callTimeline ?? fallback.callTimeline,
      keyObjections: json.keyObjections ?? fallback.keyObjections,
      strengths: json.strengths ?? fallback.strengths,
      improvements: json.improvements ?? fallback.improvements,
      coachingPlan: json.coachingPlan ?? fallback.coachingPlan,
      recommendedPhrases:
        json.recommendedPhrases ?? fallback.recommendedPhrases,
      phrasesToAvoid: json.phrasesToAvoid ?? fallback.phrasesToAvoid,
      raw: text,
    };
  } catch (err) {
    console.error("Gemini analysis error:", err);
    return fallback;
  }
}

// --- Routes ---

// Serve main SPA
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// All calls (for dashboard / list)
app.get("/api/calls", (req, res) => {
  res.json(calls);
});

// Single call – for "View report"
app.get("/api/calls/:id", (req, res) => {
  const id = Number(req.params.id);
  const call = calls.find((c) => c.id === id);
  if (!call) {
    return res.status(404).json({ error: "Call not found" });
  }
  res.json(call);
});

// Upload + analyze
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    const { agentName, notes, transcript } = req.body;

    const ai = await analyzeWithGemini({ agentName, notes, transcript });

    let sentiment = "Needs Improvement";
    if (ai.qualityScore >= 85) sentiment = "Positive";
    else if (ai.qualityScore >= 75) sentiment = "Neutral";

    const callRecord = {
      id: calls.length + 1,
      agentName: agentName || "Unknown",
      notes: notes || "",
      transcript: transcript || "",
      filename: req.file ? req.file.originalname : "No file",
      qualityScore: ai.qualityScore,
      sentiment,
      appointmentOutcome: ai.appointmentOutcome,
      conversionLikelihood: ai.conversionLikelihood,
      scriptAdherence: ai.scriptAdherence,
      skills: ai.skills,
      coachingSummary: ai.coachingSummary,
      callTimeline: ai.callTimeline,
      keyObjections: ai.keyObjections,
      strengths: ai.strengths,
      improvements: ai.improvements,
      coachingPlan: ai.coachingPlan,
      recommendedPhrases: ai.recommendedPhrases,
      phrasesToAvoid: ai.phrasesToAvoid,
      createdAt: new Date().toISOString(),
    };

    // Put newest at top
    calls.unshift(callRecord);

    // After upload, go back to main page
    res.redirect("/");
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload / analysis failed.");
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`CallCoach AI listening on port ${PORT}`);
});

module.exports = app;
