#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { diffVpks, VpkReader, VpkWriter } from "./index.js";
import type { WriteOptions } from "./index.js";

function getPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../package.json", "../../package.json"]) {
      const path = join(__dirname, rel);
      if (existsSync(path))
        return JSON.parse(readFileSync(path, "utf8")).version || "1.0.0";
    }
  } catch {}

  return "1.0.0";
}

function printHelp(): void {
  console.log(`
\x1b[36mvpk-ts CLI\x1b[0m - Valve VPK archive reader/writer

\x1b[1mUsage:\x1b[0m
  vpk-ts list <archive_dir.vpk> [filters] [--detail]
  vpk-ts extract <archive_dir.vpk> [filters] [-o <dir>] [--no-dirs]
  vpk-ts cat <archive_dir.vpk> <path...>
  vpk-ts create <inputDir> -o <output.vpk> [--version 1|2] [--chunk-size <MB>] [--align <bytes>] [--sign <key.pem>]
  vpk-ts add <archive.vpk> <file...> [--prefix <dir/>] [--chunk-size <MB>]
  vpk-ts remove <archive.vpk> <path...> [--chunk-size <MB>]
  vpk-ts diff <old_dir.vpk> <new_dir.vpk> [--detail]
  vpk-ts verify <archive_dir.vpk>
  vpk-ts info <archive_dir.vpk>

\x1b[1mFilters:\x1b[0m
  -f, --filter <pattern>  Wildcard on the full path (* and ?), plain text matches as substring
  --re <regex>            Regular expression on the full path
  --name <pattern>        Wildcard on the filename only
  -v, --invert            Invert the filter match

\x1b[1mOptions:\x1b[0m
  -o, --output <path>    Output directory (extract) or output VPK path (create)
  --no-dirs              Extract flat, without recreating directories
  --detail               Show size, CRC and archive index per file
  --prefix <dir/>        Archive path prefix for added files
  --version <1|2>        VPK version to create (default: 2)
  --chunk-size <MB>      Split data into numbered chunk archives of ~MB megabytes
  --align <bytes>        Align file starts within archives to this many bytes
  --sign <key.pem>       Sign the archive with an RSA private key (v2 only)
  -h, --help             Show this help menu

\x1b[1mExamples:\x1b[0m
  vpk-ts list pak01_dir.vpk -f "scripts/*" --detail
  vpk-ts extract pak01_dir.vpk --re "\\.(vsnd|vtex)_c$" -o ./out
  vpk-ts cat pak01_dir.vpk scripts/items/items_game.txt | less
  vpk-ts add mymod.vpk newmap.bin --prefix maps/
  vpk-ts diff old/pak01_dir.vpk new/pak01_dir.vpk --detail
`);
}

function fail(message: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;

  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valueFlags = new Set(["-o", "--output", "-f", "--filter", "--re", "--name", "--prefix", "--version", "--chunk-size", "--align", "--sign"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined)
        fail(`Missing value for ${arg}`);

      flags.set(arg, value);
    } else {
      flags.set(arg, true);
    }
  }

  return { positional, flags };
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Builds a path predicate from -f / --re / --name / -v flags. */
function buildMatcher(flags: ParsedArgs["flags"]): (path: string) => boolean {
  const filter = flags.get("-f") ?? flags.get("--filter");
  const regex = flags.get("--re");
  const name = flags.get("--name");
  const invert = flags.has("-v") || flags.has("--invert");

  let match: (path: string) => boolean = () => true;
  if (typeof regex === "string") {
    const re = new RegExp(regex);
    match = (path) => re.test(path);
  } else if (typeof name === "string") {
    const re = wildcardToRegex(name);
    match = (path) => re.test(basename(path));
  } else if (typeof filter === "string") {
    if (filter.includes("*") || filter.includes("?")) {
      const re = wildcardToRegex(filter);
      match = (path) => re.test(path);
    } else {
      match = (path) => path.includes(filter);
    }
  }

  return invert ? (path) => !match(path) : match;
}

