import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");

const rawPort = process.env.PORT;
const parsedPort = Number(rawPort);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = http.createServer(async (req, res) => {
  // Only allow safe read operations
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      ...SECURITY_HEADERS,
      "Allow": "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Method Not Allowed");
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Bad request");
  }

  // Health endpoint
  if (url.pathname === "/health") {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    });
    if (req.method === "HEAD") {
      return res.end();
    }
    return res.end(JSON.stringify({ status: "ok" }));
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Bad request");
  }

  // Disallow null bytes
  if (decodedPath.includes("\0")) {
    res.writeHead(400, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Bad request");
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  // Prevent path traversal outside the public directory
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Forbidden");
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    if (req.method === "HEAD") {
      return res.end();
    }
    return res.end(body);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") {
      res.writeHead(404, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      return res.end("Not found");
    }
    res.writeHead(500, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Internal Server Error");
  }
});

server.listen(PORT, () => console.log(`lalitha-app listening on port ${PORT}`));

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
