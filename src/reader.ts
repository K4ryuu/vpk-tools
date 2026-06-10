import { closeSync, existsSync, openSync, readSync, fstatSync } from "fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import { Readable } from "stream";
import { crc32 } from "./crc32.js";
import { parseArchiveMD5Section, parseChecksums, parseHeader, parseSignatureSection, parseTree } from "./format.js";
import { DIR_ARCHIVE_INDEX } from "./types.js";
import type { ArchiveMD5Entry, ReadStreamOptions, VerifyResult, VpkChecksums, VpkEntry, VpkHeader, VpkSignature } from "./types.js";

interface DataSource {
  readAt(offset: number, length: number): Buffer;
  size(): number;
  close(): void;
}

function fileSource(path: string): DataSource {
  const fd = openSync(path, "r");
  return {
    readAt(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, offset);
      if (read !== length)
        throw new Error(`Short read in "${path}": wanted ${length} bytes at ${offset}, got ${read}`);

      return buf;
    },
    size: () => fstatSync(fd).size,
    close: () => closeSync(fd),
  };
}

function bufferSource(buffer: Buffer): DataSource {
  return {
    readAt(offset, length) {
      if (offset + length > buffer.length)
        throw new Error(`Short read: wanted ${length} bytes at ${offset}, buffer is ${buffer.length}`);

      return buffer.subarray(offset, offset + length);
    },
    size: () => buffer.length,
    close: () => {},
  };
}

function md5(data: Buffer): Buffer {
  return createHash("md5").update(data).digest();
}

/**
 * Reads VPK v1/v2 archives. Supports single-file VPKs and multi-chunk
 * `_dir.vpk` + `_000.vpk` sets. Only the header and directory tree are kept
 * in memory; file data is read on demand.
 *
 * @example
 * const vpk = VpkReader.open("pak01_dir.vpk");
 * const data = vpk.readFile("scripts/items/items_game.txt");
 * console.log(vpk.verify());
 * vpk.close();
 */
export class VpkReader {
  readonly header: VpkHeader;
  /** v2 only: checksums from the "other MD5" section. */
  readonly checksums: VpkChecksums | null;
  /** v2 only: parsed archive MD5 section entries. */
  readonly archiveMD5Entries: ArchiveMD5Entry[];
  /** v2 only: parsed signature section, null when the archive is unsigned. */
  readonly signature: VpkSignature | null;

  private readonly entries: Map<string, VpkEntry>;
  private readonly dir: DataSource;
  private readonly chunks = new Map<number, DataSource>();
  private readonly chunkPathFor: (index: number) => string | null;
  private readonly treeBuffer: Buffer;
  private closed = false;

  private constructor(dir: DataSource, chunkPathFor: (index: number) => string | null) {
    this.dir = dir;
    this.chunkPathFor = chunkPathFor;

    const size = dir.size();
    this.header = parseHeader(dir.readAt(0, Math.min(28, size)), size);
    this.treeBuffer = dir.readAt(this.header.headerLength, this.header.treeSize);
    this.entries = parseTree(this.treeBuffer);

    if (this.header.version === 2) {
      const { headerLength, treeSize, fileDataSectionSize, archiveMD5SectionSize, otherMD5SectionSize, signatureSectionSize } = this.header;
      const md5Start = headerLength + treeSize + fileDataSectionSize;
      this.archiveMD5Entries = parseArchiveMD5Section(archiveMD5SectionSize > 0 ? dir.readAt(md5Start, archiveMD5SectionSize) : Buffer.alloc(0));
      this.checksums = otherMD5SectionSize >= 48 ? parseChecksums(dir.readAt(md5Start + archiveMD5SectionSize, 48)) : null;
      const sigStart = md5Start + archiveMD5SectionSize + otherMD5SectionSize;
      this.signature = signatureSectionSize > 0 ? parseSignatureSection(dir.readAt(sigStart, signatureSectionSize)) : null;
    } else {
      this.archiveMD5Entries = [];
      this.checksums = null;
      this.signature = null;
    }
  }

  /**
   * Opens a VPK from disk. For multi-chunk sets pass the `_dir.vpk` path;
   * chunk archives are resolved automatically next to it.
   */
  static open(filePath: string): VpkReader {
    const dirSuffix = "_dir.vpk";
    const base = filePath.toLowerCase().endsWith(dirSuffix) ? filePath.slice(0, -dirSuffix.length) : null;
    const source = fileSource(filePath);

    try {
      return new VpkReader(source, (index) => {
        if (base === null)
          return null;

        const chunkPath = `${base}_${String(index).padStart(3, "0")}.vpk`;
        return existsSync(chunkPath) ? chunkPath : null;
      });
    } catch (error) {
      // parse failed, don't leak the fd
      source.close();

      // chunk archives are raw data without a header, a common mixup
      if (/_\d{3}\.vpk$/i.test(filePath) && error instanceof Error && error.message.includes("bad signature"))
        throw new Error(`"${filePath}" is a chunk archive (raw file data, no header) - open the matching _dir.vpk instead`);

      throw error;
    }
  }

