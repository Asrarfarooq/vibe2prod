import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import helmet from "helmet";
import validator from "validator";
import AdmZip from "adm-zip";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
  databaseId: process.env.FIRESTORE_DATABASE_ID || "app-vibed-app-5",
});
const notesCollection = firestore.collection("notes");

const storageClient = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
});
const bucket = storageClient.bucket(
  process.env.GCS_BUCKET_NAME || "app-vibed-app-5-vibe2prod-509620"
);

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.disable("x-powered-by");
app.use(helmet());
app.use(cors());

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

let ai = null;
function getAI() {
  if (!ai) {
    ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
      location: "global",
    });
  }
  return ai;
}

app.get(["/health", "/api/health"], (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/notes", async (req, res, next) => {
  try {
    const snapshot = await notesCollection.orderBy("id", "asc").get();
    const notesList = snapshot.docs.map((doc) => doc.data());
    res.json(notesList);
  } catch (err) {
    next(err);
  }
});

app.post("/api/notes", async (req, res, next) => {
  try {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required and must be a non-empty string" });
    }
    const note = {
      id: Date.now(),
      text: text.trim().slice(0, 10000),
    };
    await notesCollection.doc(String(note.id)).set(note);
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/notes/:id", async (req, res, next) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    const token = req.headers["x-admin-token"];
    if (!adminToken || typeof token !== "string") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tokenBuf = Buffer.from(token);
    const adminBuf = Buffer.from(adminToken);
    if (tokenBuf.length !== adminBuf.length || !crypto.timingSafeEqual(tokenBuf, adminBuf)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid note id" });
    }

    await notesCollection.doc(String(id)).delete();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const client = getAI();
    let notesToSummarize;
    if (Array.isArray(req.body?.notes)) {
      notesToSummarize = req.body.notes;
    } else {
      const snapshot = await notesCollection.orderBy("id", "asc").get();
      notesToSummarize = snapshot.docs.map((doc) => doc.data());
    }
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

app.post("/api/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const unique = crypto.randomBytes(16).toString("hex");
    const ext = path.extname(req.file.originalname || "").slice(0, 10).replace(/[^a-zA-Z0-9.]/g, "");
    const filename = `${unique}${ext}`;
    const file = bucket.file(filename);
    await file.save(req.file.buffer, {
      contentType: req.file.mimetype || "application/octet-stream",
      resumable: false,
    });
    res.json({ name: filename });
  } catch (err) {
    next(err);
  }
});

app.get("/api/files/:name", async (req, res, next) => {
  try {
    const reqName = String(req.params.name || "");
    if (!isSafePathSegment(reqName)) {
      return res.status(400).json({ error: "Invalid file name" });
    }

    const file = bucket.file(reqName);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "File not found" });
    }

    const ext = path.extname(reqName);
    if (ext) {
      res.type(ext);
    }
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("File stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream file" });
      }
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const rawName = req.query.name;
    const exportName = isSafeFilename(rawName) ? rawName : "export";
    const zip = new AdmZip();
    const [files] = await bucket.getFiles();
    await Promise.all(
      files.map(async (file) => {
        const [content] = await file.download();
        zip.addFile(file.name, content);
      })
    );
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
