#!/usr/bin/env bun
// Copy image and video assets from the sibling combeanie documentation site.
//
//   bun scripts/combeanie-media.mjs [--src DIR] [--out DIR]
//   bun run combeanie-media
//
// The source defaults to ../combeanie/website/static. Paths below that directory
// are preserved in projects/combeanie, and stale imported media are removed.

import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const SRC = resolve(arg("src", join(here, "..", "..", "combeanie", "website", "static")));
const OUT = resolve(arg("out", join(here, "..", "projects", "combeanie")));
const MEDIA_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".ogv",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webm",
  ".webp",
]);

const isMedia = (file) => MEDIA_EXTENSIONS.has(extname(file).toLowerCase());

async function filesBelow(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

async function main() {
  const sourceFiles = (await filesBelow(SRC)).filter(isMedia).sort();
  if (sourceFiles.length === 0) throw new Error(`no image or video assets found in ${SRC}`);

  await mkdir(OUT, { recursive: true });
  for (const file of sourceFiles) {
    const destination = join(OUT, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(SRC, file), destination);
    console.log(`✓ ${file}`);
  }

  const wanted = new Set(sourceFiles);
  for (const file of await filesBelow(OUT)) {
    if (isMedia(file) && !wanted.has(file)) {
      await rm(join(OUT, file));
      console.log(`− ${file}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
