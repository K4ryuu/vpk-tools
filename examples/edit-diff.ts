/**
 * Edit an archive (add/replace/remove) and diff the result against the original.
 * Everything runs in a temp dir, nothing touches your files.
 *
 * Run: bun run examples/edit-diff.ts
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VpkReader, VpkWriter, diffVpks } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "vpk-example-"));

// build a "v1" of our mod
new VpkWriter()
  .addFile("scripts/weapons.txt", '"weapons" { "ak47" { "damage" "36" } }')
  .addFile("maps/de_old.bin", Buffer.alloc(2048, 1))
  .addFile("cfg/server.cfg", "hostname my-server", { preload: true })
  .write(join(dir, "mod_v1.vpk"));

// edit it: buff the ak, drop the old map, ship a new one
const v1 = VpkReader.open(join(dir, "mod_v1.vpk"));
const writer = VpkWriter.from(v1);
writer.addFile("scripts/weapons.txt", '"weapons" { "ak47" { "damage" "40" } }');
writer.addFile("maps/de_new.bin", Buffer.alloc(4096, 2));
writer.removeFile("maps/de_old.bin");
writer.write(join(dir, "mod_v2.vpk"));

// what changed?
const v2 = VpkReader.open(join(dir, "mod_v2.vpk"));
const diff = diffVpks(v1, v2);

for (const path of diff.added)
  console.log(`+ ${path}`);

for (const path of diff.removed)
  console.log(`- ${path}`);

for (const c of diff.changed)
  console.log(`~ ${c.path} (${c.oldSize === c.newSize ? `content changed, ${c.newSize} bytes` : `${c.oldSize} -> ${c.newSize} bytes`})`);

console.log(`${diff.unchangedCount} files untouched`);

v1.close();
v2.close();
rmSync(dir, { recursive: true, force: true });
