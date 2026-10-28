import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";
import validator from "validator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Restrict CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      try {
        const originUrl = new URL(origin);
        if (
          allowedOrigins.includes(origin) ||
          originUrl.hostname === "localhost" ||
          originUrl.hostname === "127.0.0.1"
        ) {
          return callback(null, true);
        }
      } catch {
        // Invalid origin format
      }
      return callback(new Error("CORS policy violation"), false);
    },
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

// Upload configuration
const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedExts = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only image files are allowed."));
    }
  },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Google GenAI client
let aiClient = null;
function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

let products = [
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

app.get("/api/products", (req, res) => {
  res.json(products);
});

app.get("/api/newproducts", (req, res) => {
  res.json(products.filter((p) => p.isNew && p.quantity > 0));
});

app.post("/api/products", (req, res) => {
  const { name, aisle, price, quantity, description, imgfile } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Product name is required" });
  }
  const parsedPrice = Number(price);
  if (isNaN(parsedPrice) || parsedPrice < 0 || parsedPrice > 100000) {
    return res.status(400).json({ error: "Invalid product price" });
  }
  const parsedQuantity = quantity !== undefined ? Number(quantity) : 0;
  if (isNaN(parsedQuantity) || parsedQuantity < 0) {
    return res.status(400).json({ error: "Invalid product quantity" });
  }

  const product = {
    id: Date.now(),
    name: validator.escape(name.trim()).slice(0, 100),
    aisle: typeof aisle === "string" ? validator.escape(aisle.trim()).slice(0, 50) : "Grocery",
    price: parsedPrice,
    quantity: Math.floor(parsedQuantity),
    isNew: true,
    imgfile:
      typeof imgfile === "string" && imgfile.startsWith("/product-images/")
        ? imgfile.slice(0, 100)
        : "",
    description:
      typeof description === "string" ? description.trim().slice(0, 500) : "",
  };
  products.push(product);
  res.status(201).json(product);
});

app.delete("/api/products/:id", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || !safeCompare(token, ADMIN_TOKEN)) {
    return res.status(403).json({ error: "Forbidden: invalid admin token" });
  }
  const id = Number(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid product id" });
  }
  products = products.filter((p) => p.id !== id);
  res.json({ ok: true });
});

app.post("/api/concierge", async (req, res) => {
  try {
    const { goal } = req.body || {};
    if (!goal || typeof goal !== "string" || !goal.trim()) {
      return res.status(400).json({ error: "Shopping goal is required" });
    }
    const safeGoal = goal.trim().slice(0, 500);

    const ai = getAiClient();
    if (!ai) {
      return res.status(503).json({
        error: "AI Concierge is currently unavailable (API key not configured)",
      });
    }

    const inStock = products
      .filter((p) => p.quantity > 0)
      .map((p) => `${p.name} ($${p.price}, ${p.aisle})`)
      .join(", ");

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `You are the Cymbal Superstore AI Shopping Concierge. Recommend a basket and quick recipe from our in-stock items (${inStock}) for: ${safeGoal}`,
    });

    res.json({ reply: response.text || "" });
  } catch (err) {
    console.error("AI Concierge error:", err.message);
    res.status(500).json({ error: "Failed to generate recommendation" });
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
  if (!fileName || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,10}$/.test(fileName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = uploadsDir + "/" + fileName;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  if (mimeTypes[ext]) {
    res.setHeader("Content-Type", mimeTypes[ext]);
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(404).json({ error: "File not found" });
    }
  });
  stream.pipe(res);
});

app.get("/api/export", (req, res) => {
  const { name } = req.query;
  if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return res.status(400).json({ error: "Invalid export name parameter" });
  }

  const zipPath = `/tmp/${name}.zip`;

  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      console.error("Export command failed:", err.message);
      return res.status(500).json({ error: "Export failed" });
    }
    res.download(zipPath, `${name}.zip`, (downloadErr) => {
      if (downloadErr) {
        console.error("Download error:", downloadErr.message);
      }
      fs.unlink(zipPath, () => {});
    });
  });
});

app.get("/search", (req, res) => {
  const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const safeQ = validator.escape(rawQ);
  const results = products.filter((p) =>
    p.name.toLowerCase().includes(rawQ.toLowerCase())
  );
  res.json({ query: safeQ, results });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 400 ? err.message : "Internal Server Error",
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () =>
  console.log(`Cymbal Superstore Inventory API running on http://localhost:${PORT}`)
);
