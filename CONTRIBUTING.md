# Contributing

Hey, thanks for wanting to contribute! Here's what you need to know.

## Setup

```bash
git clone https://github.com/K4ryuu/vpk-ts.git
cd vpk-tools
bun install   # or pnpm/npm, whatever you prefer
```

## Running tests

```bash
bun test                 # unit tests + spec fixtures + roundtrips
bun run fetch-fixtures   # optional: pulls a real CS2 VPK from Steam for integration tests
bun test                 # integration tests now run too
```

The fixture download uses DepotDownloader with anonymous Steam login - no account needed. It grabs `pak01_dir.vpk` (~7 MB) and the smallest chunk archive (~60 MB) into `test/fixtures/real/`. Want a specific chunk? `bun run fetch-fixtures 39`.

## Code style & formatting

Formatting is handled by ESLint (`@stylistic`), there is no separate formatter. The style is clang-inspired: braces only where the body needs them, single-statement bodies on their own line, a blank line after control blocks.

**You don't have to format anything by hand.** In VS Code the repo ships `.vscode/settings.json` which runs the ESLint fix on every save - just install the recommended ESLint extension when the editor offers it and save like you normally would. Style issues show up as warnings, not errors, and disappear on save.

No VS Code? Run it manually before committing:

```bash
bun run lint:fix
```

## Making changes

- **Bugs** - open an issue first so we can confirm it's actually a bug
- **Features** - open an issue to discuss before spending time on it
- **Format details** - if you touch the binary layout, back it with the [VPK spec](https://developer.valvesoftware.com/wiki/VPK_(file_format)) and add a hand-crafted byte fixture to `test/spec-fixture.test.ts`. Roundtrip tests alone can't catch a reader and writer that agree on the wrong format.

## CI

Every push and PR runs lint (zero warnings allowed), type-check, the test suite and a build via GitHub Actions. The Steam fixture tests skip automatically in CI, so it stays fast. A PR needs a green check to get merged - run the same gate locally first:

```bash
bun run type-check && bun run lint && bun test
```
