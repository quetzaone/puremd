# Contributing

Thanks for helping keep PureMD small, local, and safe.

## Project Direction

PureMD is a desktop Markdown reader/editor for local files. New features should preserve these defaults:

- no telemetry or analytics
- no accounts, sync, cloud storage, or update pings
- no plugin system
- no network request the reader did not ask for, and none from the WebView: a
  remote image is fetched natively, per document, per URL, after a dialog that
  names the servers, and the approval dies with the tab
- no raw HTML execution
- no broad filesystem access

## Security-Sensitive Areas

Be extra careful with changes to:

- Markdown rendering and sanitization
- link handling and external URL launching
- Tauri commands and capabilities
- file open/save paths
- single-instance startup and file association handling
- dependencies that add networking, scripting, or native execution

## Dependency Overrides

`package.json` pins a floor of `lightningcss@^1.33.0`. Vite 8.1.3 bundles 1.32.0, whose selector
parser does not know `::highlight()` and warns on every build; the search highlights in
`src/styles/app.css` depend on it. 1.33.0 knows it, and the minified CSS is byte-identical either
way, so the override buys a clean build log and nothing else. Drop it once Vite's own range starts
at 1.33.

## Icons

`src-tauri/icons/icon-*.png` come from the design handoff and are the source of truth; `icon.ico` is
only a container built from them:

```sh
node tools/make-ico.mjs src-tauri/icons/icon.ico src-tauri/icons/icon-16.png src-tauri/icons/icon-24.png src-tauri/icons/icon-32.png src-tauri/icons/icon-48.png src-tauri/icons/icon-64.png src-tauri/icons/icon-128.png src-tauri/icons/icon-256.png
```

`app-icon.svg` is the vector of record. Its `.md` wordmark is still live text, so it renders wrong
wherever the named font is missing — convert it to paths before regenerating any raster from it.

**A changed icon does not trigger a rebuild.** The icon is embedded as a Windows resource by
`tauri-build`, and Cargo does not treat `icon.ico` as an input to that build script — so a normal
`tauri build` after an icon change succeeds, reports nothing, and ships the *previous* icon. Force it:

```sh
cargo clean -p puremd --release --manifest-path src-tauri/Cargo.toml
```

Then rebuild and confirm the new bytes actually landed, rather than trusting the build log.

## Verification

Run:

```sh
npm.cmd audit --omit=dev --package-lock-only
npm.cmd run build
cd src-tauri
cargo test --locked
cargo check --locked
```

Before release, also run:

```sh
npm.cmd run tauri -- build
cargo audit
```

Run `cargo audit` from `src-tauri`. It is provided by the separately installed `cargo-audit` tool (for example, `cargo install cargo-audit --locked`).

Then complete the relevant checks in `TESTING.md`. Include reproduction steps and the requested environment details when reporting a bug.
