import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import helmet from "helmet";
import validator from "validator";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.disable("x-powered-by");

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
  databaseId: process.env.FIRESTORE_DATABASE_ID || "app-cymbal-shop-1",
});
const productsCol = firestore.collection("products");

const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
});
const bucketName = process.env.GCS_BUCKET_NAME || "app-cymbal-shop-1-uploads";
const bucket = storage.bucket(bucketName);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, WEBP, and GIF images are allowed."));
    }
  },
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:5173",
      "http://localhost:8000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8000",
    ];

app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const host = req.headers.host;
      if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  })(req, res, next);
});

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const defaultProducts = [
  {
    id: 101,
    name: "Parmesan Crisps",
    aisle: "Snacks",
    price: 4.99,
    quantity: 42,
    isNew: true,
    imgfile: "/product-images/parmesancrisps.webp",
    description: "Oven-baked aged parmesan crisps from Cymbal Market.",
  },
  {
    id: 102,
    name: "Pineapple Kombucha",
    aisle: "Beverages",
    price: 3.49,
    quantity: 65,
    isNew: true,
    imgfile: "/product-images/pineapplekombucha.webp",
    description: "Organic cold-pressed pineapple ginger kombucha.",
  },
  {
    id: 103,
    name: "Maple Almond Butter",
    aisle: "Pantry",
    price: 8.99,
    quantity: 28,
    isNew: true,
    imgfile: "/product-images/maplealmondbutter.webp",
    description: "Small-batch roasted almond butter with Vermont maple.",
  },
  {
    id: 104,
    name: "Mint Chocolate Cookies",
    aisle: "Bakery",
    price: 5.49,
    quantity: 50,
    isNew: true,
    imgfile: "/product-images/mintchocolatecookies.webp",
    description: "Dark chocolate wafer cookies with peppermint cream.",
  },
  {
    id: 105,
    name: "Acai Smoothie Packs",
    aisle: "Frozen",
    price: 6.99,
    quantity: 34,
    isNew: true,
    imgfile: "/product-images/acaismoothiepacks.webp",
    description: "Unsweetened organic Amazonian acai puree packs.",
  },
  {
    id: 106,
    name: "Smores Cereal",
    aisle: "Breakfast",
    price: 4.29,
    quantity: 80,
    isNew: true,
    imgfile: "/product-images/smorescereal.webp",
    description: "Graham cereal clusters with marshmallow and cocoa.",
  },
  {
    id: 107,
    name: "Honeycrisp Apples",
    aisle: "Produce",
    price: 2.99,
    quantity: 120,
    isNew: false,
    imgfile: "/product-images/apples.webp",
    description: "Crisp orchard-fresh Honeycrisp apples.",
  },
  {
    id: 108,
    name: "Cold Brew Coffee Beans",
    aisle: "Beverages",
    price: 9.99,
    quantity: 45,
    isNew: false,
    imgfile: "/product-images/coffeebeans.webp",
    description: "Whole-bean medium roast blend for smooth cold brew.",
  },
  {
    id: 109,
    name: "Wasabi Party Mix",
    aisle: "Snacks",
    price: 3.99,
    quantity: 0,
    isNew: true,
    imgfile: "/product-images/wasabipartymix.webp",
    description: "Crunchy rice crackers, sesame sticks, and wasabi peas.",
  },
];

let seeded = false;
async function seedProductsIfEmpty() {
  if (seeded) return;
  try {
    const snapshot = await productsCol.limit(1).get();
    if (snapshot.empty) {
      const batch = firestore.batch();
      for (const p of defaultProducts) {
        batch.set(productsCol.doc(String(p.id)), p);
      }
      await batch.commit();
      console.log("Seeded default products into Firestore.");
    }
    seeded = true;
  } catch (err) {
    console.error("Failed to seed initial products:", err.message || err);
  }
}

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/products", async (req, res, next) => {
  try {
    await seedProductsIfEmpty();
    const snapshot = await productsCol.get();
    const items = snapshot.docs.map((doc) => doc.data());
    items.sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(items);
  } catch (err) {
    next(err);
  }
});

app.get("/api/newproducts", async (req, res, next) => {
  try {
    await seedProductsIfEmpty();
    const snapshot = await productsCol.where("isNew", "==", true).get();
    const items = snapshot.docs
      .map((doc) => doc.data())
      .filter((p) => p.quantity > 0);
    items.sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(items);
  } catch (err) {
    next(err);
  }
});

