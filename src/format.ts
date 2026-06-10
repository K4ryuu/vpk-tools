import { ENTRY_TERMINATOR, VPK_SIGNATURE } from "./types.js";
import type { ArchiveMD5Entry, VpkChecksums, VpkEntry, VpkHeader, VpkSignature } from "./types.js";

/** Parses the 12/28 byte header. `head` must hold at least `headerLength` bytes. */
export function parseHeader(head: Buffer, fileSize: number): VpkHeader {
  if (head.length < 12 || head.readUInt32LE(0) !== VPK_SIGNATURE)
    throw new Error("Not a VPK file: bad signature");

  const version = head.readUInt32LE(4);
  if (version !== 1 && version !== 2)
    throw new Error(`Unsupported VPK version: ${version}`);

  const treeSize = head.readUInt32LE(8);
  const headerLength = version === 1 ? 12 : 28;

  if (version === 1) {
    return {
      version,
      treeSize,
      headerLength,
      fileDataSectionSize: fileSize - headerLength - treeSize,
      archiveMD5SectionSize: 0,
      otherMD5SectionSize: 0,
      signatureSectionSize: 0,
    };
  }

  if (head.length < 28)
    throw new Error("Truncated VPK v2 header");

  return {
    version,
    treeSize,
    headerLength,
    fileDataSectionSize: head.readUInt32LE(12),
    archiveMD5SectionSize: head.readUInt32LE(16),
    otherMD5SectionSize: head.readUInt32LE(20),
    signatureSectionSize: head.readUInt32LE(24),
  };
}

/** Walks the ext -> dir -> file tree and returns entries keyed by full path. */
export function parseTree(tree: Buffer): Map<string, VpkEntry> {
  const entries = new Map<string, VpkEntry>();
  let offset = 0;

  const readString = (): string => {
    const end = tree.indexOf(0, offset);
    if (end === -1)
      throw new Error("Malformed VPK tree: unterminated string");

    const str = tree.toString("utf8", offset, end);
    offset = end + 1;
    return str;
  };

  for (;;) {
    const ext = readString();
    if (ext === "")
      break;

    for (;;) {
      const dir = readString();
      if (dir === "")
        break;

      for (;;) {
        const name = readString();
        if (name === "")
          break;

        if (offset + 18 > tree.length)
          throw new Error("Malformed VPK tree: truncated entry");

        const crc = tree.readUInt32LE(offset);
        const preloadBytes = tree.readUInt16LE(offset + 4);
        const archiveIndex = tree.readUInt16LE(offset + 6);
        const entryOffset = tree.readUInt32LE(offset + 8);
        const entryLength = tree.readUInt32LE(offset + 12);
        const terminator = tree.readUInt16LE(offset + 16);
        if (terminator !== ENTRY_TERMINATOR)
          throw new Error(`Malformed VPK tree: bad entry terminator 0x${terminator.toString(16)}`);

        offset += 18;
        if (offset + preloadBytes > tree.length)
          throw new Error("Malformed VPK tree: truncated preload data");

        const preloadData = Buffer.from(tree.subarray(offset, offset + preloadBytes));
        offset += preloadBytes;

        const dirPart = dir === " " ? "" : dir;
        const extPart = ext === " " ? "" : `.${ext}`;
        const path = `${dirPart ? `${dirPart}/` : ""}${name}${extPart}`;
        entries.set(path, {
          path,
          crc,
          preloadBytes,
          archiveIndex,
          entryOffset,
          entryLength,
          totalLength: preloadBytes + entryLength,
          preloadData,
        });
      }
    }
  }

  return entries;
}

/** Splits the v2 archive MD5 section into entries. */
export function parseArchiveMD5Section(raw: Buffer): ArchiveMD5Entry[] {
  const entries: ArchiveMD5Entry[] = [];
  for (let off = 0; off + 28 <= raw.length; off += 28) {
    entries.push({
      archiveIndex: raw.readUInt32LE(off),
      startingOffset: raw.readUInt32LE(off + 4),
      count: raw.readUInt32LE(off + 8),
      md5: Buffer.from(raw.subarray(off + 12, off + 28)),
    });
  }

  return entries;
}

/** Splits the 48-byte "other MD5" section. */
export function parseChecksums(other: Buffer): VpkChecksums {
  return {
    treeChecksum: Buffer.from(other.subarray(0, 16)),
    archiveMD5SectionChecksum: Buffer.from(other.subarray(16, 32)),
    wholeFileChecksum: Buffer.from(other.subarray(32, 48)),
  };
}

/**
 * Parses the v2 signature section. Two layouts exist in the wild:
 * - legacy: u32 keySize + key + u32 sigSize + sig ("fullFile")
 * - marker: MAGIC + u32 type + u32 keySize + u32 sigSize + u32 reserved,
 *   followed by optional key/sig ("fileChecksum" when type is 1)
 */
export function parseSignatureSection(raw: Buffer): VpkSignature | null {
  if (raw.length === 0)
    return null;

  if (raw.length < 4)
    return { type: "unknown", publicKey: null, signature: null };

  const first = raw.readUInt32LE(0);

  if (raw.length >= 20 && first === VPK_SIGNATURE) {
    const type = raw.readUInt32LE(4);
    const keySize = raw.readUInt32LE(8);
    const sigSize = raw.readUInt32LE(12);
    // raw[16..20) is reserved
    let offset = 20;
    const publicKey = keySize > 0 && offset + keySize <= raw.length ? Buffer.from(raw.subarray(offset, offset + keySize)) : null;
    offset += keySize;
    const signature = sigSize > 0 && offset + sigSize <= raw.length ? Buffer.from(raw.subarray(offset, offset + sigSize)) : null;
    return { type: type === 1 ? "fileChecksum" : type === 0 ? "fullFile" : "unknown", publicKey, signature };
  }

  const keySize = first;
  if (8 + keySize > raw.length)
    return { type: "unknown", publicKey: null, signature: null };

  const publicKey = Buffer.from(raw.subarray(4, 4 + keySize));
  const sigSize = raw.readUInt32LE(4 + keySize);
  if (8 + keySize + sigSize > raw.length)
    return { type: "unknown", publicKey, signature: null };

  return { type: "fullFile", publicKey, signature: Buffer.from(raw.subarray(8 + keySize, 8 + keySize + sigSize)) };
}
