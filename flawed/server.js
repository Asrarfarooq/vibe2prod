import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.use(helmet());

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DOMPurify = {
  sanitize: (str) => escapeHtml(str),
};

let notes = [];

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Text is required" });
  }
  if (text.length > 10000) {
    return res.status(400).json({ error: "Text is too long" });
  }
  const note = { id: Date.now(), text: text.trim() };
  notes.push(note);
  res.status(201).json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const providedToken = req.headers["x-admin-token"];

  if (!adminToken || !safeCompare(providedToken, adminToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const id = req.params.id;
  const initialLength = notes.length;
  notes = notes.filter((n) => String(n.id) !== String(id));
  if (notes.length === initialLength) {
    return res.status(404).json({ error: "Note not found" });
  }
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  res.json({ name: req.file.filename });
});

app.get("/api/files/:name", (req, res) => {
  const name = req.params.name;
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const safeName = path.basename(name);
  const filePath = `${uploadsDir}/${safeName}`;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    }
  });
  stream.pipe(res);
});

app.get("/api/export", (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name" });
  }

  const zipPath = `/tmp/${name}.zip`;

  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      console.error("Export error:", err);
      return res.status(500).json({ error: "Export failed" });
    }
    res.download(zipPath);
  });
});

app.post("/api/summarize", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured" });
    }

    const ai = new GoogleGenAI({ apiKey });
    const noteList = Array.isArray(req.body?.notes) ? req.body.notes : notes;
    const notesText = noteList
      .map((n) => {
        if (typeof n === "string") return n;
        if (n && typeof n.text === "string") return n.text;
        return "";
      })
      .filter((t) => t.trim().length > 0)
      .join("\n");

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Summarize these notes:\n" + notesText,
    });

    res.json({ summary: response.text });
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Failed to summarize notes" });
  }
});

app.get("/search", (req, res) => {
  const rawQ = typeof req.query.q === "string" ? req.query.q : "";
  const q = DOMPurify.sanitize(rawQ);
  res.type("html").send("<h1>Results for " + q + "</h1>");
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
