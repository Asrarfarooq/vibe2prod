import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import validator from "validator";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import archiver from "archiver";

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
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const firestore = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "app-vibed-app-3",
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
});
const notesCollection = firestore.collection("notes");

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
});
const bucketName = process.env.GCS_BUCKET_NAME || "app-vibed-app-3-uploads";
const bucket = storage.bucket(bucketName);

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
  location: "global",
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

let lastTimestamp = 0;
function getUniqueId() {
  let now = Date.now();
  if (now <= lastTimestamp) {
    now = lastTimestamp + 1;
  }
  lastTimestamp = now;
  return now;
}

app.get("/api/notes", async (req, res) => {
  try {
    const snapshot = await notesCollection.get();
    const notes = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        return {
          id: data.id !== undefined ? data.id : (isNaN(Number(doc.id)) ? doc.id : Number(doc.id)),
          text: data.text,
          createdAt: data.createdAt,
        };
      })
      .sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return a.createdAt > b.createdAt ? 1 : -1;
        }
        return a.id > b.id ? 1 : -1;
      })
      .map(({ id, text }) => ({ id, text }));
    res.json(notes);
  } catch (err) {
    console.error("Failed to fetch notes:", err.message);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

app.post("/api/notes", async (req, res) => {
  if (!req.body || typeof req.body.text !== "string" || !req.body.text.trim()) {
    return res.status(400).json({ error: "Text is required and must be a non-empty string" });
  }
  if (req.body.text.length > 5000) {
    return res.status(400).json({ error: "Note text exceeds maximum length of 5000 characters" });
  }
  const id = getUniqueId();
  const note = {
    id,
    text: req.body.text.trim(),
    createdAt: new Date().toISOString(),
  };
  try {
    await notesCollection.doc(String(id)).set(note);
    res.status(201).json({ id: note.id, text: note.text });
  } catch (err) {
    console.error("Failed to create note:", err.message);
    res.status(500).json({ error: "Failed to create note" });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = req.params.id;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid note ID" });
  }
  try {
    await notesCollection.doc(id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete note:", err.message);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const snapshot = await notesCollection.get();
    const noteTexts = snapshot.docs
      .map((doc) => doc.data().text)
      .filter((text) => typeof text === "string" && text.trim().length > 0);
    const textToSummarize = noteTexts.join("\n");
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Summarize these notes:\n" + textToSummarize,
    });
    res.json({ summary: response.text });
  } catch (err) {
    console.error("Gemini summary error:", err.message);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const filename = crypto.randomBytes(16).toString("hex");
    const file = bucket.file(filename);
    await file.save(req.file.buffer, {
      contentType: req.file.mimetype,
      resumable: false,
    });
    res.json({ name: filename });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.get("/api/files/:name", async (req, res) => {
  const filename = req.params.name;
  if (!filename || typeof filename !== "string" || !/^[a-zA-Z0-9_-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid file name" });
  }
  try {
    const file = bucket.file(filename);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "File not found" });
    }
    const [metadata] = await file.getMetadata();
    if (metadata.contentType) {
      res.setHeader("Content-Type", metadata.contentType);
    }
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("Stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error("File retrieval error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    }
  }
});

app.get("/api/export", async (req, res) => {
  const name = req.query.name;
  if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name: only alphanumeric, underscore, and dash are allowed" });
  }
  try {
    const [files] = await bucket.getFiles();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.zip"`);

    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    archive.on("error", (err) => {
      console.error("Archive error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create archive" });
      }
    });

    archive.pipe(res);

    for (const file of files) {
      archive.append(file.createReadStream(), { name: file.name });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Zip export error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create archive" });
    }
  }
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
