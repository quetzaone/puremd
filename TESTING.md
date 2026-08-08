# Manual Testing

Use `src-tauri/target/release/puremd.exe` or the bundled installer build. Do
not use personal or confidential Markdown files when sharing bug reports; create
a small sanitized reproduction instead.

## Core Workflow

- Start the application with no file argument. Confirm the window renders and stays responsive.
- Open two or more Markdown files. Switch tabs by clicking each tab.
- Close a saved tab and an unsaved tab. Confirm Save, Discard, and Cancel behave correctly.
- Create a new tab, edit content, save it, and reopen the saved file.
- Use Save As with a name that has no extension. Confirm the resulting file uses `.md`.
- Use Open and Save As. Confirm native dialogs are focused on top of the app window and filter Markdown files.
- Switch Windows to a non-Latin keyboard layout (Russian, for example) and confirm every `Ctrl` shortcut still fires: `Ctrl+F`, `Ctrl+K`, `Ctrl+O`, `Ctrl+N`, `Ctrl+S`, `Ctrl+E`, `Ctrl+M`, `Ctrl+W`. WebView2's own find bar appearing instead of PureMD's means the shortcut was not claimed — it is the browser's answer to an unhandled `Ctrl+F`, and it searches the whole window including the sidebar and tab titles.
- Confirm `F3` and `Ctrl+G` open PureMD's search and then step through matches, with `Shift` reversing, on every layout. Neither may open the WebView2 find bar.

## Content And Links

- Open `test-files/preflight-warning.md`. Confirm a native warning appears before rendering; Cancel must leave that document closed, while Open loads it.
- Open `test-files/safe.md`. Confirm ordinary Markdown does not show a preflight warning. A normal standalone HTTPS link must not cause a preflight warning either.
- Open Markdown containing headings, lists, code blocks, tables, checkboxes, and long lines.
- In a tight list item that mixes plain text with `**bold**` and `` `code` `` — `- Блок **«Запрос агенту»** вставляется в чат; путь `.claude/` в Codex.` — confirm the item reads as one wrapping paragraph. Each inline run rendered as its own narrow column is the flex-`li` regression.
- Confirm nested lists indent under their parent, a list item holding two paragraphs stacks them, and a checkbox item shows no bullet beside the box.
- Confirm Preview and Code switch with the toolbar tabs and `Ctrl+E`, and that the active tab keeps its underline.
- Press `Ctrl+F` in Preview and Code. Confirm the PureMD search panel opens without the WebView2 search dialog, matches are highlighted in place, Enter and Shift+Enter cycle through them, the counter tracks the current match, ticks appear on the minimap, and Escape closes it.
- Type a one- and two-letter query. Confirm matches, the counter and Enter/Shift+Enter all still work, but the minimap shows no ticks until the third character — one letter marking every line marks nothing.
- In Code, search a digit such as `2`. Confirm the gutter line numbers are never highlighted and never counted. Confirm each hit stays a single crisp word — no doubled or fringed glyphs — and that the current hit is still readable rather than washed out by its own fill.
- Press `Ctrl+K`. Confirm the command palette opens, typing filters the list, arrow keys move the selection, Enter runs the selected command, and Escape closes it.
- Open the sidebar in Preview. Confirm every heading is listed at the right level and clicking one scrolls to it. In Code, confirm the Markdown guide copies a snippet and shows the "copied" confirmation.
- Drag the minimap. Confirm the viewport slab follows the pointer, never runs past the bottom edge, and disappears on a document that does not scroll. Confirm a long document switches to the density map.
- Press `Ctrl+M`. Confirm the minimap hides and reappears, and that the document card stays centred either way.
- Confirm raw HTML is never executed. In Safe mode an HTML block is removed with its contents; inline tags are removed and their text stays.
- Confirm remote images are not loaded until they are asked for, and that Safe mode offers no way to ask.
- In Safe mode, confirm every image stays an alt-text placeholder.

`test-files/extended/extended-mode.md` walks through the cases below in order. Open it and switch the
security chip from Safe mode to Extended mode.

