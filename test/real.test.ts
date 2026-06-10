import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { DIR_ARCHIVE_INDEX, VpkReader } from "../src/index.js";

/**
 * Integration tests against a real CS2 VPK pulled from Steam.
 * Run `bun run fetch-fixtures` first; skipped when fixtures are absent.
 *
 * Ground truth here is Valve's own embedded checksums - if the parser misreads
 * a single byte of the tree, the MD5s won't match.
 */
const FIXTURE = process.env.VPK_FIXTURE ?? join(import.meta.dir, "fixtures/real/pak01_dir.vpk");
const available = existsSync(FIXTURE);

// chunk archives downloaded next to the dir file, e.g. pak01_277.vpk
const availableChunks = new Set<number>(
  available
    ? readdirSync(dirname(FIXTURE))
      .map((f) => /^pak01_(\d{3})\.vpk$/.exec(f)?.[1])
      .filter((m): m is string => m !== undefined)
      .map(Number)
    : [],
);

describe.skipIf(!available)("real CS2 pak01_dir.vpk", () => {
  it("parses the full directory tree", () => {
    const vpk = VpkReader.open(FIXTURE);
    expect(vpk.header.version).toBe(2);
    expect(vpk.fileCount).toBeGreaterThan(100000);
    expect(vpk.checksums).not.toBeNull();
    // every path should be sane: no empty segments, no backslashes
    for (const path of vpk.files())
      expect(path).not.toMatch(/\\|\/\/|^\//);

    vpk.close();
  }, 120000);

  it("validates Valve's embedded tree, section and whole-file MD5s", () => {
    const vpk = VpkReader.open(FIXTURE);
    const result = vpk.verify();
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    vpk.close();
  }, 240000);

  it("parses CS2's marker-style signature section without an embedded key", () => {
    const vpk = VpkReader.open(FIXTURE);
    // CS2 ships a 20-byte marker section: type info only, key and signature live elsewhere
    if (vpk.header.signatureSectionSize > 0) {
      expect(vpk.signature).not.toBeNull();
      expect(vpk.verifySignature()).toBeNull();
    }

    vpk.close();
  });

  it.skipIf(availableChunks.size === 0)(
    "reads files from a real chunk archive and matches Valve's CRCs",
    () => {
      const vpk = VpkReader.open(FIXTURE);
      let read = 0;
      for (const path of vpk.files()) {
        const entry = vpk.get(path)!;
        if (!availableChunks.has(entry.archiveIndex) || entry.archiveIndex === DIR_ARCHIVE_INDEX)
          continue;

        const data = vpk.readFile(path);
        expect(data.length).toBe(entry.totalLength);
        expect(vpk.verifyFile(path)).toBe(true);
        if (++read >= 200)
          break;
      }

      expect(read).toBeGreaterThan(0);
      vpk.close();
    },
    240000,
  );
});

if (!available)
  console.log(`[real.test] fixture missing (${FIXTURE}) - run "bun run fetch-fixtures" to enable integration tests`);
