import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AsyncVpkReader, DIR_ARCHIVE_INDEX, VpkReader, VpkWriter } from "../src/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function sampleWriter(): VpkWriter {
  return new VpkWriter().addFile("scripts/a.txt", "alpha content").addFile("scripts/b.txt", "beta").addFile("maps/big.bin", Buffer.alloc(3000, 0x5a));
}

describe("RSA signing", () => {
  const signed = sampleWriter().toBuffer({ sign: { privateKey } });

  it("writes a parseable fullFile signature section", () => {
    const vpk = VpkReader.fromBuffer(signed);
    expect(vpk.signature).not.toBeNull();
    expect(vpk.signature!.type).toBe("fullFile");
    expect(vpk.signature!.publicKey).not.toBeNull();
    expect(vpk.signature!.signature!.length).toBe(256); // 2048-bit RSA
    expect(vpk.header.signatureSectionSize).toBeGreaterThan(0);
  });

  it("verifies with the embedded key and an external PEM", () => {
    const vpk = VpkReader.fromBuffer(signed);
    expect(vpk.verifySignature()).toBe(true);
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(vpk.verifySignature(pem)).toBe(true);
    expect(vpk.verify().ok).toBe(true);
  });

  it("rejects the wrong key and tampered content", () => {
    const vpk = VpkReader.fromBuffer(signed);
    const wrongPem = otherPair.publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(vpk.verifySignature(wrongPem)).toBe(false);

    const tampered = Buffer.from(signed);
    const treeSize = tampered.readUInt32LE(8);
    tampered.writeUInt8(tampered.readUInt8(28 + treeSize) ^ 0xff, 28 + treeSize);
    const broken = VpkReader.fromBuffer(tampered);
    expect(broken.verifySignature()).toBe(false);
    expect(broken.verify().issues.some((i) => i.reason.includes("signature"))).toBe(true);
  });

  it("unsigned archives report null, MD5 checksums still pass when signed", () => {
    const unsigned = VpkReader.fromBuffer(sampleWriter().toBuffer());
    expect(unsigned.signature).toBeNull();
    expect(unsigned.verifySignature()).toBeNull();

    const vpk = VpkReader.fromBuffer(signed);
    const issues = vpk.verify().issues;
    expect(issues).toEqual([]);
  });

  it("accepts PEM string keys and rejects v1 or non-RSA signing", () => {
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const vpk = VpkReader.fromBuffer(sampleWriter().toBuffer({ sign: { privateKey: pem } }));
    expect(vpk.verifySignature()).toBe(true);

    expect(() => new VpkWriter({ version: 1 }).addFile("a.txt", "x").toBuffer({ sign: { privateKey } })).toThrow(/version 2/);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => sampleWriter().toBuffer({ sign: { privateKey: ec.privateKey } })).toThrow(/RSA/);
  });
});

describe("chunk alignment", () => {
  it("aligns inline entry offsets and stays fully valid", () => {
    const vpk = VpkReader.fromBuffer(sampleWriter().toBuffer({ align: 4096 }));
    for (const path of vpk.files()) {
      const entry = vpk.get(path)!;
      if (entry.entryLength > 0)
        expect(entry.entryOffset % 4096).toBe(0);

      expect(vpk.verifyFile(path)).toBe(true);
    }

    expect(vpk.verify().ok).toBe(true);
  });

  it("aligns offsets inside chunk archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-align-"));
    try {
      const target = join(dir, "aligned_dir.vpk");
      sampleWriter().write(target, { chunkSize: 64 * 1024, align: 512 });
      const vpk = VpkReader.open(target);
      for (const path of vpk.files()) {
        const entry = vpk.get(path)!;
        if (entry.entryLength > 0 && entry.archiveIndex !== DIR_ARCHIVE_INDEX)
          expect(entry.entryOffset % 512).toBe(0);
      }

      expect(vpk.verify().ok).toBe(true);
      vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bogus alignment values", () => {
    expect(() => sampleWriter().toBuffer({ align: 0 })).toThrow();
    expect(() => sampleWriter().toBuffer({ align: -16 })).toThrow();
    expect(() => sampleWriter().toBuffer({ align: 1.5 })).toThrow();
  });
});

describe("AsyncVpkReader", () => {
  const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const chunk of stream)
      parts.push(chunk as Buffer);

    return Buffer.concat(parts);
  };

  it("matches the sync reader on a chunked archive with preload and signature", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-async-"));
    try {
      const target = join(dir, "test_dir.vpk");
      sampleWriter().addFile("cfg/pre.cfg", "preloaded data here", { preload: 8 }).write(target, { chunkSize: 1024, sign: { privateKey } });

      const sync = VpkReader.open(target);
      const vpk = await AsyncVpkReader.open(target);

      expect(vpk.fileCount).toBe(sync.fileCount);
      expect(vpk.header).toEqual(sync.header);
      for (const path of sync.files()) {
        expect((await vpk.readFile(path)).equals(sync.readFile(path))).toBe(true);
        expect(await vpk.verifyFile(path)).toBe(true);
      }

      expect((await vpk.readFileRange("cfg/pre.cfg", 4, 8)).toString()).toBe("oaded da");
      expect((await collect(vpk.createReadStream("maps/big.bin"))).equals(sync.readFile("maps/big.bin"))).toBe(true);
      expect(await vpk.verifySignature()).toBe(true);

      const result = await vpk.verify();
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);

      sync.close();
      await vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on missing files and missing paths", async () => {
    expect(AsyncVpkReader.open("/tmp/definitely-not-a-vpk-ts-file.vpk")).rejects.toThrow();
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-async2-"));
    try {
      const target = join(dir, "x.vpk");
      sampleWriter().write(target);
      const vpk = await AsyncVpkReader.open(target);
      expect(vpk.readFile("nope.txt")).rejects.toThrow(/not found/i);
      await vpk.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeAsync produces the same bytes as write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpk-ts-wasync-"));
    try {
      const a = join(dir, "a_dir.vpk");
      const b = join(dir, "b_dir.vpk");
      sampleWriter().write(a, { chunkSize: 1024 });
      await sampleWriter().writeAsync(b, { chunkSize: 1024 });
      const fa = VpkReader.open(a);
      const fb = VpkReader.open(b);
      expect(fb.fileCount).toBe(fa.fileCount);
      for (const path of fa.files())
        expect(fb.readFile(path).equals(fa.readFile(path))).toBe(true);

      expect(fb.verify().ok).toBe(true);
      fa.close();
      fb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
