/**
 * Serve files straight out of a VPK over HTTP, with Range support.
 * No full-file buffering - a 30 MB sound file streams in 256 KB slices.
 *
 * Run: bun run examples/stream.ts <path/to/pak01_dir.vpk> [port]
 * Try: curl -r 0-1023 "http://localhost:8080/scripts/soundevents_game.vsndevts_c" | xxd | head
 */
import { existsSync } from "fs";
import { AsyncVpkReader } from "../src/index.js";

let path = process.argv[2];
if (!path) {
  console.error("usage: bun run examples/stream.ts <archive_dir.vpk> [port]");
  process.exit(1);
}

// chunk archive given? if the matching _dir.vpk sits next to it, just use that
const chunkMatch = path.match(/^(.*)_\d{3}\.vpk$/i);

if (chunkMatch && existsSync(`${chunkMatch[1]}_dir.vpk`)) {
  console.error(`note: "${path}" is a chunk archive, opening "${chunkMatch[1]}_dir.vpk" instead`);
  path = `${chunkMatch[1]}_dir.vpk`;
}

let vpk: AsyncVpkReader;

try {
  vpk = await AsyncVpkReader.open(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const port = Number(process.argv[3] ?? 8080);

Bun.serve({
  port,
  async fetch(req) {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1));
    const entry = vpk.get(file);
    if (!entry)
      return new Response("not in this vpk, check /list", { status: 404 });

    // honor a single "bytes=from-to" range, browsers send these for audio/video
    const range = req.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : entry.totalLength - 1;

    const body = await vpk.readFileRange(file, start, end - start + 1);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-length": String(body.length),
        ...(range ? { "content-range": `bytes ${start}-${end}/${entry.totalLength}` } : {}),
      },
    });
  },
});

console.log(`serving ${vpk.fileCount} files from ${path} on http://localhost:${port}/<path-in-vpk>`);