function openOrFail(path: string | undefined): VpkReader {
  if (!path)
    fail("Missing VPK path");

  if (!existsSync(path))
    fail(`File not found: ${path}`);

  try {
    return VpkReader.open(path);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function cmdList(args: ParsedArgs): void {
  const vpk = openOrFail(args.positional[0]);
  const matches = buildMatcher(args.flags);
  const detail = args.flags.has("--detail");
  let count = 0;
  for (const path of vpk.files().sort()) {
    if (!matches(path))
      continue;

    count++;
    if (!detail) {
      console.log(path);
      continue;
    }

    const entry = vpk.get(path)!;
    const where = entry.archiveIndex === 0x7fff ? "dir" : String(entry.archiveIndex).padStart(3, "0");
    const missing = vpk.available(path) ? "" : "  \x1b[31m(chunk missing)\x1b[0m";
    console.log(`${formatBytes(entry.totalLength).padStart(10)}  crc=${entry.crc.toString(16).padStart(8, "0")}  [${where}]  ${path}${missing}`);
  }

  console.error(`\n${count} files`);
  vpk.close();
}

function cmdExtract(args: ParsedArgs): void {
  const vpk = openOrFail(args.positional[0]);
  const matches = buildMatcher(args.flags);
  const outDir = String(args.flags.get("-o") ?? args.flags.get("--output") ?? ".");
  const flat = args.flags.has("--no-dirs");
  let count = 0;
  for (const path of vpk.files()) {
    if (!matches(path))
      continue;

    const target = join(outDir, flat ? basename(path) : path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, vpk.readFile(path));
    count++;
  }

  console.log(`Extracted ${count} files to ${outDir}`);
  vpk.close();
}

function cmdCat(args: ParsedArgs): void {
  const vpk = openOrFail(args.positional[0]);
  const paths = args.positional.slice(1);
  if (paths.length === 0)
    fail("Missing file path(s) to cat");

  for (const path of paths) {
    if (!vpk.has(path))
      fail(`File not found in VPK: ${path}`);

    process.stdout.write(vpk.readFile(path));
  }

  vpk.close();
}

function cmdCreate(args: ParsedArgs): void {
  const inputDir = args.positional[0];
  if (!inputDir)
    fail("Missing input directory");

  const output = args.flags.get("-o") ?? args.flags.get("--output");
  if (typeof output !== "string")
    fail("Missing -o <output.vpk>");

  const version = Number(args.flags.get("--version") ?? 2);
  if (version !== 1 && version !== 2)
    fail("--version must be 1 or 2");

  const writer = new VpkWriter({ version });
  writer.addDirectory(inputDir);
  const written = writer.write(output, buildOptions(args));
  console.log(`Packed ${writer.fileCount} files:`);
  for (const file of written)
    console.log(`  ${file}`);
}

function cmdAdd(args: ParsedArgs): void {
  const [archive, ...files] = args.positional;
  if (files.length === 0)
    fail("Missing file(s) to add");

  const prefix = String(args.flags.get("--prefix") ?? "");
  const vpk = openOrFail(archive);
  const writer = VpkWriter.from(vpk);
  for (const file of files) {
    if (!existsSync(file))
      fail(`File not found: ${file}`);

    writer.addFile(prefix + basename(file), readFileSync(file));
  }

  rewrite(vpk, writer, archive!, args);
  console.log(`Added ${files.length} files, archive now has ${writer.fileCount}`);
}

function cmdRemove(args: ParsedArgs): void {
  const [archive, ...paths] = args.positional;
  if (paths.length === 0)
    fail("Missing path(s) to remove");

  const vpk = openOrFail(archive);
  const writer = VpkWriter.from(vpk);
  for (const path of paths) {
    if (!writer.removeFile(path))
      fail(`File not found in VPK: ${path}`);
  }

  rewrite(vpk, writer, archive!, args);
  console.log(`Removed ${paths.length} files, archive now has ${writer.fileCount}`);
}

/** add/remove rebuild the archive in memory, then swap it on disk. */
function rewrite(vpk: VpkReader, writer: VpkWriter, archive: string, args: ParsedArgs): void {
  const options = buildOptions(args);
  if (options.chunkSize === undefined) {
    if (archive.toLowerCase().endsWith("_dir.vpk"))
      fail("Editing a chunked archive rewrites it - pass --chunk-size <MB> to keep it chunked");

    const buffer = writer.toBuffer();
    vpk.close();
    writeFileSync(archive, buffer);
    return;
  }

  // chunked: build under a temp base while the source is still open, then swap
  const finalBase = archive.slice(0, -"_dir.vpk".length);
  const tmpBase = `${finalBase}.tmp`;
  const written = writer.write(`${tmpBase}_dir.vpk`, options);
  vpk.close();
  const replaced = new Set<string>();
  for (const file of written) {
    const final = finalBase + file.slice(tmpBase.length);
    renameSync(file, final);
    replaced.add(final);
  }

  // drop stale chunks the new layout no longer uses
  for (let i = written.length - 1; ; i++) {
    const stale = `${finalBase}_${String(i).padStart(3, "0")}.vpk`;
    if (replaced.has(stale) || !existsSync(stale))
      break;

    rmSync(stale);
  }
}

function cmdDiff(args: ParsedArgs): void {
  const oldVpk = openOrFail(args.positional[0]);
  const newVpk = openOrFail(args.positional[1]);
  const result = diffVpks(oldVpk, newVpk);
  const detail = args.flags.has("--detail");

  if (detail) {
    for (const path of result.added)
      console.log(`\x1b[32m+ ${path}\x1b[0m`);

    for (const path of result.removed)
      console.log(`\x1b[31m- ${path}\x1b[0m`);

    for (const change of result.changed) {
      // same size means the content changed but the byte count didn't (CRC mismatch)
      const sizes = change.oldSize === change.newSize ? `content changed, ${formatBytes(change.newSize)}` : `${formatBytes(change.oldSize)} -> ${formatBytes(change.newSize)}`;
      console.log(`\x1b[33m~ ${change.path}\x1b[0m (${sizes})`);
    }
  }

  console.log(`+${result.added.length} added, -${result.removed.length} removed, ~${result.changed.length} changed, ${result.unchangedCount} unchanged`);
  oldVpk.close();
  newVpk.close();
  if (!detail && (result.added.length || result.removed.length || result.changed.length))
    console.error("(use --detail to list the files)");
}

function cmdVerify(args: ParsedArgs): void {
  const vpk = openOrFail(args.positional[0]);
  const result = vpk.verify();
  console.log(`Checked ${result.checkedFiles} files${result.skippedFiles.length ? `, skipped ${result.skippedFiles.length} (missing chunk archives)` : ""}`);
  const signature = vpk.verifySignature();
  if (signature !== null)
    console.log(`signature: ${signature ? "\x1b[32mvalid\x1b[0m" : "\x1b[31mINVALID\x1b[0m"}`);

  if (result.ok) {
    console.log("\x1b[32mOK\x1b[0m - all checksums valid");
  } else {
    for (const issue of result.issues)
      console.error(`\x1b[31mFAIL\x1b[0m ${issue.path}: ${issue.reason}`);

    process.exit(1);
  }

  vpk.close();
}

function cmdInfo(args: ParsedArgs): void {
  const vpk = openOrFail(args.positional[0]);
  const h = vpk.header;
  console.log(`version:          ${h.version}`);
  console.log(`files:            ${vpk.fileCount}`);
  console.log(`tree size:        ${formatBytes(h.treeSize)}`);
  console.log(`embedded data:    ${formatBytes(h.fileDataSectionSize)}`);
  if (h.version === 2) {
    console.log(`archive md5:      ${vpk.archiveMD5Entries.length} entries`);
    console.log(`signature:        ${vpk.signature ? `${vpk.signature.type} (${h.signatureSectionSize} bytes)` : "none"}`);
    if (vpk.checksums)
      console.log(`tree md5:         ${vpk.checksums.treeChecksum.toString("hex")}`);
  }

  const indexes = new Set<number>();
  for (const path of vpk.files()) {
    const entry = vpk.get(path)!;
    if (entry.archiveIndex !== 0x7fff)
      indexes.add(entry.archiveIndex);
  }

  console.log(`chunk archives:   ${indexes.size}`);
  vpk.close();
}

function buildOptions(args: ParsedArgs): WriteOptions {
  const options: WriteOptions = {};
  const chunkMb = args.flags.get("--chunk-size");
  if (typeof chunkMb === "string") {
    const mb = Number(chunkMb);
    if (!Number.isFinite(mb) || mb <= 0)
      fail("--chunk-size must be a positive number of megabytes");

    options.chunkSize = mb * 1024 * 1024;
  }

  const align = args.flags.get("--align");
  if (typeof align === "string") {
    const bytes = Number(align);
    if (!Number.isInteger(bytes) || bytes <= 0)
      fail("--align must be a positive integer");

    options.align = bytes;
  }

  const keyPath = args.flags.get("--sign");
  if (typeof keyPath === "string") {
    if (!existsSync(keyPath))
      fail(`Key file not found: ${keyPath}`);

    options.sign = { privateKey: readFileSync(keyPath, "utf8") };
  }

  return options;
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
  case "list":
    cmdList(args);
    break;
  case "extract":
    cmdExtract(args);
    break;
  case "cat":
    cmdCat(args);
    break;
  case "create":
    cmdCreate(args);
    break;
  case "add":
    cmdAdd(args);
    break;
  case "remove":
    cmdRemove(args);
    break;
  case "diff":
    cmdDiff(args);
    break;
  case "verify":
    cmdVerify(args);
    break;
  case "info":
    cmdInfo(args);
    break;
  case "-v":
  case "--version":
    console.log(getPackageVersion());
    break;
  default:
    printHelp();
    process.exit(command && command !== "-h" && command !== "--help" ? 1 : 0);
}
