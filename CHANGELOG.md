# Changelog

All notable changes to this project will be documented here.

---

## 1.0.0 - 2026-06-10

Initial release.

- **`VpkReader`** - VPK v1/v2 parsing, single-file and multi-chunk (`_dir.vpk` + `_000.vpk`...) sets, dir-embedded data, preload bytes. Lazy positioned reads: only the header and tree live in memory, so multi-GB archives open instantly. `readFileRange()` for partial reads and `createReadStream()` for streaming without full-file buffering.
- **`VpkWriter`** - pack files or whole folders into v1/v2 archives, single-file or chunked, with correct CRC32 + MD5 sections and deterministic output. Per-file `preload` option keeps small files inline in the tree. `VpkWriter.from(reader)` seeds a writer from an existing archive for add/remove/replace edits.
- **`AsyncVpkReader`** - promise-based twin of `VpkReader` with the same API, for servers that can't block on disk I/O. `writer.writeAsync()` included.
- **RSA signing** - `write(..., { sign: { privateKey } })` signs archives the way vpk.exe does (PKCS#1 v1.5 + SHA-256, DER SPKI key embedded), `reader.verifySignature()` checks embedded or external keys. Both legacy and CS2 marker signature sections are parsed.
- **Chunk alignment** - `write(..., { align })` zero-pads file starts to a boundary inside archives, like vpk.exe's `-a`.
- **`diffVpks()`** - compare two archives by their directory trees (CRC + size), instant even on 131k-file paks. See exactly what a game update touched.
- **`verify()`** - per-file CRC32 plus Valve's embedded v2 checksums (tree MD5, archive MD5 section, whole-file MD5). Missing chunk archives are reported as skipped, not failed.
- **CLI** - `list`, `extract`, `cat`, `create`, `add`, `remove`, `diff`, `verify`, `info`. Wildcard/regex/filename filters with invert, flat extraction with `--no-dirs`.
- **Integration test suite** - validated against a real CS2 `pak01_dir.vpk` (131k+ files) pulled from Steam, using Valve's own checksums as ground truth. `bun run fetch-fixtures` grabs the dir file plus the smallest chunk archive.
