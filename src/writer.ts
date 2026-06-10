import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join, relative } from "path";
import { createHash, createPrivateKey, createPublicKey, KeyObject, sign as cryptoSign } from "crypto";
import { crc32 } from "./crc32.js";
import { DIR_ARCHIVE_INDEX, ENTRY_TERMINATOR, VPK_SIGNATURE } from "./types.js";
import type { AddFileOptions, WriteOptions, WriterOptions } from "./types.js";
import type { VpkReader } from "./reader.js";

const MAX_PRELOAD = 0xffff; // u16 in the entry record

interface PendingFile {
  ext: string;
  dir: string;
  name: string;
  /** Buffer, or a lazy loader resolved at build time (used by `VpkWriter.from`). */
  source: Buffer | (() => Buffer);
  preload: number | true;
}

interface PlacedFile {
  ext: string;
  dir: string;
  name: string;
  data: Buffer;
  crc: number;
  preloadBytes: number;
  archiveIndex: number;
  entryOffset: number;
}

function md5(data: Buffer): Buffer {
  return createHash("md5").update(data).digest();
}

/**
 * Builds VPK v1/v2 archives. Files can be embedded in a single VPK or split
 * into numbered chunk archives next to a `_dir.vpk`. Editing an existing
 * archive is a `VpkWriter.from(reader)` + add/remove + write away.
 *
 * @example
 * const writer = new VpkWriter();
 * writer.addFile("scripts/readme.txt", "hello");
 * writer.addDirectory("./assets");
 * writer.write("out_dir.vpk", { chunkSize: 64 * 1024 * 1024 });
 */
export class VpkWriter {
  private readonly version: 1 | 2;
  private readonly files = new Map<string, PendingFile>();

  constructor(options: WriterOptions = {}) {
    this.version = options.version ?? 2;
  }

  /**
    * Seeds a writer with every file of an existing archive, so you can
    * add/remove/replace entries and write the result back. File data is read
    * lazily at build time - keep the reader open until then. Preload layouts
    * are preserved.
    */
  static from(reader: VpkReader, options: WriterOptions = {}): VpkWriter {
    const writer = new VpkWriter({ version: options.version ?? reader.header.version });
    for (const path of reader.files()) {
      const entry = reader.get(path)!;
      writer.addLazy(path, () => reader.readEntry(entry), entry.preloadBytes);
    }

    return writer;
  }

  /** Adds a file under the given archive path. Overwrites a previous entry with the same path. */
  addFile(path: string, data: Buffer | string, options: AddFileOptions = {}): this {
    return this.addLazy(path, Buffer.isBuffer(data) ? data : Buffer.from(data), options.preload ?? 0);
  }

