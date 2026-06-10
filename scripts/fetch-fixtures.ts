/**
 * Pulls real CS2 VPK fixtures straight from Steam (anonymous login) into
 * test/fixtures/real/ via DepotDownloader.
 *
 * Two passes: grab pak01_dir.vpk first, then parse it with our own reader to
 * find the smallest chunk archive and grab that too - so CRC tests run against
 * actual game data without downloading 30+ GB.
 *
 * Usage: bun run fetch-fixtures
 */
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "fs";
import { basename, join } from "path";
import { VpkReader, DIR_ARCHIVE_INDEX } from "../src/index.js";

const APP_ID = "730";
const DEPOT_ID = "2347770"; // CS2 shared content depot
const DIR_VPK = "game/csgo/pak01_dir.vpk";

const root = join(import.meta.dir, "..");
const fixtureDir = join(root, "test/fixtures/real");
const binaryPath = join(root, "node_modules/@ianlucas/depot-downloader/dist/DepotDownloader/DepotDownloader");

if (!existsSync(binaryPath)) {
  console.error("DepotDownloader binary not found. Run `bun install` first.");
  process.exit(1);
}

async function download(files: string[]): Promise<void> {
  const filelistPath = join(fixtureDir, ".filelist.txt");
  writeFileSync(filelistPath, files.join("\n"));
  const proc = Bun.spawn([binaryPath, "-app", APP_ID, "-depot", DEPOT_ID, "-filelist", filelistPath, "-dir", fixtureDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  rmSync(filelistPath, { force: true });
  if (exitCode !== 0) {
    console.error(`Download failed (exit ${exitCode})`);
    process.exit(1);
  }

  // DepotDownloader mirrors the depot layout (game/csgo/...), flatten it
  for (const file of files) {
    const nested = join(fixtureDir, file);
    if (existsSync(nested))
      renameSync(nested, join(fixtureDir, basename(file)));
  }

  rmSync(join(fixtureDir, "game"), { recursive: true, force: true });
}

mkdirSync(fixtureDir, { recursive: true });
const dirPath = join(fixtureDir, basename(DIR_VPK));

if (!existsSync(dirPath)) {
  console.log(`Downloading ${DIR_VPK} from depot ${DEPOT_ID}...`);
  await download([DIR_VPK]);
}

// an explicit chunk index wins (bun run fetch-fixtures 39), otherwise grab the smallest
const wanted = process.argv[2] !== undefined ? Number(process.argv[2]) : null;

if (wanted !== null && Number.isInteger(wanted) && wanted >= 0) {
  const chunkFile = DIR_VPK.replace("_dir.vpk", `_${String(wanted).padStart(3, "0")}.vpk`);

  if (!existsSync(join(fixtureDir, basename(chunkFile)))) {
    console.log(`Downloading chunk ${chunkFile}...`);
    await download([chunkFile]);
  }

  rmSync(join(fixtureDir, ".DepotDownloader"), { recursive: true, force: true });
  console.log(`Done. Fixtures in ${fixtureDir}`);
  process.exit(0);
}

// pick the smallest chunk so the CRC integration tests have real data to chew on
const vpk = VpkReader.open(dirPath);
const chunkSizes = new Map<number, number>();
for (const path of vpk.files()) {
  const entry = vpk.get(path)!;
  if (entry.archiveIndex === DIR_ARCHIVE_INDEX || entry.entryLength === 0)
    continue;

  const end = entry.entryOffset + entry.entryLength;
  chunkSizes.set(entry.archiveIndex, Math.max(chunkSizes.get(entry.archiveIndex) ?? 0, end));
}

vpk.close();

const smallest = [...chunkSizes.entries()].sort((a, b) => a[1] - b[1])[0];
if (smallest) {
  const [index, size] = smallest;
  const chunkFile = DIR_VPK.replace("_dir.vpk", `_${String(index).padStart(3, "0")}.vpk`);
  if (!existsSync(join(fixtureDir, basename(chunkFile)))) {
    console.log(`Downloading smallest chunk ${chunkFile} (~${(size / 1024 / 1024).toFixed(1)} MB)...`);
    await download([chunkFile]);
  }
}

rmSync(join(fixtureDir, ".DepotDownloader"), { recursive: true, force: true });
console.log(`Done. Fixtures in ${fixtureDir}`);
