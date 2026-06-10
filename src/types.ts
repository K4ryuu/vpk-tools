import type { KeyObject } from "crypto";

/** VPK dir file signature (little-endian). */
export const VPK_SIGNATURE = 0x55aa1234;
/** Archive index meaning "data is stored in the _dir.vpk itself". */
export const DIR_ARCHIVE_INDEX = 0x7fff;
/** Entry terminator written after every directory entry. */
export const ENTRY_TERMINATOR = 0xffff;

export interface VpkHeader {
  /** VPK version, 1 or 2. */
  version: 1 | 2;
  /** Size of the directory tree in bytes. */
  treeSize: number;
  /** Total length of the header in bytes (12 for v1, 28 for v2). */
  headerLength: number;
  /** v2 only: size of the file data section embedded in the dir file. */
  fileDataSectionSize: number;
  /** v2 only: size of the archive MD5 checksum section. */
  archiveMD5SectionSize: number;
  /** v2 only: size of the "other MD5" section (always 48). */
  otherMD5SectionSize: number;
  /** v2 only: size of the signature section. */
  signatureSectionSize: number;
}

export interface VpkEntry {
  /** Full normalized path inside the archive, e.g. `materials/wood/door01.vmat`. */
  path: string;
  /** CRC32 of the complete file content (preload + archive part). */
  crc: number;
  /** Number of bytes stored inline in the directory tree. */
  preloadBytes: number;
  /** Archive index the data lives in, or {@link DIR_ARCHIVE_INDEX} for the dir file. */
  archiveIndex: number;
  /** Byte offset of the data within the archive (or the dir file data section). */
  entryOffset: number;
  /** Length of the data stored in the archive (excludes preload bytes). */
  entryLength: number;
  /** Total file size in bytes (`preloadBytes + entryLength`). */
  totalLength: number;
  /** Inline preload data, empty buffer when `preloadBytes` is 0. */
  preloadData: Buffer;
}

/** One entry of the v2 archive MD5 section: an MD5 over a byte range of a chunk archive. */
export interface ArchiveMD5Entry {
  archiveIndex: number;
  startingOffset: number;
  count: number;
  md5: Buffer;
}

/** v2 "other MD5" section checksums stored in the dir file. */
export interface VpkChecksums {
  /** MD5 of the directory tree bytes. */
  treeChecksum: Buffer;
  /** MD5 of the archive MD5 section bytes. */
  archiveMD5SectionChecksum: Buffer;
  /** MD5 of the entire dir file up to (excluding) this checksum. */
  wholeFileChecksum: Buffer;
}

export interface VerifyIssue {
  path: string;
  reason: string;
}

export interface VerifyResult {
  /** True when every performed check passed. */
  ok: boolean;
  /** Number of files whose CRC32 was validated. */
  checkedFiles: number;
  /** Files that were skipped because their chunk archive is missing. */
  skippedFiles: string[];
  /** All failed checks with reasons. */
  issues: VerifyIssue[];
}

export interface WriterOptions {
  /** VPK version to write. @default 2 */
  version?: 1 | 2;
}

export interface AddFileOptions {
  /**
   * Store the first N bytes (or the whole file with `true`) inline in the
   * directory tree as preload data. Source engines use this for small files
   * that should be available without touching the chunk archives.
   * Capped at 65535 bytes by the format.
   */
  preload?: number | true;
}

export interface ReadStreamOptions {
  /** First byte to read. @default 0 */
  start?: number;
  /** Last byte to read, inclusive (like `fs.createReadStream`). @default end of file */
  end?: number;
}

/** One side of a changed file in a {@link VpkDiff}. */
export interface VpkDiffChange {
  path: string;
  oldSize: number;
  newSize: number;
}

export interface VpkDiff {
  /** Paths present only in the new archive. */
  added: string[];
  /** Paths present only in the old archive. */
  removed: string[];
  /** Paths present in both but with different content (CRC32 or size). */
  changed: VpkDiffChange[];
  /** Number of files identical on both sides. */
  unchangedCount: number;
}

export interface WriteOptions {
  /**
   * Split file data into numbered chunk archives (`name_000.vpk`, ...) of roughly
   * this many bytes instead of embedding everything in the dir file.
   * Requires the target path to end with `_dir.vpk`.
   */
  chunkSize?: number;
  /**
   * Align the start of every file to a multiple of this many bytes within its
   * archive (zero-padded), like vpk.exe's `-a`. Speeds up aligned/mmap reads.
   */
  align?: number;
  /**
   * Sign the archive (v2 only) with an RSA private key - PEM string, DER
   * buffer or a Node `KeyObject`. The matching public key is embedded in the
   * signature section, same layout and algorithm Valve's vpk.exe uses
   * (RSA PKCS#1 v1.5 + SHA-256 over everything before the signature section).
   */
  sign?: { privateKey: string | Buffer | KeyObject };
}

/** Parsed v2 signature section. */
export interface VpkSignature {
  /**
   * `fullFile`: RSA over everything before the signature section (legacy vpk.exe).
   * `fileChecksum`: RSA over the 16-byte whole-file MD5 (newer marker format).
   */
  type: "fullFile" | "fileChecksum" | "unknown";
  /** Embedded public key (DER SubjectPublicKeyInfo), null when external. */
  publicKey: Buffer | null;
  signature: Buffer | null;
}
