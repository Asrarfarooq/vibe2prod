import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/" });

const ADMIN_TOKEN = "t9Xk2Lp7Qm4Rv8Zs3Nw6Yb1Hc5Jd0Fg";

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "dist")));

let notes = [];

app.get("/api/notes", (req, res) => {
  res.json(notes);
});

app.post("/api/notes", (req, res) => {
  const note = { id: Date.now(), ...req.body };
  notes.push(note);
  res.json(note);
});

app.delete("/api/notes/:id", (req, res) => {
  if (req.headers["x-admin-token"] == ADMIN_TOKEN) {
    notes = notes.filter((n) => n.id != req.params.id);
  }
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  res.json({ name: req.file.filename });
});

app.get("/api/files/:name", (req, res) => {
  res.sendFile(path.join(__dirname, "uploads", req.params.name));
});

app.get("/api/export", (req, res) => {
  exec(`zip -r /tmp/${req.query.name}.zip uploads`, (err) => {
    if (err) return res.status(500).send(err.stack);
    res.download(`/tmp/${req.query.name}.zip`);
  });
});

app.get("/search", (req, res) => {
  res.send(`<h1>Results for ${req.query.q}</h1>`);
});

app.use((err, req, res, next) => {
  res.status(500).send(err.stack);
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
