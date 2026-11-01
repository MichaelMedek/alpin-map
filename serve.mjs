// Local preview server for the static viewer. Zero dependencies (Node only), so it mirrors GitHub Pages: it
// just serves the files in this folder over HTTP with no rewrites, exactly as Pages does — the fastest way to
// check how the site will render before publishing. Run:  node serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = 8000;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  // Resolve under ROOT ("/" serves index.html) and reject any path that escapes the folder.
  const file = resolve(ROOT, "." + (pathname === "/" ? "/index.html" : pathname));
  if (file !== ROOT && !file.startsWith(ROOT + "/")) {
    response.writeHead(403).end("403 Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 Not Found: " + pathname);
  }
});

server.on("error", (error) => {
  // The most common failure is the port already being in use; name it plainly.
  if (error.code === "EADDRINUSE") console.error("Port " + PORT + " is already in use; stop the other server and retry.");
  else console.error(error.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const url = "http://localhost:" + PORT + "/";
  console.log("Local preview: " + url + "  (Ctrl+C to stop)");
  // Best-effort open the default browser on macOS / Windows / Linux; ignore failures (e.g. headless shells).
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
