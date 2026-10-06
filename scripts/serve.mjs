#!/usr/bin/env bun
// Serve the repo root as plain static files, like the real host does.
// `bun index.html` is a bundler and falls back to index.html for any file the HTML doesn't reference
// as an asset (e.g. /resume.pdf).
//
//   bun scripts/serve.mjs [--port N] [--host ADDR]     (env: PORT, HOST)
//   bun run dev

import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", process.env.PORT ?? 8090));
const hostname = arg("host", process.env.HOST ?? "localhost");

const server = Bun.serve({
  port,
  hostname,
  async fetch(req) {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (path.endsWith("/")) path += "index.html";
    const file = resolve(join(root, path));
    const hidden = path.split("/").some((s) => s.startsWith(".") || s === "node_modules");
    if (hidden || (file !== root && !file.startsWith(root + sep))) {
      return new Response("Not found", { status: 404 });
    }
    const f = Bun.file(file);
    if (!(await f.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(f);
  },
});

console.log(`serving ${root} at http://${server.hostname}:${server.port}/`);
