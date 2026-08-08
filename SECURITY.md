# Security Policy

PureMD is designed as a local-first Markdown viewer/editor.

## Supported Scope

Please report issues that can affect local file safety, Markdown rendering safety,
Tauri command exposure, file association handling, or Windows desktop startup.

## Supported Versions

Security fixes are made for the latest release on the default branch. Older releases are not supported unless a release note says otherwise.

## Security Model

- No telemetry, accounts, cloud sync, update checker, or remote fonts.
- Raw HTML in Markdown is not executed.
- Safe mode renders image syntax as alt-text placeholders and loads no images at all.
- Explicit per-tab Extended mode accepts relative PNG, JPEG, GIF, and WebP files inside the canonical document directory, `data:` base64 images embedded in the document, and files inside one extra folder the user authorizes through a native dialog. It resets on restart; SVG, absolute paths, directory escape, invalid signatures, files over 10 MiB, images over 40 megapixels, and documents with more than 100 rendered images are rejected or capped.
- Remote images are never loaded on their own, and never by the WebView. In Extended mode the user can ask for them for the current document, after a dialog that names every server first. Rust fetches them with WinHTTP, only for a URL the document itself names, carrying no cookies, credentials, or User-Agent. Approvals are per document and per URL, revocable, and dropped with the tab, the mode, and the process.
- External links are limited to `http` and `https` and require user confirmation.
- Before content is returned to the WebView, a native one-time-token preflight can warn about raw HTML/SVG, unsafe URI schemes, remote-image patterns, large data URIs, unusually long lines, and excessive links or images. It is heuristic only; a lack of findings is not a safety guarantee.
- The Tauri content security policy is intentionally strict.
- Custom native commands are restricted to the main WebView, which also rejects external navigation and child-window requests.
- File reads and writes are limited to user-selected files or files passed by OS open-with behavior.
- These controls reduce risk; they do not make a hostile file safe. Treat every opened Markdown file as untrusted input.

## Reporting

Do not report vulnerabilities through public GitHub issues. Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. The report stays private between you and the maintainer until an advisory is published. Share only the minimum reproduction details, and do not include private files or secrets in reports.

The maintainer aims to acknowledge reports within 7 calendar days and to provide a status update at least every 30 days while investigating. These are targets, not a service-level guarantee. Please allow reasonable time for a fix before public disclosure.
