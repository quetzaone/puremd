// Builds the setup binary: the NSIS installer first, then the WebView2 window
// that carries it as a payload.
//
//   node tools/build-installer.mjs              full build
//   node tools/build-installer.mjs --skip-app   reuse the NSIS exe already built
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Windows-only by construction — the payload is an NSIS installer.
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

// npm on Windows is npm.cmd, and Node has refused to spawn .cmd shims without a
// shell since the 2024 argument-injection fix. Handing it one whole string rather
// than an args array is what keeps it from concatenating unescaped arguments —
// which is both the warning Node emits and the reason cargo below gets no shell,
// since the paths passed there can contain spaces.
const runNpm = (line) =>
  execFileSync(`npm.cmd ${line}`, { cwd: root, stdio: "inherit", shell: true });

if (!process.argv.includes("--skip-app")) {
  runNpm("run tauri build");
}

const nsis = join(root, "src-tauri", "target", "release", "bundle", "nsis", `PureMD_${version}_x64-setup.exe`);
try {
  statSync(nsis);
} catch {
  throw new Error(`missing ${nsis} — build the app first (drop --skip-app)`);
}

mkdirSync(join(root, "installer", "payload"), { recursive: true });
copyFileSync(nsis, join(root, "installer", "payload", "setup.exe"));

run("cargo", ["build", "--release", "--manifest-path", join(root, "installer", "Cargo.toml")]);

const out = join(root, "installer", "target", "release", "PureMD-Setup.exe");

// Both published downloads land in release/, which is gitignored: binaries go
// out through GitHub Releases, not the repository.
const releaseDir = join(root, "release");
mkdirSync(releaseDir, { recursive: true });
const setup = join(releaseDir, "PureMD-Setup.exe");
copyFileSync(out, setup);

// The portable download is the bare application plus the font license that OFL
// 1.1 requires to travel with it — the installer ships that file as a bundle
// resource, and a loose exe would drop it. Compress-Archive cannot rename
// entries, so stage the pair under the names they carry inside the zip.
const stage = join(root, "installer", "target", "portable");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(join(root, "src-tauri", "target", "release", "puremd.exe"), join(stage, "puremd.exe"));
copyFileSync(join(root, "src", "assets", "fonts", "LICENSE.txt"), join(stage, "JetBrainsMono-OFL.txt"));

const zip = join(releaseDir, `PureMD-${version}-portable-x64.zip`);
rmSync(zip, { force: true });
run("powershell", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path '${join(stage, "*")}' -DestinationPath '${zip}'`
]);

console.log("");
for (const artifact of [setup, zip]) {
  console.log(`${artifact}  (${(statSync(artifact).size / 1048576).toFixed(1)} MB)`);
}
