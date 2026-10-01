import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(400);
    return res.end("Bad request");
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => console.log(`lalitha-app listening on port ${PORT}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
