/**
 * Pull text files (configs, scripts, schemes) out of a VPK and print them.
 * Pass a path inside the archive to dump that exact file, or let it
 * list every text-like file and preview the first readable one.
 *
 * Run: bun run examples/read-text.ts <archive_dir.vpk> [path/in/vpk]
 */
import { existsSync } from "fs";
import { VpkReader } from "../src/index.js";

let [archive, target] = process.argv.slice(2);
if (!archive) {
  console.error("usage: bun run examples/read-text.ts <archive_dir.vpk> [path/in/vpk]");
  process.exit(1);
}

// chunk archive given? if the matching _dir.vpk sits next to it, just use that
const chunkMatch = archive.match(/^(.*)_\d{3}\.vpk$/i);

if (chunkMatch && existsSync(`${chunkMatch[1]}_dir.vpk`)) {
  console.error(`note: "${archive}" is a chunk archive, opening "${chunkMatch[1]}_dir.vpk" instead`);
  archive = `${chunkMatch[1]}_dir.vpk`;
}

let vpk: VpkReader;

try {
  vpk = VpkReader.open(archive);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// exact file requested -> dump it and we are done
if (target) {
  if (!vpk.has(target)) {
    console.error(`File not found in VPK: "${target}"`);
    const similar = vpk.files().filter((p) => p.includes(target)).slice(0, 5);

    if (similar.length) {
      console.error("Did you mean:");
      for (const path of similar)
        console.error(`  ${path}${vpk.available(path) ? "" : " (chunk not on disk)"}`);
    }

    vpk.close();
    process.exit(1);
  }

  try {
    process.stdout.write(vpk.readFile(target));
  } catch {
    // multi-chunk set with only some chunks on disk
    const entry = vpk.get(target)!;
    const chunk = String(entry.archiveIndex).padStart(3, "0");
    console.error(`The file exists but its data lives in chunk archive ${chunk} (pak01_${chunk}.vpk), which is not next to the dir file.`);
    console.error("Grab that chunk too, or pick a file from an available one.");
    vpk.close();
    process.exit(1);
  }

  vpk.close();
  process.exit(0);
}

// no target -> list what looks like text, readable ones first
const textLike = vpk.files().filter((p) => /\.(txt|cfg|res|vdf|kv3|ini|json|xml)$/.test(p));
const readable = textLike.filter((p) => vpk.available(p));
const missing = textLike.length - readable.length;

// show what the reader actually found next to the dir file
const chunkIndexes = new Map<number, string>();
for (const p of vpk.files()) {
  const i = vpk.get(p)!.archiveIndex;
  if (i !== 0x7fff && !chunkIndexes.has(i))
    chunkIndexes.set(i, p);
}

const chunksOnDisk = [...chunkIndexes.values()].filter((p) => vpk.available(p)).length;
console.log(`chunk archives on disk: ${chunksOnDisk}/${chunkIndexes.size}`);
console.log(`${textLike.length} text-like files in the archive, ${readable.length} readable with the chunks on disk:`);
for (const path of readable.slice(0, 20))
  console.log(`  ${path}`);

if (readable.length > 20)
  console.log(`  ... and ${readable.length - 20} more readable`);

if (missing)
  console.log(`  (+${missing} more in chunk archives that are not on disk)`);

// the chunks we do have might just hold binary assets, make that obvious
if (!readable.length && chunksOnDisk) {
  const binaryReadable = vpk.files().filter((p) => vpk.available(p)).length;
  console.log(`  (the chunks on disk hold ${binaryReadable} files, just nothing text-like - try inspect.ts on them)`);
}

// preview the first one whose chunk archive is actually present on disk
let previewed = false;

for (const path of readable) {
  let content: string;

  try {
    content = vpk.readFile(path).toString("utf8");
  } catch {
    continue; // unreadable after all, try the next one
  }

  console.log(`\n--- ${path} ---`);
  console.log(content.length > 600 ? `${content.slice(0, 600)}\n[...]` : content);
  previewed = true;
  break;
}

if (!previewed && readable.length)
  console.log("\n(no preview: none of these files live in a chunk archive that's on disk)");

vpk.close();
