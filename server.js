import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import multer from "multer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------- STATIC FRONTEND --------
app.use(express.static("public"));

// -------- DATA STORAGE --------
const DATA_FILE = "data.json";

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { scripts: "", calls: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// -------- GEMINI SETUP --------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// -------- MULTER FOR FILE UPLOADS --------
const upload = multer({ dest: "uploads/" });

// -------- ROUTES --------

// Get script
app.get("/script", (req, res) => {
  const data = loadData();
  res.json({ script: data.scripts || "" });
});

// Update script
app.post("/script", (req, res) => {
  const data = loadData();
  data.scripts = req.body.script || "";
  saveData(data);
  res.json({ success: true });
});

// Upload call file
app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const data = loadData();

  const entry = {
    id: Date.now(),
    filename: req.file.originalname,
    path: req.file.path,
    transcript: req.body.transcript || "",
    time: new Date().toISOString(),
  };

  data.calls.push(entry);
  saveData(data);

  res.json({ success: true, id: entry.id });
});

// Analyze call
app.post("/analyze", async (req, res) => {
  try {
    const { transcript } = req.body;
    const data = loadData();
    const script = data.scripts || "";

    const prompt = `
You are an expert sales QA coach. Analyze the following call transcript.

TRANSCRIPT:
${transcript}

SCRIPT TO MEASURE AGAINST:
${script}

Return JSON with:
{
  "score": number 1-100,
  "sentiment": "Positive/Neutral/Negative",
  "conversionLikelihood": "Low/Medium/High",
  "adherenceSummary": string,
  "objections": [list of key objections],
  "coachingPlan": [list of recommendations]
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.json({
        score: 70,
        sentiment: "Neutral",
        conversionLikelihood: "Medium",
        adherenceSummary: "Could not fully parse AI response.",
        objections: [],
        coachingPlan: ["Improve clarity", "Follow script more tightly"],
      });
    }

    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load calls
app.get("/calls", (req, res) => {
  const data = loadData();
  res.json(data.calls || []);
});

// Get single call
app.get("/calls/:id", (req, res) => {
  const data = loadData();
  const call = data.calls.find((c) => c.id == req.params.id);
  res.json(call || {});
});

// -------- START SERVER --------
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
