#!/usr/bin/env bun
// Capture a screenshot of every mfw tab, headlessly, via raw CDP (no npm deps).
//
//   bun scripts/mfw-screenshots.mjs [--base URL] [--out DIR] [--browser PATH] [--theme dark|light] [--only NAME[,NAME...]]
//   bun run mfw-screenshots
//
// The mfw URL comes from --base, then $MFW_BASE_URL, then this machine's tailscale
// name (served at /mfw by `tailscale serve`), then http://127.0.0.1:7777/mfw.
//
// Writes <page>.png for every page in PAGES (the names index.html references),
// overwriting whatever is there and deleting any other PNGs left in the directory.

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const defaultBase = () => {
  if (process.env.MFW_BASE_URL) return process.env.MFW_BASE_URL;
  try {
    const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }));
    const host = status.Self?.DNSName?.replace(/\.$/, "");
    if (host) return `https://${host}/mfw`;
  } catch {}
  return "http://127.0.0.1:7777/mfw";
};

const BASE = (arg("base") ?? defaultBase()).replace(/\/$/, "");
const OUT = resolve(arg("out", join(here, "..", "projects", "mfw")));
const BROWSER = arg("browser", process.env.BROWSER ?? "helium");
const THEME = arg("theme", "dark");
const PORT = Number(arg("port", 9333));
const ONLY = arg("only")?.split(",");

const PROJECT_TABS = ["board", "inbox", "review", "adrs", "runs", "triggers", "files", "settings"];
const GLOBAL_PAGES = ["resources", "runpod", "openrouter"];
const PAGES = [
  ...PROJECT_TABS.map((t) => [t, `${BASE}/p/mfw/${t}`]),
  ...GLOBAL_PAGES.map((t) => [t, `${BASE}/${t}`]),
];

// Board columns that should be expanded; every other column is collapsed.
const EXPANDED_COLUMNS = ["backlog", "done", "archived"];

// Column headers expose "Expand <status>" / "Collapse <status>" buttons; click
// whichever ones bring each column to its desired state.
const SET_COLUMNS = `(() => {
  const want = new Set(${JSON.stringify(EXPANDED_COLUMNS)});
  let clicked = 0;
  for (const b of document.querySelectorAll('button[title]')) {
    const m = /^(Expand|Collapse) (\\w+)$/.exec(b.title);
    if (!m) continue;
    if ((m[1] === 'Expand') === want.has(m[2])) { b.click(); clicked++; }
  }
  return clicked;
})()`;

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

// The app renders first and fills in data afterwards, so wait for the loading
// indicators to disappear instead of trusting the load event.
const SETTLED = `(() =>
  !document.querySelector('[aria-busy="true"]') &&
  !document.body.innerText.includes('Checking mfw') &&
  document.body.innerText.trim().length > 0)()`;

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "mfw-shots-"));
  const browser = spawn(
    BROWSER,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const cdp = connect(await waitForBrowser());
  try {
    await cdp.ready;
    await mkdir(OUT, { recursive: true });
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);

    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", {
      width: 1240,
      height: 1040,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: THEME }] });

    for (const [name, url] of PAGES) {
      if (ONLY && !ONLY.includes(name)) continue;
      await page("Page.navigate", { url });
      let settled = false;
      for (let i = 0; i < 60 && !settled; i++) {
        await sleep(500);
        const r = await page("Runtime.evaluate", { expression: SETTLED, returnByValue: true });
        settled = r.result.value === true;
      }
      if (!settled) console.warn(`! ${name}: still loading after 30s, capturing anyway`);
      if (name === "board") {
        const r = await page("Runtime.evaluate", { expression: SET_COLUMNS, returnByValue: true });
        console.log(`  board: toggled ${r.result.value} column(s)`);
      }
      await sleep(750); // let transitions finish
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      const file = `${name}.png`;
      await writeFile(join(OUT, file), Buffer.from(data, "base64"));
      console.log(`✓ ${file}  ${name}  ${url}`);
    }

    for (const f of await readdir(OUT)) {
      if (f.endsWith(".png") && !PAGES.some(([name]) => `${name}.png` === f)) await rm(join(OUT, f));
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
