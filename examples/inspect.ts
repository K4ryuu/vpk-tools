/**
 * Quick tour: open a VPK, poke around, check integrity.
 * Run: bun run examples/inspect.ts <path/to/pak01_dir.vpk>
 */
import { existsSync } from "fs";
import { VpkReader, DIR_ARCHIVE_INDEX } from "../src/index.js";

let path = process.argv[2];
if (!path) {
  console.error("usage: bun run examples/inspect.ts <archive_dir.vpk>");
  process.exit(1);
}

// chunk archive given? if the matching _dir.vpk sits next to it, just use that
const chunkMatch = path.match(/^(.*)_\d{3}\.vpk$/i);

if (chunkMatch && existsSync(`${chunkMatch[1]}_dir.vpk`)) {
  console.error(`note: "${path}" is a chunk archive, opening "${chunkMatch[1]}_dir.vpk" instead`);
  path = `${chunkMatch[1]}_dir.vpk`;
}

let vpk: VpkReader;

try {
  vpk = VpkReader.open(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`v${vpk.header.version} archive, ${vpk.fileCount} files`);

// top 5 biggest files
const biggest = vpk
  .files()
  .map((p) => vpk.get(p)!)
  .sort((a, b) => b.totalLength - a.totalLength)
  .slice(0, 5);
console.log("\nbiggest files:");
for (const e of biggest) {
  const where = e.archiveIndex === DIR_ARCHIVE_INDEX ? "dir" : `chunk ${e.archiveIndex}`;
  console.log(`  ${(e.totalLength / 1024 / 1024).toFixed(2)} MB  (${where})  ${e.path}`);
}

// file type histogram
const byExt = new Map<string, number>();
for (const p of vpk.files()) {
  const ext = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : "(none)";
  byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
}

console.log("\ntop extensions:");
for (const [ext, count] of [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`  ${String(count).padStart(7)}  .${ext}`);

// which chunk archives are actually next to the dir file
const chunkIndexes = new Map<number, string>();
for (const p of vpk.files()) {
  const i = vpk.get(p)!.archiveIndex;
  if (i !== DIR_ARCHIVE_INDEX && !chunkIndexes.has(i))
    chunkIndexes.set(i, p);
}

const onDisk = [...chunkIndexes.values()].filter((p) => vpk.available(p)).length;
console.log(`\nchunk archives on disk: ${onDisk}/${chunkIndexes.size}`);

// integrity check against the embedded checksums
const result = vpk.verify();
console.log(`\nverify: ${result.ok ? "OK" : "FAILED"} (${result.checkedFiles} checked, ${result.skippedFiles.length} skipped)`);
for (const issue of result.issues)
  console.log(`  ${issue.path}: ${issue.reason}`);

vpk.close();