app.post("/api/products", async (req, res, next) => {
  try {
    const { name, aisle, price, quantity, description, imgfile } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim() || name.length > 200) {
      return res.status(400).json({ error: "Product name is required (max 200 characters)" });
    }
    const parsedPrice = Number(price);
    if (isNaN(parsedPrice) || parsedPrice < 0 || parsedPrice > 100000) {
      return res.status(400).json({ error: "Valid product price is required" });
    }
    const parsedQuantity = quantity !== undefined ? Number(quantity) : 25;
    if (isNaN(parsedQuantity) || parsedQuantity < 0 || !Number.isInteger(parsedQuantity)) {
      return res.status(400).json({ error: "Valid quantity integer is required" });
    }

    const cleanAisle =
      typeof aisle === "string" && aisle.trim() ? aisle.trim().slice(0, 100) : "Grocery";
    const cleanDesc =
      typeof description === "string" ? description.trim().slice(0, 2000) : "";
    const cleanImg =
      typeof imgfile === "string" && imgfile.startsWith("/") ? imgfile.slice(0, 500) : "";

    const product = {
      id: Date.now(),
      name: name.trim().slice(0, 200),
      aisle: cleanAisle,
      price: parsedPrice,
      quantity: parsedQuantity,
      isNew: true,
      imgfile: cleanImg,
      description: cleanDesc,
    };
    await productsCol.doc(String(product.id)).set(product);
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/products/:id", async (req, res, next) => {
  try {
    const token = req.headers["x-admin-token"];
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || !token || token !== adminToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }

    const docRef = productsCol.doc(String(id));
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      await docRef.delete();
      return res.json({ ok: true });
    }

    const querySnap = await productsCol.where("id", "==", id).limit(1).get();
    if (querySnap.empty) {
      return res.status(404).json({ error: "Product not found" });
    }
    await querySnap.docs[0].ref.delete();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "File upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    try {
      const ext = path.extname(req.file.originalname) || "";
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
      const blob = bucket.file(filename);
      await blob.save(req.file.buffer, {
        resumable: false,
        contentType: req.file.mimetype,
      });
      res.json({ name: filename });
    } catch (uploadErr) {
      console.error("Cloud Storage upload error:", uploadErr);
      res.status(500).json({ error: "Failed to upload file to storage" });
    }
  });
});

app.get("/api/files/:filename", async (req, res, next) => {
  try {
    const filename = req.params.filename;
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const file = bucket.file(filename);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "File not found" });
    }

    const [metadata] = await file.getMetadata();
    if (metadata.contentType) {
      res.setHeader("Content-Type", metadata.contentType);
    }
    if (metadata.size) {
      res.setHeader("Content-Length", metadata.size);
    }

    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("Cloud Storage file stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error reading file" });
      }
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

app.get("/api/export", async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({
      error: "Invalid export name: alphanumeric, hyphen, and underscore only",
    });
  }
  const exportId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const exportDir = path.join("/tmp", `export-${exportId}`);
  const uploadsExportDir = path.join(exportDir, "uploads");
  const zipFilename = `${name}.zip`;
  const zipPath = path.join("/tmp", `${name}-${exportId}.zip`);

  try {
    fs.mkdirSync(uploadsExportDir, { recursive: true });

    const [files] = await bucket.getFiles();
    for (const file of files) {
      const baseName = path.basename(file.name);
      if (baseName && !baseName.startsWith(".")) {
        const dest = path.join(uploadsExportDir, baseName);
        await file.download({ destination: dest });
      }
    }

    const downloadedFiles = fs.readdirSync(uploadsExportDir);
    if (downloadedFiles.length === 0) {
      fs.writeFileSync(path.join(uploadsExportDir, ".empty"), "");
    }

    execFile("zip", ["-r", zipPath, "uploads"], { cwd: exportDir }, (err) => {
      if (err) {
        console.error("Export zip error:", err);
        fs.rm(exportDir, { recursive: true, force: true }, () => {});
        fs.unlink(zipPath, () => {});
        return res.status(500).json({ error: "Failed to create export archive" });
      }
      res.download(zipPath, zipFilename, (downloadErr) => {
        if (downloadErr) {
          console.error("Download error:", downloadErr);
        }
        fs.unlink(zipPath, () => {});
        fs.rm(exportDir, { recursive: true, force: true }, () => {});
      });
    });
  } catch (err) {
    console.error("Export error:", err);
    fs.rm(exportDir, { recursive: true, force: true }, () => {});
    fs.unlink(zipPath, () => {});
    res.status(500).json({ error: "Failed to create export archive" });
  }
});

app.post("/api/concierge", async (req, res) => {
  try {
    const { goal } = req.body || {};
    if (!goal || typeof goal !== "string" || !goal.trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }

    await seedProductsIfEmpty();
    const snapshot = await productsCol.where("quantity", ">", 0).get();
    const inStock = snapshot.docs
      .map((doc) => doc.data())
      .map((p) => `${p.name} ($${p.price}, ${p.aisle})`)
      .join(", ");

    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT || "vibe2prod-509620",
      location: process.env.VERTEX_AI_LOCATION || "global",
    });

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      contents: `You are the Cymbal Superstore AI Shopping Concierge. Recommend a basket and quick recipe from our in-stock items (${inStock}) for: ${goal.trim().slice(0, 1000)}`,
    });

    res.json({ reply: response.text });
  } catch (err) {
    console.error("Concierge generation error:", err.message || err);
    res.status(500).json({ error: "Failed to generate shopping recommendations" });
  }
});

app.get("/search", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const safeQuery = validator.escape(query);
  res.type("html").send(`<!DOCTYPE html><html><head><title>Search</title></head><body><h1>Search results for ${safeQuery}</h1></body></html>`);
});

app.use((err, req, res, next) => {
  console.error("Internal error:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Cymbal Superstore Inventory API running on port ${PORT}`);
});
