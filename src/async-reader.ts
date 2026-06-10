import { open, type FileHandle } from "fs/promises";
import { existsSync } from "fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";
import { Readable } from "stream";
import { crc32 } from "./crc32.js";
import { parseArchiveMD5Section, parseChecksums, parseHeader, parseSignatureSection, parseTree } from "./format.js";
import { DIR_ARCHIVE_INDEX } from "./types.js";
import type { ArchiveMD5Entry, ReadStreamOptions, VerifyResult, VpkChecksums, VpkEntry, VpkHeader, VpkSignature } from "./types.js";

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buf, 0, length, offset);
  if (bytesRead !== length)
    throw new Error(`Short read: wanted ${length} bytes at ${offset}, got ${bytesRead}`);

  return buf;
}

function md5(data: Buffer): Buffer {
  return createHash("md5").update(data).digest();
}

/**
 * Promise-based twin of `VpkReader` for servers and anything else that
 * shouldn't block the event loop on disk I/O. Same parsing, same verify
 * logic, all data reads go through `fs/promises`.
 *
 * @example
 * const vpk = await AsyncVpkReader.open("pak01_dir.vpk");
 * const data = await vpk.readFile("scripts/items/items_game.txt");
 * await vpk.close();
 */
export class AsyncVpkReader {
  readonly header: VpkHeader;
  /** v2 only: checksums from the "other MD5" section. */
  readonly checksums: VpkChecksums | null;
  /** v2 only: parsed archive MD5 section entries. */
  readonly archiveMD5Entries: ArchiveMD5Entry[];
  /** v2 only: parsed signature section, null when the archive is unsigned. */
  readonly signature: VpkSignature | null;

  private readonly entries: Map<string, VpkEntry>;
  private readonly dir: FileHandle;
  private readonly chunkBase: string | null;
  private readonly chunks = new Map<number, FileHandle>();
  private readonly treeBuffer: Buffer;
  private closed = false;

  private constructor(
    dir: FileHandle,
    chunkBase: string | null,
    header: VpkHeader,
    treeBuffer: Buffer,
    archiveMD5Entries: ArchiveMD5Entry[],
    checksums: VpkChecksums | null,
    signature: VpkSignature | null,
  ) {
    this.dir = dir;
    this.chunkBase = chunkBase;
    this.header = header;
    this.treeBuffer = treeBuffer;
    this.entries = parseTree(treeBuffer);
    this.archiveMD5Entries = archiveMD5Entries;
    this.checksums = checksums;
    this.signature = signature;
  }

  /**
   * Opens a VPK from disk. For multi-chunk sets pass the `_dir.vpk` path;
   * chunk archives are resolved automatically next to it.
   */
  static async open(filePath: string): Promise<AsyncVpkReader> {
    const dirSuffix = "_dir.vpk";
    const chunkBase = filePath.toLowerCase().endsWith(dirSuffix) ? filePath.slice(0, -dirSuffix.length) : null;
    const handle = await open(filePath, "r");
    try {
      const size = (await handle.stat()).size;
      const header = parseHeader(await readAt(handle, 0, Math.min(28, size)), size);
      const tree = await readAt(handle, header.headerLength, header.treeSize);

      let archiveMD5Entries: ArchiveMD5Entry[] = [];
      let checksums: VpkChecksums | null = null;
      let signature: VpkSignature | null = null;
      if (header.version === 2) {
        const md5Start = header.headerLength + header.treeSize + header.fileDataSectionSize;
        archiveMD5Entries = parseArchiveMD5Section(
          header.archiveMD5SectionSize > 0 ? await readAt(handle, md5Start, header.archiveMD5SectionSize) : Buffer.alloc(0),
        );
        checksums = header.otherMD5SectionSize >= 48 ? parseChecksums(await readAt(handle, md5Start + header.archiveMD5SectionSize, 48)) : null;
        const sigStart = md5Start + header.archiveMD5SectionSize + header.otherMD5SectionSize;
        signature = header.signatureSectionSize > 0 ? parseSignatureSection(await readAt(handle, sigStart, header.signatureSectionSize)) : null;
      }

      return new AsyncVpkReader(handle, chunkBase, header, tree, archiveMD5Entries, checksums, signature);
    } catch (error) {
      await handle.close();

      // chunk archives are raw data without a header, a common mixup
      if (/_\d{3}\.vpk$/i.test(filePath) && error instanceof Error && error.message.includes("bad signature"))
        throw new Error(`"${filePath}" is a chunk archive (raw file data, no header) - open the matching _dir.vpk instead`);

      throw error;
    }
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
  async readFile(path: string): Promise<Buffer> {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return this.readEntry(entry);
  }

  /** Reads the complete content of a directory entry. */
  async readEntry(entry: VpkEntry): Promise<Buffer> {
    if (entry.entryLength === 0)
      return entry.preloadData;

    let data: Buffer;
    if (entry.archiveIndex === DIR_ARCHIVE_INDEX) {
      const dataStart = this.header.headerLength + this.header.treeSize;
      data = await readAt(this.dir, dataStart + entry.entryOffset, entry.entryLength);
    } else {
      data = await readAt(await this.chunk(entry.archiveIndex), entry.entryOffset, entry.entryLength);
    }

    return entry.preloadBytes > 0 ? Buffer.concat([entry.preloadData, data]) : data;
  }

  /**
   * Reads a byte range of a file without loading the rest. The range can
   * span the preload/archive boundary.
   */
  async readFileRange(path: string, start: number, length?: number): Promise<Buffer> {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return this.readEntryRange(entry, start, length);
  }

  /** Range read on a directory entry, see {@link readFileRange}. */
  async readEntryRange(entry: VpkEntry, start: number, length?: number): Promise<Buffer> {
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
      const inDir = entry.archiveIndex === DIR_ARCHIVE_INDEX;
      const handle = inDir ? this.dir : await this.chunk(entry.archiveIndex);
      const base = inDir ? this.header.headerLength + this.header.treeSize : 0;
      parts.push(await readAt(handle, base + entry.entryOffset + archiveFrom, archiveLength));
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
        if (position > end) {
          this.push(null);
          return;
        }

        readEntryRange(entry, position, Math.min(CHUNK, end - position + 1))
          .then((data) => {
            position += data.length;
            this.push(data.length > 0 ? data : null);
          })
          .catch((error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))));
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
  async verifyFile(path: string): Promise<boolean> {
    const entry = this.get(path);
    if (!entry)
      throw new Error(`File not found in VPK: "${path}"`);

    return crc32(await this.readEntry(entry)) === entry.crc;
  }

