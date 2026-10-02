import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import helmet from "helmet";
import validator from "validator";
import AdmZip from "adm-zip";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function isSafeFilename(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 64) {
    return false;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const isNum = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isSpecial = code === 45 || code === 95;
    if (!isNum && !isUpper && !isLower && !isSpecial) {
      return false;
    }
  }
  return true;
}

function isSafePathSegment(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 128) {
    return false;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const isNum = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isSpecial = code === 45 || code === 95 || code === 46;
    if (!isNum && !isUpper && !isLower && !isSpecial) {
      return false;
    }
  }
  return !str.includes("..");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(16).toString("hex");
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, "");
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

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
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

let notes = [];

let ai = null;
function getAI() {
  if (!ai && process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Text is required and must be a non-empty string" });
  }
  const note = {
    id: Date.now(),
    text: text.trim().slice(0, 10000),
  };
  notes.push(note);
  res.status(201).json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || typeof token !== "string") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const tokenBuf = Buffer.from(token);
  const adminBuf = Buffer.from(ADMIN_TOKEN);
  if (tokenBuf.length !== adminBuf.length || !crypto.timingSafeEqual(tokenBuf, adminBuf)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const id = Number(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid note id" });
  }

  notes = notes.filter((n) => n.id !== id);
  res.json({ ok: true });
});

app.post("/api/summarize", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "Gemini API key is not configured" });
    }
    const client = getAI();
    const notesToSummarize = Array.isArray(req.body?.notes) ? req.body.notes : notes;
    const contents =
      "Summarize these notes:\n" +
      notesToSummarize
        .map((n) => (typeof n === "string" ? n : typeof n?.text === "string" ? n.text : ""))
        .filter(Boolean)
        .join("\n");

    const response = await client.models.generateContent({
      model: "gemini-3.8-flash",
      contents,
    });
    res.json({ summary: response.text });
  } catch (err) {
    console.error("Gemini summarize error:", err);
    res.status(500).json({ error: "Failed to summarize notes" });
  }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  res.json({ name: req.file.filename });
});

app.get("/api/files/:name", (req, res) => {
  const reqName = String(req.params.name || "");
  if (!isSafePathSegment(reqName)) {
    return res.status(400).json({ error: "Invalid file name" });
  }

  const files = fs.readdirSync(uploadsDir);
  const matched = files.find((f) => f === reqName);
  if (!matched) {
    return res.status(404).json({ error: "File not found" });
  }

  const ext = path.extname(matched);
  if (ext) {
    res.type(ext);
  }
  const stream = fs.createReadStream(path.join(uploadsDir, matched));
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(404).json({ error: "File not found" });
    }
  });
  stream.pipe(res);
});

app.get("/api/export", (req, res) => {
  try {
    const rawName = req.query.name;
    const exportName = isSafeFilename(rawName) ? rawName : "export";
    const zip = new AdmZip();
    zip.addLocalFolder(uploadsDir);
    const buffer = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${exportName}.zip"`);
    res.send(buffer);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

app.get("/search", (req, res) => {
  const rawQ = typeof req.query.q === "string" ? req.query.q : "";
  const safeQ = validator.escape(rawQ);
  res.type("html").send(`<h1>Results for ${safeQ}</h1>`);
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
