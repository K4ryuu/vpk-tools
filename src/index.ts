export { VpkReader } from "./reader.js";
export { AsyncVpkReader } from "./async-reader.js";
export { VpkWriter } from "./writer.js";
export { diffVpks } from "./diff.js";
export { crc32 } from "./crc32.js";
export { VPK_SIGNATURE, DIR_ARCHIVE_INDEX, ENTRY_TERMINATOR } from "./types.js";
export type {
  VpkHeader,
  VpkEntry,
  VpkChecksums,
  ArchiveMD5Entry,
  VerifyResult,
  VerifyIssue,
  WriterOptions,
  WriteOptions,
  AddFileOptions,
  ReadStreamOptions,
  VpkDiff,
  VpkDiffChange,
  VpkSignature,
} from "./types.js";
