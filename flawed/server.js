import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import escapeHtml from "escape-html";
import DOMPurify from "isomorphic-dompurify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const UPLOADS_DIR = path.resolve(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

app.disable("x-powered-by");
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

app.use(
  cors({
    origin: allowedOrigins,
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

let notes = [];

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Text is required and must be a non-empty string" });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: "Text exceeds maximum length of 5000 characters" });
  }
  const note = { id: Date.now(), text: text.trim() };
  notes.push(note);
  res.json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const clientToken = req.headers["x-admin-token"];
  if (!adminToken || !clientToken || !safeCompare(clientToken, adminToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = Number(req.params.id);
  notes = notes.filter((n) => n.id !== id);
  res.json({ ok: true });
});

app.post("/api/summarize", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
  }
  try {
    const ai = new GoogleGenAI({ apiKey });
    const notesToSummarize = Array.isArray(req.body?.notes)
      ? req.body.notes
      : notes;
    const contents =
      "Summarize these notes:\n" +
      notesToSummarize
        .map((n) => (typeof n === "string" ? n : n?.text || ""))
        .filter(Boolean)
        .join("\n");

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
    });
    res.json({ summary: response.text || "" });
  } catch (err) {
    console.error("Gemini summarize error:", err);
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
  const fileName = req.params.name;
  if (!fileName || !/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$/.test(fileName)) {
    return res.status(400).json({ error: "Invalid file name" });
  }

  const safeFileName = path.basename(fileName);
  const targetPath = `${UPLOADS_DIR}/${safeFileName}`;

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.sendFile(targetPath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Could not send file" });
    }
  });
});

app.get("/api/export", (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name parameter" });
  }

  const zipPath = `/tmp/${name}.zip`;

  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      console.error("Export error:", err);
      return res.status(500).json({ error: "Export failed" });
    }
    res.download(zipPath, `${name}.zip`, (downloadErr) => {
      if (downloadErr && !res.headersSent) {
        console.error("Download error:", downloadErr);
      }
      fs.unlink(zipPath, () => {});
    });
  });
});

app.get("/search", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const sanitized = DOMPurify.sanitize(query);
  const safeQuery = escapeHtml(sanitized);
  res.type("html").send(`<!DOCTYPE html><html><head><title>Search Results</title></head><body><h1>Results for ${safeQuery}</h1></body></html>`);
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
