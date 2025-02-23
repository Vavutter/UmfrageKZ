// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// --- OpenAI Setup ---
// Instead of requiring the package.json for version checking, we simply require the module.
const openaiModule = require("openai");

// Destructure using the expected export structure for openai v4+
const { Configuration, OpenAIApi } = openaiModule;
if (typeof Configuration !== "function" || typeof OpenAIApi !== "function") {
  console.error("Error: Failed to load Configuration or OpenAIApi from openai package.");
  process.exit(1);
}

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// --- Express App Setup ---
const app = express();
app.use(helmet());
app.use(express.json());

// Rate limiting to mitigate abuse
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
});
app.use(limiter);

// Secure session configuration (In production, use a persistent store)
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true if HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  }
}));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = socketIo(server);

// --- Survey Configuration ---
const surveyQuestions = [
  {
    id: 1,
    question: "Wie bewertest du den aktuellen Lehrplan?",
    options: ["Ausgezeichnet", "Gut", "Durchschnittlich", "Schlecht", "Sehr schlecht"]
  },
  {
    id: 2,
    question: "Welcher Bereich bedarf der größten Verbesserung?",
    options: ["Inhaltliche Qualität", "Lehrmethoden", "Ressourcen", "Struktur", "Bewertungsmethoden"]
  },
  {
    id: 3,
    question: "Wie wahrscheinlich ist es, dass du weitere Reformen unterstützt?",
    options: ["Sehr wahrscheinlich", "Wahrscheinlich", "Neutral", "Unwahrscheinlich", "Sehr unwahrscheinlich"]
  }
];

// In-memory aggregated survey results (for production, use a persistent database)
let surveyResults = {
  rating: [0, 0, 0, 0, 0],
  improvement: [0, 0, 0, 0, 0],
  support: [0, 0, 0, 0, 0]
};
let totalResponses = 0;

// --- AI Summary Storage ---
const secureDir = path.join(__dirname, 'secure');
if (!fs.existsSync(secureDir)) {
  fs.mkdirSync(secureDir);
}
const aiSummaryFilePath = path.join(secureDir, 'ai_summary.txt');
let currentAISummary = fs.existsSync(aiSummaryFilePath)
  ? fs.readFileSync(aiSummaryFilePath, 'utf8')
  : "";

const initialThresholds = [5, 15, 30, 65, 100];

async function generateAISummary() {
  let prompt = "Erstelle eine prägnante Zusammenfassung der folgenden Umfrageergebnisse:\n";
  prompt += "Frage 1 (Bewertung): " + surveyResults.rating.join(", ") + "\n";
  prompt += "Frage 2 (Verbesserung): " + surveyResults.improvement.join(", ") + "\n";
  prompt += "Frage 3 (Unterstützung): " + surveyResults.support.join(", ") + "\n";
  prompt += "Fasse die Haupttrends zusammen und gib Empfehlungen für zukünftige Reformen.";
  
  try {
    const completion = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: prompt,
      max_tokens: 150,
      temperature: 0.7,
    });
    const summaryText = completion.data.choices[0].text.trim();
    currentAISummary = summaryText;
    fs.writeFileSync(aiSummaryFilePath, currentAISummary, { encoding: 'utf8', flag: 'w' });
    console.log("AI Summary updated.");
    io.emit('updateResults', { surveyResults, totalResponses, currentAISummary });
  } catch (error) {
    console.error("Error generating AI summary:", error);
  }
}

// --- Endpoints ---
app.get('/survey', (req, res) => {
  res.json({ questions: surveyQuestions });
});

app.post('/submitSurvey', async (req, res) => {
  if (req.session.submitted) {
    return res.status(403).json({ error: 'Du hast bereits teilgenommen.' });
  }
  const { responses } = req.body;
  if (!Array.isArray(responses) || responses.length !== 3) {
    return res.status(400).json({ error: 'Ungültige Antworten.' });
  }
  if (responses.some(r => typeof r !== 'number' || r < 0 || r > 4)) {
    return res.status(400).json({ error: 'Ungültiger Antwortwert.' });
  }
  
  surveyResults.rating[responses[0]]++;
  surveyResults.improvement[responses[1]]++;
  surveyResults.support[responses[2]]++;
  totalResponses++;
  req.session.submitted = true;
  
  if (totalResponses < 100) {
    if (initialThresholds.includes(totalResponses)) {
      await generateAISummary();
    }
  } else {
    if ((totalResponses - 100) % 100 === 0) {
      await generateAISummary();
    }
  }
  
  io.emit('updateResults', { surveyResults, totalResponses, currentAISummary });
  return res.json({ success: true, results: surveyResults, totalResponses, currentAISummary });
});

app.get('/results', (req, res) => {
  res.json({ surveyResults, totalResponses, currentAISummary });
});

// --- Socket.IO for Real-Time Updates ---
io.on('connection', (socket) => {
  socket.emit('updateResults', { surveyResults, totalResponses, currentAISummary });
});

// --- Start the Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
