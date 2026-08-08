# Threat Model

PureMD treats Markdown files as untrusted local input.

## Assets and Trust Boundaries

- Assets include the user's Markdown contents, the set of paths the application is allowed to read or overwrite, the integrity of the WebView UI, and the user's decision before opening an external site.
- Markdown, startup arguments, Windows file associations, and open-with handoff paths are untrusted. A native dialog or OS handoff authorizes a canonical supported Markdown path before native commands use it.
- The WebView renders content and requests narrow native commands; it is not trusted to choose arbitrary filesystem paths. The native layer enforces the path authorization boundary.
- The WebView CSP permits bundled content and blocks remote connections, frames, objects, forms, and non-bundled scripts. It complements rather than replaces renderer sanitization and the native checks.

## Goals

- Render Markdown without executing scripts or raw HTML.
- Avoid fetching remote resources while previewing a document.
- Keep file reads and writes user-directed.
- Keep native Tauri commands narrow and easy to audit.
- Make second-instance file handoff work without exposing a fixed localhost port.

## Non-Goals

- PureMD is not a sandbox for malicious local users with direct access to the machine.
- PureMD does not try to encrypt files or hide local reading history from the current OS user.
- PureMD is not a collaborative editor and does not provide sync.

## Current Controls

- `react-markdown` renders Markdown without `rehype-raw` in Safe mode. Extended mode adds `rehype-raw` ahead of `rehype-sanitize`, so raw HTML is parsed only to be handed to the sanitizer as a tree; the reverse order would leave it unchecked.
- `rehype-sanitize` constrains rendered output through two separate schemas. `safeSchema` is what Safe mode has always used; `extendedSchema` derives from it and adds `mark` and the `data` protocol for image sources. Widening the extended schema cannot reach Safe mode.
- Extended mode renders `details`, `summary`, `kbd`, `mark`, `sub`, and `sup`. Every other tag, every attribute outside the allowlist, and every event handler are dropped by the sanitizer, in both modes.
- Safe mode shows image syntax as a placeholder and renders no images at all. Explicit per-tab Extended mode can read supported raster images only through a native path and signature validator.
- Extended mode is limited to PNG, JPEG, GIF, and WebP, with 10 MiB, 40-megapixel, and 100-images-per-document limits. SVG, remote URLs, absolute paths, and directory escape are rejected.
- `data:` images are accepted in Extended mode only. The URI is never used as a source: Rust decodes the base64 with a strict standard-alphabet decoder, requires the declared type to match the file signature, and applies the same size and pixel limits. The frontend only ever receives validated bytes.
- Image paths must resolve inside the canonical document directory or inside one extra folder authorized for that document through a native dialog. That authorization is separate state from the Markdown path allowlist, is revocable from the UI, is dropped when the tab closes or the mode is switched off, and never survives the process.
- Remote images are fetched by the Rust side with WinHTTP, never by the WebView, and only for a URL the user approved for that document. An approval is refused unless the document as it is on disk names that URL whole — the match has to be delimited on both sides, so a URL nested inside another one's query string, or a prefix of a longer URL, does not count. A WebView that has been taken over therefore cannot name a destination the document does not already offer. The request carries no cookies, credentials, or User-Agent; https is never followed down to http; the response is capped at 10 MiB while it is read and then has to pass the same signature and pixel checks as a file. Approvals are per document, are shown in the sidebar with a revoke action, and do not outlive the tab, the mode, or the process.
- External links are filtered to `http` and `https`, then opened only after user confirmation. What is handed to the shell is the parsed URL, not the string that arrived, so the link that opens is the one that was checked and the one the dialog showed.
- The Tauri CSP blocks remote connections from the WebView, including for images: `connect-src` is `none` and `img-src` allows only `self` and `blob:`.
- Tauri capabilities are limited to `core:default`.
- Every custom command verifies that its caller is the main WebView. The main WebView rejects external navigation and `window.open` requests.
- File dialogs are native Win32 dialogs owned by the app window.
- Single-instance handoff uses `tauri-plugin-single-instance`, not a fixed localhost listener.
- Native file commands accept only canonical Markdown paths previously selected through a native dialog or supplied by OS open-with handoff.

## Known Limitations

- Preflight is a bounded heuristic that can miss dangerous-looking input and can flag benign input. It is not a malware scanner or a safety verdict.
- The application cannot protect against a malicious local user, compromised operating system, or a vulnerability in the browser engine, Windows, Tauri, or a dependency.
- Confirming an external `http` or `https` link deliberately hands navigation to the system browser; the destination remains outside this application's trust boundary.
- Loading a remote image tells that server the reader's IP address and the time the document was opened. That is the cost the dialog states, and it cannot be undone once paid. A tracking pixel in someone else's Markdown is indistinguishable from a badge.
- Approval is per URL, but the check behind it is that the document names that URL. A WebView that has been taken over *and* can write to an already-open document could plant a URL, wait for the reader to approve loading images in that document, and reach that host. Nothing runtime-derived can be smuggled into the URL without first being written to disk through an authorized path, so this is bounded by what the attacker could already write; it is not a general way to send data out.
- Redirects are followed by WinHTTP, up to its default limit and never from https to http. The host that finally answers may therefore differ from the host the dialog named.
- The saved session holds the text of the documents it restores, not only their paths, and the recent-file list holds filenames and paths. Both sit unencrypted in the WebView's local storage, readable by the current OS user. Documents past a size cap are left out of the session rather than stored.
- Preflight reads the whole file before the window appears, so a document at the size limit delays startup by however long that read takes. The scan is single-pass, and a regression test keeps a hostile document's cost close to ordinary text of the same size, but the delay is proportional to the file and cannot be zero.

## Review Checklist

For any security-sensitive change, check:

- Can Markdown content execute script, HTML event handlers, iframes, SVG script, or unsafe URLs?
- Can previewing a file trigger a network request without the user having asked for that exact image?
- Can a URL reach the fetcher without appearing in the document on disk, or without a per-document approval that is still current?
- Can an image reference escape the canonical document directory and the one authorized image folder, bypass the size limit, or disguise an unsupported format?
- Does a change to the extended sanitizer schema leave the safe schema untouched, and does `rehype-raw` still run only in Extended mode and only before the sanitizer? `npm run check` asserts both.
- Can a webview route read or write arbitrary files without a user action?
- Is every path passed to a native file command already authorized by OS handoff or a native dialog?
- Can an external link launch a non-web protocol?
- Did a new dependency add networking, scripting, or native execution paths?
