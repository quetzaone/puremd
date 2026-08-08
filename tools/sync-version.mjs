// Copies package.json's version into every Cargo manifest and lockfile that
// carries it. Runs automatically from the npm "version" lifecycle script, so
// `npm version <patch|minor|major>` stays the single command that bumps the
// release. tauri.conf.json needs no entry: it reads "../package.json" directly.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  throw new Error(`package.json version is not a plain semver: ${version}`);
}

const rewrite = (relative, pattern, what) => {
  const path = join(root, ...relative);
  const before = readFileSync(path, "utf8");
  if (!pattern.test(before)) {
    throw new Error(`no ${what} found in ${relative.join("/")}`);
  }
  writeFileSync(path, before.replace(pattern, `$1"${version}"`));
};

// The [package] version is the first bare `version = "…"` line in a manifest;
// a dependency's inline version is never at the start of a line.
const manifest = /^(version = )"[^"]*"$/m;

// A crate's own entry in a lockfile. Cargo refuses to run with --locked when the
// lockfile disagrees with the manifest, and CI runs `cargo test --locked` and
// `cargo check --locked`, so leaving one behind turns the release commit red.
const lockEntry = (crate) =>
  new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = )"[^"]*"`);

rewrite(["src-tauri", "Cargo.toml"], manifest, "[package] version line");
rewrite(["src-tauri", "Cargo.lock"], lockEntry("puremd"), "puremd package entry");
// The setup window prints this one on its identity row.
rewrite(["installer", "Cargo.toml"], manifest, "[package] version line");
rewrite(["installer", "Cargo.lock"], lockEntry("puremd-installer"), "puremd-installer package entry");

console.log(`synced the src-tauri and installer manifests and lockfiles to ${version}`);
