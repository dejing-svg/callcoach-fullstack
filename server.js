const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const port = process.env.PORT || 8080;

// In-memory "database"
const calls = [];

// File upload handler
const upload = multer({ dest: "/tmp" });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static UI
app.use(express.static(path.join(__dirname, "public")));

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Upload endpoint
app.post("/upload", upload.single("audio"), (req, res) => {
  const { agentName, notes } = req.body;

  // Mock AI analysis text
  const mockAnalysis = `Call by ${agentName || "Unknown"}.
- Talk ratio: 60% agent / 40% prospect (simulated)
- Objection handling: Needs improvement
- Coaching: Ask more open-ended questions and confirm next steps clearly.`;

  // Mock quality score & sentiment for now
  const qualityScore = Math.floor(60 + Math.random() * 40); // 60–99
  let sentiment = "Needs Improvement";
  if (qualityScore >= 85) sentiment = "Positive";
  else if (qualityScore >= 75) sentiment = "Neutral";

  const callRecord = {
    id: calls.length + 1,
    agentName: agentName || "Unknown",
    notes: notes || "",
    filename: req.file ? req.file.originalname : "No file",
    analysis: mockAnalysis,
    qualityScore,
    sentiment,
    source: "Upload", // later: Yeastar / Meet etc.
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
