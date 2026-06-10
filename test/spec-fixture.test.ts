import { describe, expect, it } from "bun:test";
import { VpkReader, crc32 } from "../src/index.js";

/**
 * Hand-crafted minimal VPK v1 built byte-by-byte from the format spec
 * (https://developer.valvesoftware.com/wiki/VPK_(file_format)).
 * Independent of VpkWriter, so reader and writer can't agree on a wrong format.
 */
function buildSpecV1(): { buffer: Buffer; content: Buffer } {
  const content = Buffer.from("hello vpk");
  const crc = crc32(content);

  const parts: Buffer[] = [];
  const cstr = (s: string): void => {
    parts.push(Buffer.from(`${s}\0`));
  };

  cstr("txt"); // extension
  cstr("scripts"); // directory
  cstr("readme"); // filename
  const entry = Buffer.alloc(18);
  entry.writeUInt32LE(crc, 0); // crc32
  entry.writeUInt16LE(0, 4); // preload bytes
  entry.writeUInt16LE(0x7fff, 6); // archive index: in dir file
  entry.writeUInt32LE(0, 8); // entry offset
  entry.writeUInt32LE(content.length, 12); // entry length
  entry.writeUInt16LE(0xffff, 16); // terminator
  parts.push(entry);
  cstr(""); // end of files in "scripts"
  cstr(""); // end of dirs in "txt"
  cstr(""); // end of extensions

  const tree = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);

  return { buffer: Buffer.concat([header, tree, content]), content };
}

/** Same file but stored as preload data, with " " (space) for root dir and no extension. */
function buildSpecV1Preload(): { buffer: Buffer; content: Buffer } {
  const content = Buffer.from("preloaded");
  const crc = crc32(content);

  const parts: Buffer[] = [];
  const cstr = (s: string): void => {
    parts.push(Buffer.from(`${s}\0`));
  };

  cstr(" "); // no extension
  cstr(" "); // root directory
  cstr("VERSION"); // filename
  const entry = Buffer.alloc(18);
  entry.writeUInt32LE(crc, 0);
  entry.writeUInt16LE(content.length, 4); // everything preloaded
  entry.writeUInt16LE(0x7fff, 6);
  entry.writeUInt32LE(0, 8);
  entry.writeUInt32LE(0, 12); // no archive part
  entry.writeUInt16LE(0xffff, 16);
  parts.push(entry, content); // preload data follows the entry inline
  cstr("");
  cstr("");
  cstr("");

  const tree = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);

  return { buffer: Buffer.concat([header, tree]), content };
}

describe("spec-conformant hand-crafted VPK v1", () => {
  it("parses a minimal archive with dir-embedded data", () => {
    const { buffer, content } = buildSpecV1();
    const vpk = VpkReader.fromBuffer(buffer);
    expect(vpk.header.version).toBe(1);
    expect(vpk.files()).toEqual(["scripts/readme.txt"]);
    const entry = vpk.get("scripts/readme.txt")!;
    expect(entry.archiveIndex).toBe(0x7fff);
    expect(entry.totalLength).toBe(content.length);
    expect(vpk.readFile("scripts/readme.txt").equals(content)).toBe(true);
    expect(vpk.verifyFile("scripts/readme.txt")).toBe(true);
    expect(vpk.verify().ok).toBe(true);
  });

  it("parses preload-only entries with blank dir and extension", () => {
    const { buffer, content } = buildSpecV1Preload();
    const vpk = VpkReader.fromBuffer(buffer);
    expect(vpk.files()).toEqual(["VERSION"]);
    const entry = vpk.get("VERSION")!;
    expect(entry.preloadBytes).toBe(content.length);
    expect(entry.entryLength).toBe(0);
    expect(vpk.readFile("VERSION").equals(content)).toBe(true);
    expect(vpk.verify().ok).toBe(true);
  });
});
