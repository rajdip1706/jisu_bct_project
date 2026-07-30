// Voyage — AI Trip Planner backend
// Serves the frontend and calls the free Groq API to generate itineraries
// that include: day-by-day plans, mappable stops (for the route feature),
// and a per-day cost breakdown (for the budget feature).
// Live weather is fetched directly from the free Open-Meteo API on the
// frontend, so no backend code or API key is needed for that part.

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const API_KEY = process.env.GROQ_API_KEY;

// Simple file-based store for shareable trip links — no database needed.
const TRIPS_DIR = path.join(__dirname, "data", "trips");
fs.mkdirSync(TRIPS_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Serve the renamed frontend entry file at "/"
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "trip.html"));
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY) });
});

// Calls Groq and parses the itinerary JSON, retrying once if the first
// response isn't valid JSON (small models occasionally add stray text).
async function requestItinerary(userPrompt, attempt = 1) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4500,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an expert travel planner with deep, accurate knowledge of real places. You always respond with strictly valid JSON matching the requested schema, and nothing else — no markdown code fences, no preamble, no trailing commentary. Numeric fields are always plain numbers, never strings. Every named place must be a real, verifiable location.",
        },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Groq API returned status ${response.status}: ${errText}`);
    err.status = 502;
    err.userMessage = `The Groq API returned an error (status ${response.status}). Check your API key at console.groq.com.`;
    throw err;
  }

  const data = await response.json();
  const rawText =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";

  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error(`Failed to parse model output as JSON (attempt ${attempt}):`, cleaned);
    if (attempt < 2) {
      return requestItinerary(userPrompt, attempt + 1);
    }
    const err = new Error("Model output could not be parsed as JSON after retry.");
    err.status = 502;
    err.userMessage = "The AI response could not be parsed. Please try again.";
    throw err;
  }
}

app.post("/api/plan", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error:
          "No GROQ_API_KEY found. Copy .env.example to .env and add your free key from https://console.groq.com/keys, then restart the server.",
      });
    }

    const { destination, days, travelers, budget, pace, interests, notes, startDate } = req.body || {};

    if (!destination || !days) {
      return res.status(400).json({ error: "Destination and number of days are required." });
    }

    const interestList =
      Array.isArray(interests) && interests.length ? interests.join(", ") : "a good general mix";

    const dateContext = startDate
      ? `- Trip starts on: ${startDate} (use this to inform seasonal tips, e.g. weather/events typical for that time of year)`
      : `- Exact travel dates: not provided`;

    const userPrompt = `Plan a trip with these details:
- Destination: ${destination}
- Trip length: ${days} day(s)
- Number of travelers: ${travelers || "1"}
- Budget level: ${budget || "moderate"}
- Preferred pace: ${pace || "balanced"}
- Interests: ${interestList}
- Extra notes from the traveler: ${notes || "none"}
${dateContext}

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "destination": string,
  "summary": string (2-3 sentences setting the scene for this trip),
  "totalBudgetEstimateUsd": number (a single rough whole-USD total for the ENTIRE trip for the whole group, your own independent estimate),
  "quickFacts": {
    "localCurrency": string (e.g. "Japanese Yen (JPY)"),
    "localLanguage": string (main local language(s)),
    "bestTimeToVisit": string (short phrase, e.g. "March-May and Sept-Nov"),
    "tippingNorm": string (one short sentence on local tipping etiquette)
  },
  "packingTips": [string, string, string] (3 short, destination-specific packing/prep tips, season-aware if travel dates were given),
  "days": [
    {
      "day": number,
      "title": string (a short evocative title for the day, e.g. "Old Town & Harbor Sunset"),
      "morning": string,
      "afternoon": string,
      "evening": string,
      "foodPick": string (one specific restaurant/dish/area recommendation for the day),
      "stops": [string, string, string] (2 to 5 SHORT stop names for this day, in visiting order, used to geocode and plot a route on a map. Each MUST be a real, well-known, independently mappable place — a specific landmark, museum, park, square, market, or named neighborhood that would return a match on OpenStreetMap. Do NOT invent names, and do NOT use vague/generic phrases like "local market" or "downtown area" — name the actual market or district),
      "costBreakdown": {
        "accommodation": number (whole USD, this day's share for the whole group, 0 if none),
        "food": number (whole USD for the whole group this day),
        "activities": number (whole USD for the whole group this day, entrance fees/tours/etc),
        "transport": number (whole USD for the whole group this day, local transit/taxis),
        "total": number (sum of the four above)
      }
    }
  ]
}

The "days" array must contain exactly ${days} entries, numbered 1 through ${days}. All costBreakdown numbers and totalBudgetEstimateUsd must be plain integers in US dollars (no currency symbols, no strings) and realistic for a ${budget || "moderate"} budget trip to ${destination}. Be specific to ${destination} — name real neighborhoods, landmarks, and dishes rather than generic filler. Keep text fields to 1-3 sentences.`;

    const itinerary = await requestItinerary(userPrompt);
    res.json({ itinerary });
  } catch (err) {
    console.error("Unexpected server error:", err);
    res.status(err.status || 500).json({ error: err.userMessage || "Something went wrong generating your itinerary. Please try again." });
  }
});

// ===== Shareable trip links (simple JSON-file store, no DB required) =====
app.post("/api/trips", (req, res) => {
  try {
    const itinerary = req.body && req.body.itinerary;
    if (!itinerary || typeof itinerary !== "object") {
      return res.status(400).json({ error: "Missing itinerary to save." });
    }
    const id = crypto.randomBytes(5).toString("hex");
    const filePath = path.join(TRIPS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ itinerary, createdAt: Date.now() }));
    res.json({ id });
  } catch (err) {
    console.error("Failed to save trip:", err);
    res.status(500).json({ error: "Couldn't save this trip for sharing. Please try again." });
  }
});

app.get("/api/trips/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").replace(/[^a-f0-9]/gi, "");
    const filePath = path.join(TRIPS_DIR, `${id}.json`);
    if (!id || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "This trip link doesn't exist or has expired." });
    }
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(saved);
  } catch (err) {
    console.error("Failed to load shared trip:", err);
    res.status(500).json({ error: "Couldn't load this trip. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`\n🧭  Voyage is running at http://localhost:${PORT}\n`);
  if (!API_KEY) {
    console.log(
      "⚠️  No GROQ_API_KEY detected. Copy .env.example to .env and add your free key from https://console.groq.com/keys before generating trips.\n"
    );
  }
});
