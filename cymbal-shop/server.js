import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import helmet from "helmet";
import validator from "validator";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { GoogleGenAI } from "@google/genai";

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

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  dest: uploadsDir,
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

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:5173",
      "http://localhost:8000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8000",
    ];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "dist")));

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
  products.push(product);
  res.status(201).json(product);
});

app.delete("/api/products/:id", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || !token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = Number(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid product id" });
  }
  const initialLength = products.length;
  products = products.filter((p) => p.id !== id);
  if (products.length === initialLength) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json({ ok: true });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "File upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    res.json({ name: req.file.filename });
  });
});

app.use(
  "/api/files",
  express.static(uploadsDir, {
    dotfiles: "deny",
    index: false,
    fallthrough: false,
  })
);

app.get("/api/export", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({
      error: "Invalid export name: alphanumeric, hyphen, and underscore only",
    });
  }
  const zipFilename = `${name}.zip`;
  const zipPath = `/tmp/${zipFilename}`;

  execFile("zip", ["-r", zipPath, "uploads"], { cwd: __dirname }, (err) => {
    if (err) {
      console.error("Export error:", err);
      return res.status(500).json({ error: "Failed to create export archive" });
    }
    res.download(zipPath, zipFilename, (downloadErr) => {
      if (downloadErr) {
        console.error("Download error:", downloadErr);
      }
      fs.unlink(zipPath, () => {});
    });
  });
});

app.post("/api/concierge", async (req, res) => {
  try {
    const { goal } = req.body || {};
    if (!goal || typeof goal !== "string" || !goal.trim()) {
      return res.status(400).json({ error: "Goal is required" });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "Shopping concierge service is not configured" });
    }

    const ai = new GoogleGenAI({ apiKey });
    const inStock = products
      .filter((p) => p.quantity > 0)
      .map((p) => `${p.name} ($${p.price}, ${p.aisle})`)
      .join(", ");

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
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
