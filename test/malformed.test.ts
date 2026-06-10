import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VpkReader, VpkWriter } from "../src/index.js";

function validV2(): Buffer {
  const writer = new VpkWriter({ version: 2 });
  writer.addFile("scripts/a.txt", "alpha");
  writer.addFile("scripts/b.txt", "beta");
  return writer.toBuffer();
}

describe("malformed input handling", () => {
  it("rejects a bad signature", () => {
    const buf = validV2();
    buf.writeUInt32LE(0xdeadbeef, 0);
    expect(() => VpkReader.fromBuffer(buf)).toThrow(/signature/i);
  });

  it("rejects unsupported versions", () => {
    const buf = validV2();
    buf.writeUInt32LE(3, 4);
    expect(() => VpkReader.fromBuffer(buf)).toThrow(/version/i);
  });

  it("rejects a truncated tree", () => {
    const buf = validV2();
    expect(() => VpkReader.fromBuffer(buf.subarray(0, 40))).toThrow();
  });

  it("rejects a corrupted entry terminator", () => {
    const buf = validV2();
    // first terminator: header(28) + "txt\0scripts\0a\0" + 16 bytes into the entry
    const treeStart = 28;
    const terminatorOffset = treeStart + "txt\0scripts\0a\0".length + 16;
    buf.writeUInt16LE(0x1234, terminatorOffset);
    expect(() => VpkReader.fromBuffer(buf)).toThrow(/terminator/i);
  });

  it("detects flipped content bytes via CRC", () => {
    const buf = validV2();
    // content lives right after the tree; flip one byte of "alpha"
    const treeSize = buf.readUInt32LE(8);
    buf.writeUInt8(buf.readUInt8(28 + treeSize) ^ 0xff, 28 + treeSize);
    const vpk = VpkReader.fromBuffer(buf);
    const result = vpk.verify();
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.reason.includes("CRC32"))).toBe(true);
    // whole-file md5 must also break
    expect(result.issues.some((i) => i.reason.includes("whole-file"))).toBe(true);
  });

  it("detects a tampered tree via tree MD5", () => {
    const buf = validV2();
    // flip a filename character inside the tree (after "txt\0scripts\0")
    const nameOffset = 28 + "txt\0scripts\0".length;
    buf.writeUInt8(buf.readUInt8(nameOffset) ^ 0x01, nameOffset);
    const vpk = VpkReader.fromBuffer(buf);
    const result = vpk.verify();
    expect(result.issues.some((i) => i.reason.includes("tree MD5"))).toBe(true);
  });

  it("rejects empty buffers and garbage", () => {
    expect(() => VpkReader.fromBuffer(Buffer.alloc(0))).toThrow();
    expect(() => VpkReader.fromBuffer(Buffer.from("not a vpk at all"))).toThrow();
  });

  it("writer rejects invalid inputs", () => {
    const writer = new VpkWriter();
    expect(() => writer.addFile("", "x")).toThrow();
    expect(() => writer.addFile("dir/", "x")).toThrow();
    expect(() => writer.toBuffer()).toThrow(/empty/i);
    expect(() => new VpkWriter().addFile("a.txt", "x").write("out.vpk", { chunkSize: 1 })).toThrow(/_dir\.vpk/);
  });

  it("readFile throws a clear error for missing paths", () => {
    const vpk = VpkReader.fromBuffer(validV2());
    expect(() => vpk.readFile("does/not/exist.txt")).toThrow(/not found/i);
  });
});

describe("resource cleanup", () => {
  it("does not leak file descriptors when open() fails", () => {
    const garbage = join(tmpdir(), "vpk-tools-not-a-vpk.bin");
    writeFileSync(garbage, "definitely not a vpk file at all");

    const openFds = (): number => readdirSync("/dev/fd").length;
    const before = openFds();
    for (let i = 0; i < 50; i++)
      expect(() => VpkReader.open(garbage)).toThrow();

    expect(openFds()).toBe(before);
    rmSync(garbage);
  });
});

describe("chunk archive mixup", () => {
  it("explains that a _NNN.vpk is a chunk, not a dir file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-tools-chunk-"));

    try {
      new VpkWriter().addFile("a.txt", Buffer.alloc(2048, 1)).write(join(dir, "pak_dir.vpk"), { chunkSize: 1024 });
      expect(() => VpkReader.open(join(dir, "pak_000.vpk"))).toThrow(/chunk archive.*_dir\.vpk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
