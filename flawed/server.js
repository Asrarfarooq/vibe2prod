import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import validator from "validator";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

let notes = [];

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  if (!req.body || typeof req.body.text !== "string" || !req.body.text.trim()) {
    return res.status(400).json({ error: "Text is required and must be a non-empty string" });
  }
  if (req.body.text.length > 5000) {
    return res.status(400).json({ error: "Note text exceeds maximum length of 5000 characters" });
  }
  const note = { id: Date.now(), text: req.body.text.trim() };
  notes.push(note);
  res.status(201).json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = req.params.id;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid note ID" });
  }
  notes = notes.filter((n) => String(n.id) !== id);
  res.json({ ok: true });
});

app.post("/api/summarize", async (req, res) => {
  if (!process.env.GEMINI_API_KEY || !ai) {
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured" });
  }
  try {
    const textToSummarize = notes.map((n) => n.text).join("\n");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Summarize these notes:\n" + textToSummarize,
    });
    res.json({ summary: response.text });
  } catch (err) {
    console.error("Gemini summary error:", err.message);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  res.json({ name: req.file.filename });
});

app.get("/api/files/:name", (req, res) => {
  const filename = req.params.name;
  if (!filename || typeof filename !== "string" || !/^[a-zA-Z0-9_-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  const safePath = `${uploadsDir}/${filename}`;
  if (!fs.existsSync(safePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const stream = fs.createReadStream(safePath);
  stream.on("error", () => res.status(500).json({ error: "Failed to read file" }));
  stream.pipe(res);
});

app.get("/api/export", (req, res) => {
  const name = req.query.name;
  if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name: only alphanumeric, underscore, and dash are allowed" });
  }
  const zipPath = `/tmp/${name}.zip`;
  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      console.error("Zip export error:", err.message);
      return res.status(500).json({ error: "Failed to create archive" });
    }
    res.download(zipPath);
  });
});

app.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const sanitized = validator.escape(q);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><body><h1>Results for ${sanitized}</h1></body></html>`);
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
