import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import archiver from "archiver";
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

app.get("/healthz", (req, res) => res.status(200).json({ status: "ok" }));

app.use(express.static(path.join(__dirname, "dist")));

const firestore = new Firestore({
  projectId: process.env.GCP_PROJECT || "vibe2prod-509620",
  databaseId: process.env.FIRESTORE_DATABASE_ID || "app-vibed-app-4",
});
const notesCollection = firestore.collection("notes");

const storage = new Storage({
  projectId: process.env.GCP_PROJECT || "vibe2prod-509620",
});
const bucketName = process.env.GCS_BUCKET_NAME || "app-vibed-app-4-uploads-509620";
const bucket = storage.bucket(bucketName);

const upload = multer({
  storage: multer.memoryStorage(),
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

app.get("/api/notes", async (req, res) => {
  try {
    const snapshot = await notesCollection.orderBy("createdAt", "asc").get();
    const notes = snapshot.docs.map((doc) => doc.data());
    res.json(notes);
  } catch (err) {
    console.error("Failed to fetch notes:", err);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

app.post("/api/notes", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }
    if (text.length > 10000) {
      return res.status(400).json({ error: "Text is too long" });
    }
    const note = { id: Date.now(), text: text.trim(), createdAt: new Date() };
    await notesCollection.doc(String(note.id)).set(note);
    res.status(201).json(note);
  } catch (err) {
    console.error("Failed to create note:", err);
    res.status(500).json({ error: "Failed to create note" });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    const providedToken = req.headers["x-admin-token"];

    if (!adminToken || !safeCompare(providedToken, adminToken)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const id = req.params.id;
    let docRef = notesCollection.doc(String(id));
    let docSnap = await docRef.get();

    if (!docSnap.exists) {
      const numId = Number(id);
      if (!Number.isNaN(numId)) {
        const qSnap = await notesCollection.where("id", "==", numId).limit(1).get();
        if (!qSnap.empty) {
          docRef = qSnap.docs[0].ref;
          docSnap = qSnap.docs[0];
        }
      }
    }

    if (!docSnap.exists) {
      return res.status(404).json({ error: "Note not found" });
    }

    await docRef.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete note:", err);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const ext = path.extname(req.file.originalname || "").slice(0, 10).replace(/[^a-zA-Z0-9.]/g, "");
    const filename = `${crypto.randomUUID()}${ext}`;
    const file = bucket.file(filename);
    await file.save(req.file.buffer, {
      resumable: false,
      contentType: req.file.mimetype || "application/octet-stream",
    });
    res.json({ name: filename });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.get("/api/files/:name", async (req, res) => {
  const name = req.params.name;
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const safeName = path.basename(name);
  try {
    const file = bucket.file(safeName);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "File not found" });
    }
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error("Error retrieving file:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to retrieve file" });
    }
  }
});

app.get("/api/export", async (req, res) => {
  const name = req.query.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name" });
  }

  try {
    const [files] = await bucket.getFiles();

    res.attachment(`${name}.zip`);
    const archive = archiver("zip", { zlib: { level: 6 } });

    archive.on("error", (err) => {
      console.error("Archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Export failed" });
      }
    });

    archive.pipe(res);

    for (const file of files) {
      archive.append(file.createReadStream(), { name: file.name });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Export error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    }
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GCP_PROJECT || "vibe2prod-509620",
      location: "global",
    });

    let noteList = req.body?.notes;
    if (!Array.isArray(noteList)) {
      const snapshot = await notesCollection.orderBy("createdAt", "asc").get();
      noteList = snapshot.docs.map((doc) => doc.data());
    }

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
