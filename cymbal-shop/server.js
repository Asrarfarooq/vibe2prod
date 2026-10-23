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

app.use(cors({ origin: "*" }));
app.use(bodyParser.json({ limit: "50mb" }));
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
  const product = { id: Date.now(), isNew: true, ...req.body };
  products.push(product);
  res.json(product);
});

app.delete("/api/products/:id", (req, res) => {
  if (req.headers["x-admin-token"] == ADMIN_TOKEN) {
    products = products.filter((p) => p.id != req.params.id);
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
  res.send(`<h1>Search results for ${req.query.q}</h1>`);
});

app.use((err, req, res, next) => {
  res.status(500).send(err.stack);
});

app.listen(8000, () =>
  console.log("Cymbal Superstore Inventory API running on http://localhost:8000")
);
