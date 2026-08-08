# Changelog

All notable changes to PureMD are documented in this file.

Versions follow semantic versioning and are bumped with `npm version <patch|minor|major>`, which is the
only place a version number is edited; see `PUBLISHING.md`.

## [1.1.0] - 2026-08-08

### Added

- A setup window of its own. The download is `PureMD-Setup.exe`: a small WebView2 window that names the install path, the space required and the space free, links the license, and then runs the installer. The NSIS installer it runs is compiled into it as a payload, so nothing is fetched — the bytes that install the application are the bytes that were downloaded and hashed.
- A portable download. `PureMD-<version>-portable-x64.zip` holds `puremd.exe` and the JetBrains Mono license, and needs no installation. It registers nothing, so there are no file associations and no Start menu entry, and it is not traceless: like any WebView2 application it keeps its session and settings under `%LOCALAPPDATA%`.
- `npm run build:installer` produces both downloads into `release/`, including the font license the portable zip has to carry — a loose executable would otherwise ship the font without the notice OFL 1.1 requires.

## [1.0.1] - 2026-08-08

### Fixed

- CI had never run. `actions/setup-node` was pinned to a commit that does not exist in that repository, so every run failed during **Set up job**, before checkout — including the run on the 1.0.0 release commit. Nothing the workflow claims to assert had ever executed: not `npm run check`, not the build, not `cargo test`, not `cargo audit`. The pin is now the real v4.0.4 commit.
- The JetBrains Mono license text did not ship with the binaries, although `THIRD_PARTY_NOTICES.md` said it must. The four `.woff2` files were bundled and the OFL 1.1 notice was not, which the license requires wherever the font is redistributed. `tauri.conf.json` now declares it as a bundle resource, so the installer places it beside the executable as `JetBrainsMono-OFL.txt`.
- `THIRD_PARTY_NOTICES.md` omitted three direct dependencies: `rehype-raw`, `percent-encoding`, and `imagesize`. `rehype-raw` is the one `THREAT_MODEL.md` discusses most, so its absence from the inventory was the worst of the three. Development dependencies are now marked consistently.
- The README key table did not mention `F3` and `Ctrl+G`, which step through search matches with `Shift` reversing.
- The bug report template offered a portable-exe install type that is not published; only the NSIS installer and development builds exist.
- `.gitattributes` now names `*.gif` and `*.woff2` as binary. `text=auto` already detected both, so nothing was corrupted; the list was merely incomplete.
- `SECURITY.md` names a real reporting channel. GitHub private vulnerability reporting is enabled on the repository, so a report no longer has to be routed through the maintainer's profile.
- `npm version` left `src-tauri/Cargo.lock` behind. `sync-version.mjs` moved the version in `Cargo.toml` only, and Cargo refuses to run with `--locked` when the two disagree — so the first release cut with a working CI would have failed `cargo test --locked` and `cargo check --locked` on the version commit itself. The script now moves the crate's own entry in the lockfile as well, and the `version` lifecycle script stages it.

### Security

- `postcss` and `nanoid`, reached only through Vite at build time, moved to versions without the advisories `npm audit` reported. Neither is part of the shipped bundle.

## [1.0.0] - 2026-08-07

### Added

- Initial Windows release of a local Markdown viewer and editor.
- Support for `.md`, `.markdown`, and `.mdx` files, with GitHub Flavored Markdown rendering.
- Native file dialogs, Windows file associations for `.md` and `.markdown`, and single-instance open-file handoff.
- Conservative rendering controls: raw HTML is disabled, images are placeholders, and external `http`/`https` links require confirmation.
- Native warning-only preflight for unusual Markdown constructs, including code-aware handling of inline and fenced code examples.
- Explicit per-tab Extended mode: relative PNG, JPEG, GIF, and WebP images from the document directory, `data:` base64 images embedded in the document, and the inert HTML tags `details`, `summary`, `kbd`, `mark`, `sub`, and `sup`.
- One extra image folder per document, authorized through a native dialog, shown in the sidebar and revocable there. The grant is dropped when the tab closes, when Extended mode is switched off, and when the application exits.
- Lightbox on rendered images: contained in the window, never upscaled, closed by a click anywhere, the close button, or `Esc`.
- A skeleton with the host named while a remote image is in flight, so the wait is not blank.
- Image placeholders that name the reason: blocked in Safe mode, remote, missing, outside the document folder, unsupported format, too large, or past the per-document limit.
- Remote images on request, in Extended mode: a **Load N images** button in the toolbar for the whole document and a button on each placeholder for one image, both behind a dialog that names the count and every server first. Approvals are listed in the sidebar with a revoke action.
- Redesigned application shell: custom titlebar with window controls and document tabs, a centred document card with a toolbar carrying Preview/Code modes, word count, and the security chip, plus a new home screen.
- Outline sidebar in Preview and a Markdown guide sidebar in Code, sharing one toolbar toggle.
- Floating minimap with a legible text map for short documents, a density map for long ones, a viewport indicator, search-hit ticks, drag-to-scrub, and an adjustable resting opacity.
- Find bar that highlights matches with the CSS Custom Highlight API, leaving the rendered document and its source untouched.
- Command palette on `Ctrl+K` and a `Ctrl+M` shortcut for the minimap.
- Spanish interface language alongside English and Russian, and a setting for restoring tabs on launch.
- JetBrains Mono bundled locally (SIL Open Font License 1.1) so the interface font needs no network access.

