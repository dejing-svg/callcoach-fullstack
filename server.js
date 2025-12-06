// server.js
// Simple full-stack backend for SalesAI Coach prototype

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Gemini setup ---------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn(
    "⚠️ GEMINI_API_KEY is not set. Calls to /api/calls/analyze will fail."
  );
}
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// --- Simple JSON 'DB' -----------------------------------------------------
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      calls: [],
      scripts: [
        {
          id: "default",
          name: "Outbound Cold Call – v1.0",
          active: true,
          content:
            "1. Greeting & intro\n2. Confirm role & context\n3. Pain discovery\n4. Introduce solution briefly\n5. Ask for discovery appointment\n6. Confirm time & next steps"
        }
      ]
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ensure file exists
saveData(loadData());

// --- Middleware -----------------------------------------------------------
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads/" }); // audio file placeholder

// --- Helpers --------------------------------------------------------------
function stripJson(code) {
  // Remove ```json ... ``` fences if model wraps response
  return code.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function summarizeAppointmentLikelihood(conversionScore) {
  if (conversionScore >= 80) return "Very high";
  if (conversionScore >= 60) return "High";
  if (conversionScore >= 40) return "Medium";
  return "Low";
}

// --- API: State -----------------------------------------------------------

// Get everything (calls + scripts)
app.get("/api/state", (req, res) => {
  const data = loadData();
  res.json(data);
});

// Get single call
app.get("/api/calls/:id", (req, res) => {
  const data = loadData();
  const call = data.calls.find((c) => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: "Call not found" });
  res.json(call);
});

// Get scripts
app.get("/api/scripts", (req, res) => {
  const data = loadData();
  res.json(data.scripts);
});

// Update a script (content and active flag)
app.put("/api/scripts/:id", (req, res) => {
  const { content, name, active } = req.body;
  const data = loadData();
  const script = data.scripts.find((s) => s.id === req.params.id);
  if (!script) return res.status(404).json({ error: "Script not found" });

  if (typeof content === "string") script.content = content;
  if (typeof name === "string") script.name = name;
  if (typeof active === "boolean") {
    data.scripts.forEach((s) => (s.active = false));
    script.active = active;
  }

  saveData(data);
  res.json(script);
});

// --- API: Analyze call ----------------------------------------------------
// For now we expect a transcript text (can be pasted from Yeastar / Meet).
// Audio file upload is accepted but not yet auto-transcribed in this version.

app.post(
  "/api/calls/analyze",
  upload.single("audioFile"),
  async (req, res) => {
    try {
      if (!genAI) {
        return res
          .status(500)
          .json({ error: "GEMINI_API_KEY not configured on server" });
      }

      const { agentName, transcript, notes } = req.body;
      const cleanAgent = agentName && agentName.trim().length
        ? agentName.trim()
        : "Unknown";

      if (!transcript || !transcript.trim()) {
        return res
          .status(400)
          .json({ error: "Transcript text is required for analysis." });
      }

      const data = loadData();
      const activeScript =
        data.scripts.find((s) => s.active) || data.scripts[0];

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash"
      });

      const prompt = `
You are an expert B2B sales coach for a digital marketing agency that sells retainers and discovery calls.

Company context:
- We run a telemarketing team to book discovery calls for our digital marketing services.
- Good calls should: build rapport, confirm role, explore pain, position our solution, and ask clearly for an appointment with next steps.

Here is the OFFICIAL CALL SCRIPT we use (company playbook):

"""
${activeScript.content}
"""

Here is the full call transcript between our agent and a prospect:

"""
${transcript}
"""

TASK:
1. Evaluate the call and output STRICT JSON ONLY (no commentary, no markdown).
2. Score and analyze using this JSON schema:

{
  "qualityScore": 0-100,                 // overall call quality
  "sentiment": "Positive|Neutral|Negative",
  "conversionLikelihoodScore": 0-100,    // likelihood this call leads to appointment
  "scriptAdherenceScore": 0-100,         // how closely the agent followed the script
  "scriptAdherenceSummary": "string",    // 1-2 sentence summary
  "timeline": [
    {
      "label": "Opening & rapport",
      "type": "script_adherence|objection|insight",
      "summary": "short description",
      "moment": "MM:SS"
    }
  ],
  "keyObjections": [
    "one sentence per objection, if any"
  ],
  "improvementAreas": [
    "very specific coaching item, e.g. 'Ask for budget earlier'"
  ],
  "coachingPlan": [
    "very concrete coaching actions, e.g. roleplay this scenario, rewrite opener, etc."
  ],
  "appointmentRecommendation": "Short advice on what the agent should do next for this lead."
}

Respond with JSON that can be parsed directly by JSON.parse() in JavaScript.
`;

      const result = await model.generateContent(prompt);
      let text = result.response.text();

      // Sometimes model wraps JSON in ``` fences
      text = stripJson(text);

      let analysis;
      try {
        analysis = JSON.parse(text);
      } catch (e) {
        console.error("Failed to parse JSON from model:", e, text);
        return res.status(500).json({
          error: "Failed to parse analysis from model.",
          raw: text
        });
      }

      const now = new Date().toISOString();
      const id = Date.now().toString();

      const callRecord = {
        id,
        createdAt: now,
        agentName: cleanAgent,
        notes: notes || "",
        transcript,
        sentiment: analysis.sentiment || "Unknown",
        qualityScore: analysis.qualityScore ?? 0,
        conversionLikelihoodScore:
          analysis.conversionLikelihoodScore ?? 0,
        conversionLikelihoodText: summarizeAppointmentLikelihood(
          analysis.conversionLikelihoodScore ?? 0
        ),
        scriptAdherenceScore: analysis.scriptAdherenceScore ?? 0,
        scriptAdherenceSummary: analysis.scriptAdherenceSummary || "",
        timeline: analysis.timeline || [],
        keyObjections: analysis.keyObjections || [],
        improvementAreas: analysis.improvementAreas || [],
        coachingPlan: analysis.coachingPlan || [],
        appointmentRecommendation:
          analysis.appointmentRecommendation || "",
        raw: analysis
      };

      data.calls.unshift(callRecord); // newest first
      saveData(data);

      res.json(callRecord);
    } catch (err) {
      console.error("Error in /api/calls/analyze", err);
      res.status(500).json({ error: "Internal error analyzing call." });
    } finally {
      // cleanup uploaded audio to avoid filling disk
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
    }
  }
);

// --- Fallback: send index.html for any unknown route (SPA) --------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Start server --------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