  /**
   * Checks the RSA signature (v2). Pass a public key (PEM/DER) to verify
   * against an external key instead of the embedded one. Returns null when
   * there's no signature (or no key) to check.
   */
  async verifySignature(publicKey?: string | Buffer): Promise<boolean | null> {
    if (!this.signature?.signature)
      return null;

    const keyInput = publicKey ?? this.signature.publicKey;
    if (!keyInput)
      return null;

    // PEM as string, DER SPKI as buffer (the embedded key is always DER)
    const key = typeof keyInput === "string" ? createPublicKey(keyInput) : createPublicKey({ key: keyInput, format: "der", type: "spki" });

    const md5Start = this.header.headerLength + this.header.treeSize + this.header.fileDataSectionSize;
    const beforeSignature = md5Start + this.header.archiveMD5SectionSize + this.header.otherMD5SectionSize;
    const signed = this.signature.type === "fileChecksum" ? this.checksums?.wholeFileChecksum : await readAt(this.dir, 0, beforeSignature);
    if (!signed)
      return null;

    return cryptoVerify("sha256", signed, key, this.signature.signature);
  }

  /**
   * Validates the whole archive: per-file CRC32, and for v2 the tree MD5,
   * archive MD5 section, whole-file MD5 and the RSA signature when present.
   * Files in missing chunk archives are reported as skipped instead of failing.
   */
  async verify(): Promise<VerifyResult> {
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
        if (crc32(await this.readEntry(entry)) !== entry.crc)
          issues.push({ path: entry.path, reason: "CRC32 mismatch" });
      } catch (error) {
        issues.push({ path: entry.path, reason: `read failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    if (this.checksums) {
      if (!md5(this.treeBuffer).equals(this.checksums.treeChecksum))
        issues.push({ path: "<tree>", reason: "tree MD5 mismatch" });

      const md5Start = this.header.headerLength + this.header.treeSize + this.header.fileDataSectionSize;
      const section = this.header.archiveMD5SectionSize > 0 ? await readAt(this.dir, md5Start, this.header.archiveMD5SectionSize) : Buffer.alloc(0);
      if (!md5(section).equals(this.checksums.archiveMD5SectionChecksum))
        issues.push({ path: "<archive-md5-section>", reason: "archive MD5 section checksum mismatch" });

      const wholeLength = md5Start + this.header.archiveMD5SectionSize + 32;
      if (!md5(await readAt(this.dir, 0, wholeLength)).equals(this.checksums.wholeFileChecksum))
        issues.push({ path: "<file>", reason: "whole-file MD5 mismatch" });

      for (const e of this.archiveMD5Entries) {
        if (!this.chunkAvailable(e.archiveIndex))
          continue;

        if (!md5(await readAt(await this.chunk(e.archiveIndex), e.startingOffset, e.count)).equals(e.md5))
          issues.push({ path: `<archive ${e.archiveIndex}>`, reason: `MD5 mismatch at offset ${e.startingOffset}` });
      }

      if ((await this.verifySignature()) === false)
        issues.push({ path: "<signature>", reason: "RSA signature invalid" });
    }

    return { ok: issues.length === 0, checkedFiles, skippedFiles, issues };
  }

  /** Closes the dir file and any opened chunk archives. */
  async close(): Promise<void> {
    if (this.closed)
      return;

    this.closed = true;
    await this.dir.close();
    await Promise.all([...this.chunks.values()].map((handle) => handle.close()));
    this.chunks.clear();
  }

  private chunkPath(index: number): string | null {
    if (this.chunkBase === null)
      return null;

    const path = `${this.chunkBase}_${String(index).padStart(3, "0")}.vpk`;
    return existsSync(path) ? path : null;
  }

  private chunkAvailable(index: number): boolean {
    return this.chunks.has(index) || this.chunkPath(index) !== null;
  }

  private async chunk(index: number): Promise<FileHandle> {
    const cached = this.chunks.get(index);
    if (cached)
      return cached;

    const path = this.chunkPath(index);
    if (!path)
      throw new Error(`Chunk archive ${index} not available`);

    const handle = await open(path, "r");
    this.chunks.set(index, handle);
    return handle;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