  /**
   * Opens a VPK from memory. Chunk archives for multi-chunk sets can be
   * provided keyed by archive index.
   */
  static fromBuffer(dirBuffer: Buffer, chunks?: Record<number, Buffer>): VpkReader {
    const reader = new VpkReader(bufferSource(dirBuffer), () => null);
    if (chunks) {
      for (const [index, buf] of Object.entries(chunks))
        reader.chunks.set(Number(index), bufferSource(buf));
    }

    return reader;
  }

  /** All file paths in the archive. */
  files(): string[] {
    return [...this.entries.keys()];
  }

  /** Number of files in the archive. */
  get fileCount(): number {
    return this.entries.size;
  }

  /** Returns the directory entry for a path, or null if not present. */
  get(path: string): VpkEntry | null {
    return this.entries.get(normalizePath(path)) ?? null;
  }

  /** True if the archive contains the given path. */
  has(path: string): boolean {
    return this.entries.has(normalizePath(path));
  }

  /** Reads the complete content of a file (preload + archive part). */
  readFile(path: string): Buffer {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return this.readEntry(entry);
  }

  /** Reads the complete content of a directory entry. */
  readEntry(entry: VpkEntry): Buffer {
    if (entry.entryLength === 0)
      return entry.preloadData;

    let data: Buffer;
    if (entry.archiveIndex === DIR_ARCHIVE_INDEX) {
      const dataStart = this.header.headerLength + this.header.treeSize;
      data = this.dir.readAt(dataStart + entry.entryOffset, entry.entryLength);
    } else {
      data = this.chunk(entry.archiveIndex).readAt(entry.entryOffset, entry.entryLength);
    }

    return entry.preloadBytes > 0 ? Buffer.concat([entry.preloadData, data]) : data;
  }

  /**
   * Reads a byte range of a file without loading the rest. The range can
   * span the preload/archive boundary.
   */
  readFileRange(path: string, start: number, length?: number): Buffer {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return this.readEntryRange(entry, start, length);
  }

  /** Range read on a directory entry, see {@link readFileRange}. */
  readEntryRange(entry: VpkEntry, start: number, length?: number): Buffer {
    if (start < 0)
      throw new Error(`Invalid range start: ${start}`);

    const from = Math.min(start, entry.totalLength);
    const to = Math.min(from + (length ?? entry.totalLength), entry.totalLength);
    if (to <= from)
      return Buffer.alloc(0);

    const parts: Buffer[] = [];
    if (from < entry.preloadBytes)
      parts.push(entry.preloadData.subarray(from, Math.min(to, entry.preloadBytes)));

    if (to > entry.preloadBytes) {
      const archiveFrom = Math.max(from - entry.preloadBytes, 0);
      const archiveLength = to - entry.preloadBytes - archiveFrom;
      const source = entry.archiveIndex === DIR_ARCHIVE_INDEX ? this.dir : this.chunk(entry.archiveIndex);
      const base = entry.archiveIndex === DIR_ARCHIVE_INDEX ? this.header.headerLength + this.header.treeSize : 0;
      parts.push(source.readAt(base + entry.entryOffset + archiveFrom, archiveLength));
    }

    return parts.length === 1 ? Buffer.from(parts[0]!) : Buffer.concat(parts);
  }