  /** Recursively adds every file in a directory, using paths relative to it. */
  addDirectory(dirPath: string, options: AddFileOptions = {}): this {
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory())
          walk(full);
        else if (entry.isFile())
          this.addFile(relative(dirPath, full), readFileSync(full), options);
      }
    };
    if (!statSync(dirPath).isDirectory())
      throw new Error(`Not a directory: "${dirPath}"`);

    walk(dirPath);
    return this;
  }

  /** Removes a queued file. Returns false when the path wasn't queued. */
  removeFile(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }

  /** True when a file is queued under the given path. */
  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** Paths queued for writing. */
  paths(): string[] {
    return [...this.files.keys()];
  }

  /** Number of files queued for writing. */
  get fileCount(): number {
    return this.files.size;
  }

  /** Builds a single-file VPK entirely in memory (all data embedded in the dir file). */
  toBuffer(options: Omit<WriteOptions, "chunkSize"> = {}): Buffer {
    return this.build(options).dir;
  }

  /**
    * Writes the archive to disk. With `chunkSize` set, `targetPath` must end in
    * `_dir.vpk` and file data is split into `name_000.vpk`, `name_001.vpk`, ...
    * Returns the list of files written.
    */
  write(targetPath: string, options: WriteOptions = {}): string[] {
    const outputs = this.layoutOutputs(targetPath, options);
    for (const [path, data] of outputs)
      writeFileSync(path, data);

    return outputs.map(([path]) => path);
  }

  /** Async variant of {@link write}, chunk archives are written in parallel. */
  async writeAsync(targetPath: string, options: WriteOptions = {}): Promise<string[]> {
    const outputs = this.layoutOutputs(targetPath, options);
    await Promise.all(outputs.map(([path, data]) => writeFile(path, data)));
    return outputs.map(([path]) => path);
  }

  private layoutOutputs(targetPath: string, options: WriteOptions): [string, Buffer][] {
    const { chunkSize } = options;
    if (chunkSize !== undefined) {
      if (chunkSize <= 0)
        throw new Error("chunkSize must be positive");

      if (!targetPath.toLowerCase().endsWith("_dir.vpk"))
        throw new Error('Chunked archives require a target path ending in "_dir.vpk"');
    }

    const { dir, chunks } = this.build(options);
    const base = targetPath.slice(0, -"_dir.vpk".length);
    return [[targetPath, dir] as [string, Buffer], ...chunks.map((chunk, index): [string, Buffer] => [`${base}_${String(index).padStart(3, "0")}.vpk`, chunk])];
  }

  private addLazy(path: string, source: Buffer | (() => Buffer), preload: number | true): this {
    const normalized = normalizePath(path);
    if (!normalized || normalized.endsWith("/"))
      throw new Error(`Invalid VPK path: "${path}"`);

    if (preload !== true && (preload < 0 || preload > MAX_PRELOAD))
      throw new Error(`preload must be 0-${MAX_PRELOAD} bytes or true`);

    const slash = normalized.lastIndexOf("/");
    const dir = slash === -1 ? "" : normalized.slice(0, slash);
    const file = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dot = file.lastIndexOf(".");
    const name = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot + 1) : "";
    if (dot > 0 && ext === "")
      throw new Error(`Invalid VPK path (trailing dot): "${path}"`);

    this.files.set(normalized, { ext, dir, name, source, preload });
    return this;
  }

  private build(options: WriteOptions = {}): { dir: Buffer; chunks: Buffer[] } {
    if (this.files.size === 0)
      throw new Error("Cannot write an empty VPK");

    const { chunkSize, align, sign } = options;
    if (align !== undefined && (!Number.isInteger(align) || align <= 0))
      throw new Error("align must be a positive integer");

    if (sign && this.version !== 2)
      throw new Error("Signing requires VPK version 2");

    // place file data: preload stays in the tree, the rest goes to chunks or inline
    const chunks: Buffer[][] = [];
    const chunkSizes: number[] = [];
    const inlineParts: Buffer[] = [];
    let inlineOffset = 0;

    // zero-pad an archive up to the alignment boundary, returns the new offset
    const pad = (parts: Buffer[], offset: number): number => {
      if (align === undefined || offset % align === 0)
        return offset;

      const fill = align - (offset % align);
      parts.push(Buffer.alloc(fill));
      return offset + fill;
    };

    const placed: PlacedFile[] = [];
    const sorted = [...this.files.values()].sort((a, b) => a.ext.localeCompare(b.ext) || a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));

    for (const file of sorted) {
      const data = Buffer.isBuffer(file.source) ? file.source : file.source();
      const preloadBytes = Math.min(file.preload === true ? data.length : file.preload, data.length);
      if (preloadBytes > MAX_PRELOAD)
        throw new Error(`Preload exceeds ${MAX_PRELOAD} bytes for "${file.dir}/${file.name}"`);

      const archivePart = data.length - preloadBytes;
      const crc = crc32(data);
      const base = { ext: file.ext, dir: file.dir, name: file.name, data, crc, preloadBytes };

      if (archivePart === 0) {
        placed.push({ ...base, archiveIndex: DIR_ARCHIVE_INDEX, entryOffset: 0 });
      } else if (chunkSize === undefined) {
        inlineOffset = pad(inlineParts, inlineOffset);
        placed.push({ ...base, archiveIndex: DIR_ARCHIVE_INDEX, entryOffset: inlineOffset });
        inlineParts.push(data.subarray(preloadBytes));
        inlineOffset += archivePart;
      } else {
        let index = chunks.length - 1;
        if (index < 0 || (chunkSizes[index]! > 0 && chunkSizes[index]! + archivePart > chunkSize)) {
          chunks.push([]);
          chunkSizes.push(0);
          index++;
        }

        chunkSizes[index] = pad(chunks[index]!, chunkSizes[index]!);
        placed.push({ ...base, archiveIndex: index, entryOffset: chunkSizes[index]! });
        chunks[index]!.push(data.subarray(preloadBytes));
        chunkSizes[index]! += archivePart;
      }
    }

    const tree = this.buildTree(placed);
    const fileData = Buffer.concat(inlineParts);
    const chunkBuffers = chunks.map((parts) => Buffer.concat(parts));

    const headerLength = this.version === 1 ? 12 : 28;
    const header = Buffer.alloc(headerLength);
    header.writeUInt32LE(VPK_SIGNATURE, 0);
    header.writeUInt32LE(this.version, 4);
    header.writeUInt32LE(tree.length, 8);

    if (this.version === 1)
      return { dir: Buffer.concat([header, tree, fileData]), chunks: chunkBuffers };

    // v2: archive MD5 section (one entry per chunk), then the "other MD5" section
    const archiveMD5 = Buffer.alloc(chunkBuffers.length * 28);
    chunkBuffers.forEach((chunk, index) => {
      const off = index * 28;
      archiveMD5.writeUInt32LE(index, off);
      archiveMD5.writeUInt32LE(0, off + 4);
      archiveMD5.writeUInt32LE(chunk.length, off + 8);
      md5(chunk).copy(archiveMD5, off + 12);
    });

    // the signature section size lives in the header, so it goes in before hashing
    const signer = sign ? prepareSigner(sign.privateKey) : null;

    header.writeUInt32LE(fileData.length, 12);
    header.writeUInt32LE(archiveMD5.length, 16);
    header.writeUInt32LE(48, 20);
    header.writeUInt32LE(signer ? signer.sectionSize : 0, 24);

    const beforeOther = Buffer.concat([header, tree, fileData, archiveMD5]);
    const treeAndSectionMD5 = Buffer.concat([md5(tree), md5(archiveMD5)]);
    const wholeFileMD5 = md5(Buffer.concat([beforeOther, treeAndSectionMD5]));
    const beforeSignature = Buffer.concat([beforeOther, treeAndSectionMD5, wholeFileMD5]);
    if (!signer)
      return { dir: beforeSignature, chunks: chunkBuffers };

    return { dir: Buffer.concat([beforeSignature, signer.sign(beforeSignature)]), chunks: chunkBuffers };
  }

  private buildTree(placed: PlacedFile[]): Buffer {
    // ext -> dir -> files, with " " standing in for empty ext/dir per the format
    const byExt = new Map<string, Map<string, PlacedFile[]>>();
    for (const file of placed) {
      const ext = file.ext === "" ? " " : file.ext;
      const dir = file.dir === "" ? " " : file.dir;
      const dirs = byExt.get(ext) ?? new Map<string, PlacedFile[]>();
      byExt.set(ext, dirs);
      const list = dirs.get(dir) ?? [];
      dirs.set(dir, list);
      list.push(file);
    }

    const parts: Buffer[] = [];
    const cstr = (s: string): void => {
      parts.push(Buffer.from(`${s}\0`, "utf8"));
    };

    for (const [ext, dirs] of byExt) {
      cstr(ext);
      for (const [dir, files] of dirs) {
        cstr(dir);
        for (const file of files) {
          cstr(file.name);
          const entry = Buffer.alloc(18);
          entry.writeUInt32LE(file.crc, 0);
          entry.writeUInt16LE(file.preloadBytes, 4);
          entry.writeUInt16LE(file.archiveIndex, 6);
          entry.writeUInt32LE(file.entryOffset, 8);
          entry.writeUInt32LE(file.data.length - file.preloadBytes, 12);
          entry.writeUInt16LE(ENTRY_TERMINATOR, 16);
          parts.push(entry);
          if (file.preloadBytes > 0)
            parts.push(file.data.subarray(0, file.preloadBytes));
        }

        cstr("");
      }

      cstr("");
    }

    cstr("");
    return Buffer.concat(parts);
  }
}

/**
 * Sets up legacy "fullFile" signing the way vpk.exe does it: the section is
 * u32 keySize + DER SPKI key + u32 sigSize + RSA PKCS#1 v1.5 SHA-256 signature
 * over everything before the section.
 */
function prepareSigner(privateKeyInput: string | Buffer | KeyObject): { sectionSize: number; sign: (data: Buffer) => Buffer } {
  const privateKey = privateKeyInput instanceof KeyObject ? privateKeyInput : createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== "rsa")
    throw new Error("VPK signing requires an RSA private key");

  const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength;
  if (!modulusLength)
    throw new Error("Cannot determine RSA key size");

  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const signatureSize = modulusLength / 8;

  return {
    sectionSize: 4 + publicKey.length + 4 + signatureSize,
    sign(data) {
      const signature = cryptoSign("sha256", data, privateKey);
      const section = Buffer.alloc(4 + publicKey.length + 4 + signature.length);
      section.writeUInt32LE(publicKey.length, 0);
      publicKey.copy(section, 4);
      section.writeUInt32LE(signature.length, 4 + publicKey.length);
      signature.copy(section, 8 + publicKey.length);
      return section;
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}
