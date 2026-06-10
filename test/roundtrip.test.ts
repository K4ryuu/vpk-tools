import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { VpkReader, VpkWriter } from "../src/index.js";

const SAMPLE: Record<string, Buffer> = {
  "scripts/items/items_game.txt": Buffer.from('"items_game"\n{\n\t"rarities" {}\n}\n'),
  "materials/wood/door01.vmat": Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f]),
  "materials/metal/wall.vmat": Buffer.alloc(1024, 0xab),
  "root_file.txt": Buffer.from("at the root"),
  no_extension_file: Buffer.from("naked file"),
  "sound/ui/empty.wav": Buffer.alloc(0),
};

function fillWriter(version: 1 | 2): VpkWriter {
  const writer = new VpkWriter({ version });
  for (const [path, data] of Object.entries(SAMPLE))
    writer.addFile(path, data);

  return writer;
}

function expectAllContents(vpk: VpkReader): void {
  expect(vpk.fileCount).toBe(Object.keys(SAMPLE).length);
  for (const [path, data] of Object.entries(SAMPLE)) {
    expect(vpk.has(path)).toBe(true);
    expect(vpk.readFile(path).equals(data)).toBe(true);
    expect(vpk.verifyFile(path)).toBe(true);
  }
}

describe("write -> read roundtrip", () => {
  for (const version of [1, 2] as const) {
    it(`roundtrips a single-file v${version} VPK in memory`, () => {
      const vpk = VpkReader.fromBuffer(fillWriter(version).toBuffer());
      expect(vpk.header.version).toBe(version);
      expectAllContents(vpk);
      const result = vpk.verify();
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.skippedFiles).toEqual([]);
    });
  }

  it("v2 checksums are present and self-consistent", () => {
    const vpk = VpkReader.fromBuffer(fillWriter(2).toBuffer());
    expect(vpk.checksums).not.toBeNull();
    expect(vpk.checksums!.treeChecksum.length).toBe(16);
    expect(vpk.checksums!.wholeFileChecksum.length).toBe(16);
  });

  it("toBuffer output is deterministic", () => {
    expect(fillWriter(2).toBuffer().equals(fillWriter(2).toBuffer())).toBe(true);
  });

  it("roundtrips a multi-chunk v2 VPK on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-"));
    try {
      const target = join(dir, "test_dir.vpk");
      // small chunk size forces several archives
      const written = fillWriter(2).write(target, { chunkSize: 1024 });
      expect(written.length).toBeGreaterThan(2);
      expect(existsSync(join(dir, "test_000.vpk"))).toBe(true);

      const vpk = VpkReader.open(target);
      expectAllContents(vpk);
      const result = vpk.verify();
      expect(result.ok).toBe(true);
      expect(result.skippedFiles).toEqual([]);
      // chunked archive md5 entries must exist and validate
      expect(vpk.archiveMD5Entries.length).toBeGreaterThan(0);
      vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports skipped files when chunk archives are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-"));
    try {
      const target = join(dir, "test_dir.vpk");
      fillWriter(2).write(target, { chunkSize: 1024 });
      rmSync(join(dir, "test_001.vpk"));

      const vpk = VpkReader.open(target);
      const result = vpk.verify();
      expect(result.skippedFiles.length).toBeGreaterThan(0);
      expect(result.ok).toBe(true);
      expect(() => vpk.readFile(result.skippedFiles[0]!)).toThrow();
      vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("roundtrips addDirectory from a real folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-src-"));
    try {
      const writer = new VpkWriter();
      const out = join(dir, "out");
      // build a folder from SAMPLE, then pack it
      for (const [path, data] of Object.entries(SAMPLE)) {
        const full = join(out, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, data);
      }

      writer.addDirectory(out);
      const vpk = VpkReader.fromBuffer(writer.toBuffer());
      expectAllContents(vpk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
