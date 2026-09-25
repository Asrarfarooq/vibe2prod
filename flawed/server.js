import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function verifyAdminToken(req) {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || typeof token !== "string") {
    return false;
  }
  const tokenBuf = Buffer.from(token);
  const adminBuf = Buffer.from(ADMIN_TOKEN);
  if (tokenBuf.length !== adminBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(tokenBuf, adminBuf);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

let notes = [];

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Note text is required" });
  }
  const note = { id: Date.now(), text: text.trim() };
  notes.push(note);
  res.json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Invalid note id" });
  }
  notes = notes.filter((n) => String(n.id) !== String(id));
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  res.json({ name: req.file.filename });
});

app.get("/api/files/:name", (req, res) => {
  const rawName = req.params.name;
  if (!rawName || typeof rawName !== "string" || !/^[a-zA-Z0-9._-]+$/.test(rawName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filename = path.basename(rawName);
  const safePath = `${uploadsDir}/${filename}`;
  if (!fs.existsSync(safePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.sendFile(filename, { root: uploadsDir });
});

app.get("/api/export", (req, res) => {
  const name = req.query.name;
  if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name" });
  }
  const safeName = path.basename(name);
  const zipPath = `/tmp/${safeName}.zip`;
  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      return res.status(500).json({ error: "Export failed" });
    }
    res.download(zipPath, `${safeName}.zip`, () => {
      fs.unlink(zipPath, () => {});
    });
  });
});

app.post("/api/summarize", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Gemini API key is not configured" });
    }
    const notesToSummarize = Array.isArray(req.body?.notes)
      ? req.body.notes
      : notes;
    const notesText = notesToSummarize
      .map((n) => (typeof n === "string" ? n : n?.text || ""))
      .filter(Boolean)
      .join("\n");

    if (!notesText) {
      return res.json({ summary: "No notes to summarize." });
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Summarize these notes:\n" + notesText,
    });
    res.json({ summary: response.text });
  } catch (err) {
    console.error("Summarization error:", err);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

app.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const safeQ = escapeHtml(q);
  const html = ["<h1>Results for ", safeQ, "</h1>"].join("");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
