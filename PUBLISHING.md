# Publishing Checklist

Use this before cutting a release.

## Verification

```sh
npm.cmd run build
npm.cmd run tauri -- build
```

One command builds the app, the NSIS installer, the setup window around it, and both published
downloads:

```sh
npm.cmd run build:installer
```

It leaves them in `release/`, which is gitignored:

- `PureMD-Setup.exe` — the setup window, carrying the NSIS installer inside it as a payload. The
  raw NSIS exe remains a valid fallback download, but it is the payload now, not the artifact.
- `PureMD-<version>-portable-x64.zip` — `puremd.exe` plus `JetBrainsMono-OFL.txt`. The font license
  has to be in the zip: the installer ships it as a bundle resource, and a loose exe would drop it,
  which OFL 1.1 does not allow.

Add `-- --skip-app` to reuse an NSIS installer that is already built.

Also run the automated checks in `TESTING.md`, including `cargo audit` (which requires the separately installed `cargo-audit` tool).

## Release Preparation

- Bump the version with a single command. `package.json` is the only place a version number is written by hand:

  ```sh
  npm.cmd version patch
  ```

  Use `minor` for user-visible features and `major` for breaking changes. The `version` lifecycle script
  syncs `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `installer/Cargo.toml`;
  `src-tauri/tauri.conf.json` reads `../package.json` directly; the app shows the same number in the menu
  and command palette through the `__APP_VERSION__` build constant, and the setup window prints it from
  its own crate version. npm commits the bump and tags it, so every release maps to exactly one commit.
- Add an entry to `CHANGELOG.md` and prepare GitHub Release notes that describe user-visible changes, known limitations, and any security-relevant fixes.
- Treat Windows code signing and Microsoft Defender SmartScreen reputation as operational release risks. Verify the signing status and publisher identity of the final artifact; an unsigned or newly signed installer may still prompt users.
- Run `PureMD-Setup.exe` on a clean Windows test environment, launch the installed app, verify `.md` and `.markdown` Open With behavior, and check that the setup window prints the version being released.
- Unpack the portable zip somewhere outside Program Files and launch `puremd.exe` from it. Confirm it starts with no install step, and that `JetBrainsMono-OFL.txt` is in the archive.
- Compute SHA-256 hashes for every published installer and executable, publish them with the release, and compare the published values with the locally built artifacts.

For example, from PowerShell:

```powershell
Get-FileHash "release/*" -Algorithm SHA256
```

Manual Windows smoke pass:

- Launch `src-tauri/target/release/puremd.exe`.
- Launch the exe again without arguments; the existing window should be focused.
- Launch the exe with a `.md` file path; the existing window should open it in a tab.
- Check Open, Save, and Save As dialogs.
- Confirm external links still require confirmation.
- Complete the release checks in `TESTING.md` and resolve or document all known issues.
