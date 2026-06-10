import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VpkReader, VpkWriter, diffVpks } from "../src/index.js";

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream)
    parts.push(chunk as Buffer);

  return Buffer.concat(parts);
};

describe("range reads and streaming", () => {
  // 700 KB pseudo-random payload, 1 KB of it preloaded -> ranges cross the boundary
  const payload = Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => (i * 31 + 7) & 0xff));
  const buffer = new VpkWriter().addFile("data/big.bin", payload, { preload: 1024 }).toBuffer();
  const vpk = VpkReader.fromBuffer(buffer);

  it("reads exact ranges, including across the preload boundary", () => {
    expect(vpk.readFileRange("data/big.bin", 0, 10).equals(payload.subarray(0, 10))).toBe(true);
    expect(vpk.readFileRange("data/big.bin", 1000, 100).equals(payload.subarray(1000, 1100))).toBe(true);
    expect(vpk.readFileRange("data/big.bin", 5000, 64).equals(payload.subarray(5000, 5064))).toBe(true);
    expect(vpk.readFileRange("data/big.bin", 0).equals(payload)).toBe(true);
  });

  it("clamps out-of-bounds ranges instead of throwing", () => {
    expect(vpk.readFileRange("data/big.bin", payload.length + 5, 10).length).toBe(0);
    expect(vpk.readFileRange("data/big.bin", payload.length - 3, 100).length).toBe(3);
    expect(() => vpk.readFileRange("data/big.bin", -1, 5)).toThrow();
  });

  it("streams the whole file in chunks", async () => {
    const streamed = await collect(vpk.createReadStream("data/big.bin"));
    expect(streamed.equals(payload)).toBe(true);
  });

  it("streams ranges with fs-style inclusive end", async () => {
    const streamed = await collect(vpk.createReadStream("data/big.bin", { start: 512, end: 2047 }));
    expect(streamed.equals(payload.subarray(512, 2048))).toBe(true);
  });

  it("throws for missing paths", () => {
    expect(() => vpk.createReadStream("nope.bin")).toThrow(/not found/i);
    expect(() => vpk.readFileRange("nope.bin", 0, 1)).toThrow(/not found/i);
  });
});

describe("preload writing", () => {
  it("stores the first N bytes in the tree and roundtrips", () => {
    const data = Buffer.from("0123456789abcdef");
    const vpk = VpkReader.fromBuffer(new VpkWriter().addFile("cfg/server.cfg", data, { preload: 4 }).toBuffer());
    const entry = vpk.get("cfg/server.cfg")!;
    expect(entry.preloadBytes).toBe(4);
    expect(entry.entryLength).toBe(12);
    expect(entry.preloadData.equals(data.subarray(0, 4))).toBe(true);
    expect(vpk.readFile("cfg/server.cfg").equals(data)).toBe(true);
    expect(vpk.verify().ok).toBe(true);
  });

  it("preload: true keeps the whole file in the tree", () => {
    const data = Buffer.from("tiny config");
    const vpk = VpkReader.fromBuffer(new VpkWriter().addFile("cfg/tiny.cfg", data, { preload: true }).toBuffer());
    const entry = vpk.get("cfg/tiny.cfg")!;
    expect(entry.preloadBytes).toBe(data.length);
    expect(entry.entryLength).toBe(0);
    expect(vpk.readFile("cfg/tiny.cfg").equals(data)).toBe(true);
    expect(vpk.verify().ok).toBe(true);
  });

  it("preloaded files survive chunked writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-pre-"));
    try {
      const data = Buffer.alloc(4096, 0x42);
      new VpkWriter().addFile("a/pre.bin", data, { preload: 100 }).addFile("a/plain.bin", data).write(join(dir, "pre_dir.vpk"), { chunkSize: 1024 });
      const vpk = VpkReader.open(join(dir, "pre_dir.vpk"));
      expect(vpk.get("a/pre.bin")!.preloadBytes).toBe(100);
      expect(vpk.readFile("a/pre.bin").equals(data)).toBe(true);
      expect(vpk.verify().ok).toBe(true);
      vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects preload over the u16 limit", () => {
    expect(() => new VpkWriter().addFile("x.bin", Buffer.alloc(1), { preload: 70000 })).toThrow();
  });
});