  /**
   * Streams a file (or a byte range of it) without buffering it whole,
   * reading 256 KB at a time. `start`/`end` follow `fs.createReadStream`
   * semantics (`end` is inclusive).
   */
  createReadStream(path: string, options: ReadStreamOptions = {}): Readable {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    const start = options.start ?? 0;
    const end = Math.min(options.end ?? entry.totalLength - 1, entry.totalLength - 1);
    let position = start;

    const CHUNK = 256 * 1024;
    const readEntryRange = this.readEntryRange.bind(this);
    return new Readable({
      read(): void {
        try {
          if (position > end) {
            this.push(null);
            return;
          }

          const data = readEntryRange(entry, position, Math.min(CHUNK, end - position + 1));
          position += data.length;
          this.push(data.length > 0 ? data : null);
        } catch (error) {
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  }

  /**
   * True when the file's data can actually be read right now - either it
   * lives in the dir file, or its chunk archive is present on disk. Handy
   * for partial sets where only some chunks were downloaded.
   */
  available(path: string): boolean {
    const entry = this.get(path);
    if (!entry)
      return false;

    if (entry.entryLength === 0 || entry.archiveIndex === DIR_ARCHIVE_INDEX)
      return true;

    return this.chunkAvailable(entry.archiveIndex);
  }

  /** Validates a single file's CRC32. */
  verifyFile(path: string): boolean {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return crc32(this.readEntry(entry)) === entry.crc;
  }

  /**
   * Checks the RSA signature (v2). Pass a public key (PEM/DER) to verify
   * against an external key instead of the embedded one. Returns null when
   * there's no signature (or no key) to check.
   */
  verifySignature(publicKey?: string | Buffer): boolean | null {
    if (!this.signature?.signature)
      return null;

    const keyInput = publicKey ?? this.signature.publicKey;
    if (!keyInput)
      return null;

    // PEM as string, DER SPKI as buffer (the embedded key is always DER)
    const key = typeof keyInput === "string" ? createPublicKey(keyInput) : createPublicKey({ key: keyInput, format: "der", type: "spki" });

    const md5Start = this.header.headerLength + this.header.treeSize + this.header.fileDataSectionSize;
    const beforeSignature = md5Start + this.header.archiveMD5SectionSize + this.header.otherMD5SectionSize;
    const signed = this.signature.type === "fileChecksum" ? this.checksums?.wholeFileChecksum : this.dir.readAt(0, beforeSignature);
    if (!signed)
      return null;

    return cryptoVerify("sha256", signed, key, this.signature.signature);
  }

  /**
   * Validates the whole archive: per-file CRC32, and for v2 the tree MD5,
   * archive MD5 section, whole-file MD5 and the RSA signature when present.
   * Files in missing chunk archives are reported as skipped instead of failing.
   */
  verify(): VerifyResult {
    const issues: VerifyResult["issues"] = [];
    const skippedFiles: string[] = [];
    let checkedFiles = 0;

    for (const entry of this.entries.values()) {
      if (entry.archiveIndex !== DIR_ARCHIVE_INDEX && entry.entryLength > 0 && !this.chunkAvailable(entry.archiveIndex)) {
        skippedFiles.push(entry.path);
        continue;
      }

      checkedFiles++;
      try {
        if (crc32(this.readEntry(entry)) !== entry.crc)
          issues.push({ path: entry.path, reason: "CRC32 mismatch" });
      } catch (error) {
        issues.push({ path: entry.path, reason: `read failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    if (this.checksums) {
      if (!md5(this.treeBuffer).equals(this.checksums.treeChecksum))
        issues.push({ path: "<tree>", reason: "tree MD5 mismatch" });

      const md5Start = this.header.headerLength + this.header.treeSize + this.header.fileDataSectionSize;
      const section = this.header.archiveMD5SectionSize > 0 ? this.dir.readAt(md5Start, this.header.archiveMD5SectionSize) : Buffer.alloc(0);
      if (!md5(section).equals(this.checksums.archiveMD5SectionChecksum))
        issues.push({ path: "<archive-md5-section>", reason: "archive MD5 section checksum mismatch" });

      const wholeLength = md5Start + this.header.archiveMD5SectionSize + 32;
      if (!md5(this.dir.readAt(0, wholeLength)).equals(this.checksums.wholeFileChecksum))
        issues.push({ path: "<file>", reason: "whole-file MD5 mismatch" });

      for (const e of this.archiveMD5Entries) {
        if (!this.chunkAvailable(e.archiveIndex))
          continue;

        if (!md5(this.chunk(e.archiveIndex).readAt(e.startingOffset, e.count)).equals(e.md5))
          issues.push({ path: `<archive ${e.archiveIndex}>`, reason: `MD5 mismatch at offset ${e.startingOffset}` });
      }

      if (this.verifySignature() === false)
        issues.push({ path: "<signature>", reason: "RSA signature invalid" });
    }

    return { ok: issues.length === 0, checkedFiles, skippedFiles, issues };
  }

  /** Closes the dir file and any opened chunk archives. */
  close(): void {
    if (this.closed)
      return;

    this.closed = true;
    this.dir.close();
    for (const chunk of this.chunks.values())
      chunk.close();

    this.chunks.clear();
  }

  private chunkAvailable(index: number): boolean {
    return this.chunks.has(index) || this.chunkPathFor(index) !== null;
  }

  private chunk(index: number): DataSource {
    const cached = this.chunks.get(index);
    if (cached)
      return cached;

    const path = this.chunkPathFor(index);
    if (!path)
      throw new Error(`Chunk archive ${index} not available`);

    const source = fileSource(path);
    this.chunks.set(index, source);
    return source;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
