<a name="readme-top"></a>

<!-- BADGES -->
<div align="center">

![CI](https://img.shields.io/github/actions/workflow/status/K4ryuu/vpk-tools/ci.yml?style=for-the-badge&label=CI)
![NPM Version](https://img.shields.io/npm/v/vpk-tools?style=for-the-badge&label=NPM)
![NPM Downloads](https://img.shields.io/npm/dm/vpk-tools?style=for-the-badge&label=Downloads)
![GitHub License](https://img.shields.io/github/license/K4ryuu/vpk-tools?style=for-the-badge)
![GitHub Issues](https://img.shields.io/github/issues/K4ryuu/vpk-tools?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Bundle Size](https://img.shields.io/bundlephobia/minzip/vpk-tools?style=for-the-badge&label=Bundle%20Size)

</div>

<!-- PROJECT TITLE -->
<br />
<div align="center">
  <h1 align="center">vpk-tools</h1>
  <p align="center">
    Valve VPK archive reader & writer for Node.js and Bun
    <br />
    <strong>Zero runtime dependencies • Full v1/v2 support • CRC32 + MD5 verification • Multi-chunk archives • CLI included</strong>
    <br />
    <br />
    <a href="#installation"><strong>Get Started »</strong></a>
    ·
    <a href="https://github.com/K4ryuu/vpk-tools/tree/main/examples">View Examples</a>
  </p>
</div>

## About The Project

I run and build tooling for CS2 servers, and kept needing to peek into or repack VPK archives from JavaScript - asset syncing, content validation, build pipelines. The existing options are either dead Python ports or libraries that only read v1. So here's a modern one.

`vpk-tools` reads and writes Valve Pak (VPK) archives used by Source and Source 2 games - CS2, Dota 2, TF2, HL:Alyx, Portal 2 and friends. It runs on Node.js and Bun with no runtime dependencies.

## Why this package is special

- **Zero runtime dependencies** - All dependencies are strictly for development. Check the `package.json` for yourself.
- **Full format coverage** - VPK v1 and v2, single-file and multi-chunk (`pak01_dir.vpk` + `pak01_000.vpk`...) sets, dir-embedded data, preload bytes.
- **Real verification** - Per-file CRC32, and for v2 the tree MD5, archive MD5 section and whole-file MD5 that Valve embeds in the archive. `verify()` checks everything that's checkable.
- **Memory-aware reading** - Only the header and directory tree are loaded; file data is read on demand with positioned reads. A multi-GB `pak01_dir.vpk` opens instantly. Range reads and streams included, so you can serve a 30 MB sound file without buffering it.
- **Writer with chunking** - Pack a folder into a single VPK or split it into numbered chunk archives with correct v2 checksums, preload bytes, byte-for-byte deterministic output.
- **Edit & diff** - Open an existing archive, add/remove/replace files, write it back. Diff two archives by CRC to see exactly what a game update touched - directory trees only, no data reads, instant even on 131k files.
- **RSA signing** - Sign archives with your own key and verify signatures, same layout and algorithm as Valve's vpk.exe (PKCS#1 v1.5 + SHA-256, DER SPKI key embedded). Reads both the legacy and the newer CS2 marker section.
- **Sync and async** - `VpkReader` for scripts and CLIs, `AsyncVpkReader` with the exact same API in promises for servers that can't block the event loop.
- **Tested against the real thing** - The test suite validates against an actual CS2 `pak01_dir.vpk` pulled from Steam, using Valve's own embedded checksums as ground truth.

## Installation

```bash
# bun
bun add vpk-tools

# npm
npm install vpk-tools
```

## Usage

### Reading

```ts
import { VpkReader } from "vpk-tools";

const vpk = VpkReader.open("game/csgo/pak01_dir.vpk");

console.log(vpk.fileCount);
console.log(vpk.files().filter((p) => p.startsWith("scripts/")));

const data = vpk.readFile("scripts/items/items_game.txt");

// partial reads and streaming - no full-file buffering
const header = vpk.readFileRange("sounds/music/menu.vsnd_c", 0, 64);
vpk.createReadStream("sounds/music/menu.vsnd_c").pipe(response);

// integrity check: per-file CRC32 + Valve's embedded MD5s (v2)
const result = vpk.verify();
console.log(result.ok, result.issues);

vpk.close();
```

### Writing

```ts
import { readFileSync } from "fs";
import { VpkWriter } from "vpk-tools";

const writer = new VpkWriter(); // v2 by default
writer.addFile("scripts/readme.txt", "hello");
writer.addFile("cfg/tiny.cfg", config, { preload: true }); // keep small files in the tree
writer.addDirectory("./my-addon-content");

// single file, everything embedded
writer.write("myaddon.vpk");

// or split into 100 MB chunks: myaddon_dir.vpk + myaddon_000.vpk + ...
writer.write("myaddon_dir.vpk", { chunkSize: 100 * 1024 * 1024 });

// or keep it in memory
const buffer = writer.toBuffer();

// align file starts (vpk.exe -a style) and sign with your RSA key
writer.write("myaddon_dir.vpk", {
  chunkSize: 100 * 1024 * 1024,
  align: 4096,
  sign: { privateKey: readFileSync("private.pem", "utf8") },
});
```

### Async

```ts
import { AsyncVpkReader } from "vpk-tools";

// same API as VpkReader, but every data read is a promise
const vpk = await AsyncVpkReader.open("pak01_dir.vpk");
const data = await vpk.readFile("scripts/items/items_game.txt");
vpk.createReadStream("sounds/music/menu.vsnd_c").pipe(response);
await vpk.close();
```

### Editing & diffing

```ts
import { VpkReader, VpkWriter, diffVpks } from "vpk-tools";

// edit: seed a writer from an existing archive, tweak, write back
const source = VpkReader.open("mymod.vpk");
const writer = VpkWriter.from(source);
writer.addFile("scripts/new.txt", "added");
writer.removeFile("maps/old.bin");
writer.write("mymod.vpk"); // close source after build if writing elsewhere

// diff: what did the game update change? (tree-only, instant)
const diff = diffVpks(VpkReader.open("old/pak01_dir.vpk"), VpkReader.open("new/pak01_dir.vpk"));
console.log(diff.added, diff.removed, diff.changed);
```

### In-memory archives

```ts
import { VpkReader, VpkWriter } from "vpk-tools";

const buffer = new VpkWriter().addFile("a.txt", "alpha").toBuffer();
const vpk = VpkReader.fromBuffer(buffer);
```

## CLI

```bash
vpk-tools list pak01_dir.vpk -f "scripts/*" --detail
vpk-tools extract pak01_dir.vpk --re "\.(vsnd|vtex)_c$" -o ./out
vpk-tools extract pak01_dir.vpk --name "*.cfg" --no-dirs -o ./flat
vpk-tools cat pak01_dir.vpk scripts/items/items_game.txt | less
vpk-tools create ./mymod -o mymod_dir.vpk --chunk-size 100 --align 4096 --sign private.pem
vpk-tools add mymod.vpk newmap.bin --prefix maps/
vpk-tools remove mymod.vpk maps/old.bin
vpk-tools diff old/pak01_dir.vpk new/pak01_dir.vpk --detail
vpk-tools verify pak01_dir.vpk
vpk-tools info pak01_dir.vpk
```

Filters: `-f` wildcard (or plain substring), `--re` regex, `--name` filename wildcard, `-v` inverts.

## API

| Member | Description |
|---|---|
| `VpkReader.open(path)` | Open a VPK from disk; resolves chunk archives next to a `_dir.vpk` |
| `VpkReader.fromBuffer(buf, chunks?)` | Open a VPK from memory |
| `reader.files()` / `reader.fileCount` | List archive contents |
| `reader.get(path)` / `reader.has(path)` | Directory entry lookup (CRC, sizes, archive index) |
| `reader.readFile(path)` | Full file content (preload + archive part) |
| `reader.readFileRange(path, start, length?)` | Partial read, clamped to the file |
| `reader.createReadStream(path, { start?, end? })` | Node `Readable`, `fs.createReadStream` semantics |
| `reader.available(path)` | Is the file's chunk archive on disk, can it be read right now |
| `reader.verifyFile(path)` / `reader.verify()` | CRC32 / full integrity validation incl. signature |
| `reader.verifySignature(publicKey?)` | RSA signature check, embedded or external key |
| `reader.checksums` / `reader.archiveMD5Entries` / `reader.signature` | Raw v2 MD5 + signature sections |
| `AsyncVpkReader.open(path)` | Promise-based twin of `VpkReader`, same API |
| `new VpkWriter({ version? })` | Create a writer (v2 default) |
| `VpkWriter.from(reader)` | Seed a writer from an existing archive for editing |
| `writer.addFile(path, data, { preload? })` / `writer.addDirectory(dir)` | Queue content |
| `writer.removeFile(path)` / `writer.has(path)` / `writer.paths()` | Manage queued entries |
| `writer.write(target, { chunkSize?, align?, sign? })` / `writer.writeAsync(...)` / `writer.toBuffer()` | Produce the archive |
| `diffVpks(oldReader, newReader)` | Added/removed/changed files between two archives |
| `crc32(buffer, seed?)` | The CRC32 implementation used for entries |

All types (`VpkEntry`, `VpkHeader`, `VerifyResult`, ...) are exported.

## Examples

Runnable from the repo root, no setup needed:

```bash
bun run examples/inspect.ts <archive_dir.vpk>   # stats + integrity check on any VPK
bun run examples/stream.ts <archive_dir.vpk>    # HTTP server streaming files out of a VPK, Range support
bun run examples/read-text.ts <archive_dir.vpk> [path]  # list + dump text files (configs, scripts)
bun run examples/edit-diff.ts                   # edit an archive and diff it, self-contained
bun run examples/sign.ts                        # sign + verify + tamper demo with a throwaway key
```

## Testing

```bash
bun test                 # unit tests, hand-crafted spec fixtures, roundtrips
bun run fetch-fixtures   # pulls a real CS2 pak01_dir.vpk + its smallest chunk from Steam (anonymous)
bun run fetch-fixtures 39  # optional: grab a specific chunk archive by index too
bun test                 # now also runs integration tests against the real archive
```

The integration suite uses Valve's own embedded checksums (tree MD5, whole-file MD5, per-file CRC32) as ground truth - if the parser misreads a single byte of a 131k-file archive, those checks fail. There's also a hand-crafted byte-level spec fixture, so the reader and writer can't silently agree on a wrong format.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

MIT - see [LICENSE](LICENSE).
