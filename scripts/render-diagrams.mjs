#!/usr/bin/env bun
// Render each diagrams/<project>/<name>.html to projects/<project>/<name>.png, headlessly, via raw CDP
// (no npm deps). The element with id "d" is captured.
//
//   bun scripts/render-diagrams.mjs [--src DIR] [--out DIR] [--browser PATH] [--only PROJECT[/NAME],...]
//   bun run render-diagrams

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const SRC = resolve(arg("src", join(here, "..", "diagrams")));
const OUT = resolve(arg("out", join(here, "..", "projects")));
const BROWSER = arg("browser", process.env.BROWSER ?? "helium");
const PORT = Number(arg("port", 9335));
const ONLY = arg("only")?.split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBrowser() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${BROWSER} did not expose a debugging port`);
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { ready, send, close: () => ws.close() };
}

async function sources() {
  const found = [];
  for (const project of await readdir(SRC, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const f of await readdir(join(SRC, project.name))) {
      if (!f.endsWith(".html")) continue;
      const name = f.slice(0, -".html".length);
      const key = `${project.name}/${name}`;
      if (ONLY && !ONLY.some((o) => o === key || o === project.name)) continue;
      found.push({ project: project.name, name, file: join(SRC, project.name, f) });
    }
  }
  return found.sort((a, b) => (a.project + a.name).localeCompare(b.project + b.name));
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "diagram-shots-"));
  const browser = spawn(
    BROWSER,
    ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
  );
  const cdp = connect(await waitForBrowser());
  try {
    await cdp.ready;
    for (const { project, name, file } of await sources()) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = (method, params) => cdp.send(method, params, sessionId);
      await page("Page.enable");
      await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
      await page("Page.navigate", { url: pathToFileURL(file).href });
      let box;
      for (let t = 0; t < 40 && !box; t++) {
        await sleep(250);
        const r = await page("Runtime.evaluate", {
          expression: `(async () => { await document.fonts.ready; const e = document.getElementById('d'); if (!e || document.readyState !== 'complete') return null;
            const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        box = r.result.value;
      }
      if (!box) {
        console.warn(`! ${project}/${name}: no #d element, skipping`);
      } else {
        const { data } = await page("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: true });
        await mkdir(join(OUT, project), { recursive: true });
        await writeFile(join(OUT, project, `${name}.png`), Buffer.from(data, "base64"));
        console.log(`✓ ${project}/${name}.png`);
      }
      await cdp.send("Target.closeTarget", { targetId });
    }
  } finally {
    cdp.close();
    browser.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
