import type { VpkDiff } from "./types.js";
import type { VpkReader } from "./reader.js";

/**
 * Compares two archives by their directory trees (CRC32 + size), so it's
 * fast even on 100k+ file paks - no file data is read. Handy for seeing
 * what a game update actually touched.
 */
export function diffVpks(oldVpk: VpkReader, newVpk: VpkReader): VpkDiff {
  const added: VpkDiff["added"] = [];
  const removed: VpkDiff["removed"] = [];
  const changed: VpkDiff["changed"] = [];
  let unchangedCount = 0;

  const oldPaths = new Set(oldVpk.files());
  for (const path of newVpk.files()) {
    const oldEntry = oldVpk.get(path);
    if (!oldEntry) {
      added.push(path);
      continue;
    }

    oldPaths.delete(path);
    const newEntry = newVpk.get(path)!;
    if (oldEntry.crc !== newEntry.crc || oldEntry.totalLength !== newEntry.totalLength)
      changed.push({ path, oldSize: oldEntry.totalLength, newSize: newEntry.totalLength });
    else
      unchangedCount++;
  }

  removed.push(...oldPaths);

  added.sort();
  removed.sort();
  changed.sort((a, b) => a.path.localeCompare(b.path));
  return { added, removed, changed, unchangedCount };
}