describe("editing via VpkWriter.from", () => {
  const original = (): Buffer =>
    new VpkWriter()
      .addFile("scripts/keep.txt", "keep me")
      .addFile("scripts/replace.txt", "old content")
      .addFile("maps/drop.bin", Buffer.alloc(512, 1))
      .addFile("cfg/pre.cfg", "preloaded!", { preload: true })
      .toBuffer();

  it("add + replace + remove, untouched files stay byte-identical", () => {
    const source = VpkReader.fromBuffer(original());
    const writer = VpkWriter.from(source);
    writer.addFile("scripts/new.txt", "fresh");
    writer.addFile("scripts/replace.txt", "new content");
    expect(writer.removeFile("maps/drop.bin")).toBe(true);
    expect(writer.removeFile("not/there.txt")).toBe(false);

    const edited = VpkReader.fromBuffer(writer.toBuffer());
    expect(edited.has("maps/drop.bin")).toBe(false);
    expect(edited.readFile("scripts/new.txt").toString()).toBe("fresh");
    expect(edited.readFile("scripts/replace.txt").toString()).toBe("new content");
    expect(edited.readFile("scripts/keep.txt").toString()).toBe("keep me");
    // preload layout preserved through the edit
    expect(edited.get("cfg/pre.cfg")!.preloadBytes).toBe("preloaded!".length);
    expect(edited.verify().ok).toBe(true);
  });

  it("a no-op edit reproduces the archive byte-for-byte", () => {
    const buffer = original();
    const source = VpkReader.fromBuffer(buffer);
    expect(VpkWriter.from(source).toBuffer().equals(buffer)).toBe(true);
  });
});

describe("diffVpks", () => {
  it("detects added, removed, changed and unchanged files", () => {
    const oldVpk = VpkReader.fromBuffer(new VpkWriter().addFile("same.txt", "stable").addFile("gone.txt", "bye").addFile("mod.txt", "v1").toBuffer());
    const newVpk = VpkReader.fromBuffer(new VpkWriter().addFile("same.txt", "stable").addFile("mod.txt", "v2 longer").addFile("fresh.txt", "hi").toBuffer());

    const diff = diffVpks(oldVpk, newVpk);
    expect(diff.added).toEqual(["fresh.txt"]);
    expect(diff.removed).toEqual(["gone.txt"]);
    expect(diff.changed.map((c) => c.path)).toEqual(["mod.txt"]);
    expect(diff.changed[0]!.oldSize).toBe(2);
    expect(diff.changed[0]!.newSize).toBe(9);
    expect(diff.unchangedCount).toBe(1);
  });

  it("identical archives diff clean", () => {
    const make = (): VpkReader => VpkReader.fromBuffer(new VpkWriter().addFile("a.txt", "x").toBuffer());
    const diff = diffVpks(make(), make());
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });
});

describe("available()", () => {
  it("reports readability per file on a partial chunk set", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-avail-"));

    try {
      new VpkWriter()
        .addFile("a/one.bin", Buffer.alloc(900, 1))
        .addFile("b/two.bin", Buffer.alloc(900, 2))
        .addFile("c/tiny.cfg", "preloaded", { preload: true })
        .write(join(dir, "p_dir.vpk"), { chunkSize: 1024 });
      rmSync(join(dir, "p_001.vpk"));

      const vpk = VpkReader.open(join(dir, "p_dir.vpk"));
      expect(vpk.available("a/one.bin")).toBe(true);   // chunk 000 on disk
      expect(vpk.available("b/two.bin")).toBe(false);  // chunk 001 deleted
      expect(vpk.available("c/tiny.cfg")).toBe(true);  // preload, no chunk needed
      expect(vpk.available("nope.txt")).toBe(false);
      vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
