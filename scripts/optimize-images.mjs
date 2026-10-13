#!/usr/bin/env bun
// Build the WebP files the site serves from the original PNGs, and keep <img> dimensions in index.html in sync.
//
//   originals/<path>.png   ->  projects/<path>.webp         full size, the smaller of lossless / lossy q88 (lightbox)
//                              projects/<path>-thumb.webp   360px tall (gallery row)
//
//   bun run images                 convert whatever changed, update width/height in index.html
//   bun run images -- --check      change nothing; exit 1 if outputs or index.html are out of date (for CI)
//   bun run images -- --force      re-encode everything
//   bun run images -- --import     first copy newer originals in from the project repos in scripts/image-sources.json
//
// Idempotent: a source is only re-encoded when its SHA-256 differs from the one in scripts/images.lock.json
// (or an output is missing), so a second run changes nothing, whatever the file timestamps say.
// Needs `cwebp` (the dev shell has it, or: nix shell nixpkgs#libwebp).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGINALS = join(root, "originals");
const OUT = join(root, "projects");
const LOCK = join(root, "scripts", "images.lock.json");
const THUMB_HEIGHT = 360;
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const check = flag("check");
const force = flag("force");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const same = (a, b) => existsSync(b) && sha256(a) === sha256(b);
const kib = (n) => `${Math.round(n / 1024)}K`;
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);

const pngSize = (path) => {
  const b = readFileSync(path).subarray(0, 24);
  if (b.toString("latin1", 1, 4) !== "PNG") throw new Error(`${path}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".png") ? [join(dir, e.name)] : [],
  );

// ---- --import: pull originals from the project repos --------------------------------------------------------
if (flag("import")) {
  const cfg = readJson(join(root, "scripts", "image-sources.json"), {});
  for (const [project, { dir, files }] of Object.entries(cfg)) {
    for (const [name, file] of Object.entries(files)) {
      const src = resolve(root, dir, file);
      const dst = join(ORIGINALS, project, `${name}.png`);
      if (!existsSync(src)) {
        console.error(`import: missing ${src}`);
        process.exitCode = 1;
        continue;
      }
      if (same(src, dst)) continue;
      if (check) {
        console.log(`import: ${project}/${name} differs from ${src}`);
        process.exitCode = 1;
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      console.log(`import: ${project}/${name} <- ${src}`);
    }
  }
}

// ---- convert -------------------------------------------------------------------------------------------------
if (spawnSync("cwebp", ["-version"]).error) {
  console.error("cwebp not found (nix develop, or: nix shell nixpkgs#libwebp)");
  process.exit(1);
}
const cwebp = (...a) => {
  const r = spawnSync("cwebp", ["-quiet", ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cwebp ${a.join(" ")}: ${r.stderr}`);
};

const lock = readJson(LOCK, {});
const nextLock = {};
let html = readFileSync(join(root, "index.html"), "utf8");
const htmlBefore = html;
let stale = 0;
let encoded = 0;

for (const src of walk(ORIGINALS).sort()) {
  const key = relative(ORIGINALS, src).replace(/\.png$/, "");
  const full = join(OUT, `${key}.webp`);
  const thumb = join(OUT, `${key}-thumb.webp`);
  const hash = sha256(src);
  const { w, h } = pngSize(src);
  const th = Math.min(h, THUMB_HEIGHT);
  const tw = h > THUMB_HEIGHT ? Math.round((w * THUMB_HEIGHT) / h) : w;

  const upToDate = !force && lock[key]?.sha256 === hash && existsSync(full) && existsSync(thumb);
  if (!upToDate) {
    stale++;
    if (!check) {
      mkdirSync(dirname(full), { recursive: true });
      const id = key.replace(/\//g, "_");
      const lossy = join(tmpdir(), `${id}.lossy.webp`);
      const lossless = join(tmpdir(), `${id}.lossless.webp`);
      cwebp("-q", "88", "-m", "6", src, "-o", lossy);
      cwebp("-lossless", "-z", "9", src, "-o", lossless);
      const lossyWins = statSync(lossy).size <= statSync(lossless).size;
      copyFileSync(lossyWins ? lossy : lossless, full);
      rmSync(lossy);
      rmSync(lossless);
      cwebp("-q", "80", "-m", "6", ...(h > THUMB_HEIGHT ? ["-resize", String(tw), String(th)] : []), src, "-o", thumb);
      encoded++;
      console.log(`${key}: ${w}x${h} ${lossyWins ? "lossy" : "lossless"} ${kib(statSync(src).size)} -> ${kib(statSync(full).size)}, thumb ${kib(statSync(thumb).size)}`);
    } else {
      console.log(`${key}: outputs out of date`);
    }
  }
  nextLock[key] = { sha256: hash, width: w, height: h };

  // index.html dimensions follow the real files
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  for (const [file, fw, fh] of [[`${key}.webp`, w, h], [`${key}-thumb.webp`, tw, th]]) {
    html = html.replace(
      new RegExp(`(src="/projects/${esc(file)}") width="\\d+" height="\\d+"`, "g"),
      `$1 width="${fw}" height="${fh}"`,
    );
  }
}

const orphans = [];
const outputs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? outputs(join(dir, e.name)) : e.name.endsWith(".webp") ? [join(dir, e.name)] : []);
for (const f of outputs(OUT)) {
  const key = relative(OUT, f).replace(/-thumb\.webp$|\.webp$/, "");
  if (!(key in nextLock)) orphans.push(relative(root, f));
}
if (orphans.length) console.log(`note: no original for ${orphans.join(", ")} (left alone)`);

const lockText = `${JSON.stringify(nextLock, null, 2)}\n`;
const lockChanged = !existsSync(LOCK) || readFileSync(LOCK, "utf8") !== lockText;
const htmlChanged = html !== htmlBefore;
if (check) {
  if (stale || htmlChanged || lockChanged) {
    console.log(`out of date: ${stale} image(s)${htmlChanged ? ", index.html dimensions" : ""}${lockChanged ? ", lock file" : ""}`);
    process.exit(1);
  }
  console.log("up to date");
} else {
  if (lockChanged) writeFileSync(LOCK, lockText);
  if (htmlChanged) {
    writeFileSync(join(root, "index.html"), html);
    console.log("index.html: image dimensions updated");
  }
  console.log(`${encoded} encoded, ${Object.keys(nextLock).length - encoded} unchanged`);
}