### Fixed

- External `http` and `https` links open again. The blocked-scheme list ended with a catch-all pattern that matched every scheme, `https:` included, so the confirmation dialog this project documents was never reachable and every external link was refused. `npm run check` now asserts both directions.

- Window geometry is no longer saved while the window is minimized. Windows reports a minimized window at `-32000, -32000`, and restoring that put the window off every screen — a taskbar entry with nothing to show, indistinguishable from a failure to start.
- A saved position is only restored when it still lands on a connected screen, so an unplugged monitor or a resolution change cannot strand the window either.
- `data:` images render again in Extended mode. react-markdown filters URLs before the sanitizer runs and drops every scheme outside http, https, mailto and xmpp; the preview now widens that for image sources in Extended mode only.
- Images decode reliably: the Blob carries the image's own MIME type, and the bytes from the IPC response are normalized whatever shape they arrive in.
- Granting an image permission no longer reloads every image in the document. Permissions used to reach the preview as a prop, and changing it re-parsed the whole document to help at most one image; the images that can benefit subscribe directly instead. Revoking a permission now does reload them, so what is no longer allowed stops being shown.
- A placeholder on a restored tab says the tab was restored rather than claiming the file is missing, and clicking it reopens the file through the native dialog — the same tab is reused.
- Preflight no longer stalls on a hostile document. A run of backticks that found no partner re-read the rest of its line, so a line whose runs all had distinct lengths made every one of them do it: a 20 MiB document shaped that way took 25 seconds to check, against 80 ms for ordinary text of the same size. Since preflight runs before the window is shown, opening one looked exactly like the application failing to start. The runs on a line are now collected once and matched against each other, and a test asserts a hostile document stays close to ordinary text.

- A large document no longer throws the whole saved session away. The session went to `localStorage`, which holds a few megabytes, while a document may be 20 MiB — and it was stored twice over, since a clean tab wrote its text to both `content` and `originalContent`. The quota error escaped from an effect and took every tab with it. Stored tabs now keep one copy of their text, documents past a cap are left out of the session instead of breaking it, and a storage failure drops that key rather than the render.

- Scrolling no longer stutters. The preview is memoized — `ReactMarkdown` re-parses the entire document on every render, and the shell renders on every scroll frame — and viewport measurement is driven by a `ResizeObserver` instead of running after every render, which had fed measurement back into rendering and made the view oscillate near the bottom of a document.

### Security

- Markdown, startup arguments, file associations, and opened files are treated as untrusted input.
- Native file operations require a path previously authorized by a native dialog or OS open-with handoff.
- Image paths are canonicalized, directory escape and unsupported signatures are rejected, and images are limited to 10 MiB, 40 megapixels, and 100 rendered images per document.
- Safe mode and Extended mode use two separate sanitizer schemas, so widening the extended one cannot weaken the default. `rehype-raw` is added only in Extended mode and only ahead of the sanitizer.
- `data:` images are decoded and validated natively, with the declared type required to match the file signature; the URI itself never reaches the WebView as an image source.
- Authorized image folders are state of their own, separate from the Markdown path allowlist, and do not outlive the process.
- A remote image URL is approvable only if the document names it whole. The check was a bare substring search, so an ordinary link such as `https://example.com/r?to=https://elsewhere.example/pixel.png` made the second host approvable although nobody had written it down as an image source, and a document naming `https://host/pixel.png.bak` did the same for `https://host/pixel.png`. The match must now be delimited on both sides.
- External links open the parsed URL rather than the string that arrived. Parsing accepts input it has to encode on the way in — a raw quote, a tab, a leading space — and the original was what reached the shell, so what opened could differ from what was checked and from what the dialog showed.
- `npm run check` runs in CI. It is the only automated check that `rehype-raw` stays behind the sanitizer and that Safe mode never gets the wider schema, and `THREAT_MODEL.md` already named it as the thing that asserts both.
- Remote images are fetched by the Rust side with WinHTTP rather than by the WebView, which still cannot reach the network. A URL is only approvable if the document on disk names it; the request carries no cookies, credentials, or User-Agent; https is never followed down to http; the response is capped while it is read and then checked like any other image. Approvals are per document and per URL, revocable, and dropped with the tab, the mode, and the process.
- Custom native commands are restricted to the main WebView; external WebView navigation and child-window creation are denied.
