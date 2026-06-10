import { describe, expect, it } from "bun:test";
import { crc32 } from "../src/index.js";

describe("crc32", () => {
  // known vectors from zlib
  it("matches known test vectors", () => {
    expect(crc32(Buffer.from(""))).toBe(0x00000000);
    expect(crc32(Buffer.from("a"))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from("abc"))).toBe(0x352441c2);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("matches a naive bitwise reference implementation on binary data", () => {
    const naive = (data: Buffer): number => {
      let crc = 0xffffffff;
      for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++)
          crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }

      return (crc ^ 0xffffffff) >>> 0;
    };
    const buf = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff));
    expect(crc32(buf)).toBe(naive(buf));
  });

  it("supports incremental seeding", () => {
    const whole = crc32(Buffer.from("hello world"));
    const part = crc32(Buffer.from(" world"), crc32(Buffer.from("hello")));
    expect(part).toBe(whole);
  });
});
