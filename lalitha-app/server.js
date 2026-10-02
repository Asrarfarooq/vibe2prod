import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");

const rawPort = process.env.PORT;
const parsedPort = Number(rawPort);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function sendResponse(res, statusCode, headers = {}, body) {
  const mergedHeaders = {
    ...SECURITY_HEADERS,
    ...headers,
  };
  res.writeHead(statusCode, mergedHeaders);
  if (body !== undefined) {
    res.end(body);
  } else {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendResponse(
        res,
        405,
        {
          "Content-Type": "text/plain; charset=utf-8",
          Allow: "GET, HEAD",
        },
        "Method Not Allowed"
      );
      return;
    }

    const isHead = req.method === "HEAD";

    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      sendResponse(
        res,
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Bad request"
      );
      return;
    }

    if (url.pathname === "/health") {
      const payload = JSON.stringify({ status: "ok" });
      sendResponse(
        res,
        200,
        {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        },
        isHead ? undefined : payload
      );
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      sendResponse(
        res,
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Bad request"
      );
      return;
    }

    if (decodedPath.includes("\0")) {
      sendResponse(
        res,
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Bad request"
      );
      return;
    }

    const sanitized = decodedPath.replace(/\\/g, "/");
    const normalizedPath = path.posix.normalize(sanitized);
    const relativePath =
      normalizedPath === "/" ? "index.html" : normalizedPath.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relativePath);

    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      sendResponse(
        res,
        403,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Forbidden"
      );
      return;
    }

    try {
      const body = await readFile(file);
      const ext = path.extname(file);
      const contentType = TYPES[ext] ?? "application/octet-stream";
      sendResponse(
        res,
        200,
        {
          "Content-Type": contentType,
          "Content-Length": body.length,
        },
        isHead ? undefined : body
      );
    } catch (err) {
      if (
        err.code === "ENOENT" ||
        err.code === "EISDIR" ||
        err.code === "ENOTDIR"
      ) {
        sendResponse(
          res,
          404,
          { "Content-Type": "text/plain; charset=utf-8" },
          "Not found"
        );
      } else {
        sendResponse(
          res,
          500,
          { "Content-Type": "text/plain; charset=utf-8" },
          "Internal Server Error"
        );
      }
    }
  } catch {
    sendResponse(
      res,
      500,
      { "Content-Type": "text/plain; charset=utf-8" },
      "Internal Server Error"
    );
  }
});

server.listen(PORT, () => console.log(`lalitha-app listening on port ${PORT}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