- Enable Extended mode and confirm relative PNG, JPEG, GIF, and WebP files in the document folder or a subfolder render.
- Confirm a `data:image/png;base64,…` image embedded in the document renders, and that it also renders in a document that has never been saved to disk.
- Click a rendered image. Confirm the lightbox opens with the image contained in the window and never upscaled, and that a click on the image, a click on the backdrop, the close button, and `Esc` all close it. Confirm `Esc` closes the lightbox before it leaves Code mode.
- Confirm the placeholders read as two grades: the three that grant something on click carry an amber border, the reason's own icon and a trailing chevron; the six that only explain are dashed, flat and greyed with no chevron.
- Confirm a remote image shows the shimmering skeleton with its host named while the request is in flight, and that a local or embedded image never shows one.
- Confirm `details` opens and closes with the app's own chevron rotating, and that the open state shows a divider under `summary`.
- Confirm the placeholder for an image outside the document folder says so and offers the folder dialog. Accept it, pick the image, and confirm every image from that folder now renders.
- Confirm the sidebar security block then shows the authorized folder with a Revoke action, that Revoke returns those images to placeholders, and that switching back to Safe mode or closing the tab does the same.
- Confirm each failure shows its own placeholder text: file not found, unsupported format, image too large, outside the folder, remote, and the 100-image limit.
- With the network available, confirm the toolbar shows a **Load N images** button only while the document still has remote images nobody asked for, that the dialog names the count and every host before anything is requested, and that Cancel requests nothing.
- Confirm a single remote placeholder can be loaded on its own from the same dialog, and that a remote image which turns out to be an SVG is rejected as an unsupported format rather than rendered — `shields.io` badges are SVG and stay placeholders by design.
- Confirm the sidebar then lists the approved hosts with a Revoke action, and that Revoke, switching to Safe mode, and closing the tab each return those images to placeholders.
- With the network unavailable, confirm the placeholder reports that the server returned nothing usable instead of hanging; the request gives up after about ten seconds.
- Confirm a document that has never been saved offers no remote loading at all, and says so on the placeholder.
- Confirm Extended mode rejects remote URLs, SVG, absolute paths, `../` paths leaving both allowed folders, mismatched file signatures, a `data:` URI whose declared type does not match its bytes, files larger than 10 MiB, and images larger than 40 megapixels.
- Confirm `details`, `summary`, `kbd`, `mark`, `sub`, and `sup` render in Extended mode, and that `script`, `iframe`, `style`, `svg`, event handlers such as `onerror` or `ontoggle`, and `javascript:` hrefs do not, in either mode.
- Restart the application and confirm restored tabs return to Safe mode with no authorized image folder.
- Open an `https` link and cancel the confirmation, then repeat and approve it.
- Confirm `javascript:`, `data:`, and other unsafe links do not open.

## Window Chrome

- Confirm the custom titlebar minimize, maximize/restore, and close buttons work, and that the maximize glyph swaps to the restore glyph while maximized.
- Minimize the window, then close it from the taskbar. Restart and confirm the window comes back where it was before minimizing, not off-screen. `%LOCALAPPDATA%\PureMD\window-state.json` must never hold `-32000`.
- On a two-monitor setup, move the window to the second monitor, close, disconnect that monitor, and restart. Confirm the window appears on the remaining screen.
- Drag the window by the empty part of the titlebar. Confirm it moves and still snaps to screen edges.
- Double-click the empty part of the titlebar. Confirm it toggles maximize.
- Maximize the window. Confirm no content is clipped by the screen edges and the taskbar stays reachable.
- Drag each window edge and corner. Confirm the window still resizes.

## Windows Integration

- Start the app, then launch the same exe again without arguments. Confirm only one process remains and the existing window is focused.
- Start the app, then launch the exe with a `.md` path. Confirm the existing window opens that file in a tab.
- If the installer is used, test the `.md` file association through Windows Open With.
- Restart the app. Confirm real document tabs restore and unsaved empty tabs do not.
- Start the app with `preflight-warning.md` as its file argument when that file was previously open. Confirm Cancel does not restore that requested document from the saved session.

## Production Builds

- Build portable/release artifacts with `npm.cmd run tauri -- build`, not plain `cargo build --release`.
- Run `src-tauri/target/release/puremd.exe` directly to test the portable build. If the WebView shows a localhost connection error, rebuild with the Tauri command above.

## Automated Checks

From the repository root, run:

```sh
npm.cmd audit --omit=dev --package-lock-only
npm.cmd run build
npm.cmd run check
cd src-tauri
cargo test --locked
cargo check --locked
cargo audit
```

`cargo audit` requires the separately installed `cargo-audit` subcommand; install it with `cargo install cargo-audit --locked` when it is not already available.

## Bug Report Minimum

Record the app version or executable name, Windows version, exact steps, expected result,
actual result, and whether the behavior reproduces after restarting the app. Add a sanitized
sample Markdown file or screenshot only when it helps reproduce the issue.
