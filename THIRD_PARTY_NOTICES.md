# Third-Party Notices

This inventory records the direct dependencies resolved in `package-lock.json` and `src-tauri/Cargo.lock` as committed alongside it; the release it describes is whichever version that commit carries. The lockfiles remain the authoritative list of all resolved direct and transitive packages. License expressions below are taken from the installed package or Cargo metadata; retain each dependency's license text when redistributing source or binaries where its license requires it.

## JavaScript and TypeScript

| Package | Resolved version | License |
| --- | ---: | --- |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `react-markdown` | 9.1.0 | MIT |
| `rehype-raw` | 7.0.0 | MIT |
| `rehype-sanitize` | 6.0.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `@tauri-apps/cli` (development) | 2.11.4 | Apache-2.0 OR MIT |
| `@types/react` (development) | 18.3.31 | MIT |
| `@types/react-dom` (development) | 18.3.7 | MIT |
| `@vitejs/plugin-react` (development) | 6.0.3 | MIT |
| `typescript` (development) | 5.9.3 | Apache-2.0 |
| `vite` (development) | 8.1.3 | MIT |

## Bundled assets

| Asset | Version | License |
| --- | ---: | --- |
| JetBrains Mono (`src/assets/fonts/jetbrains-mono-*.woff2`, latin and cyrillic subsets, weights 400 and 600) | 5 (Fontsource build) | SIL Open Font License 1.1 |

The font is bundled so the app renders offline with no network requests. Its license text is kept
verbatim in `src/assets/fonts/LICENSE.txt`, and OFL 1.1 requires it to ship with any redistribution
of the binaries: `tauri.conf.json` declares it as a bundle resource, so the installer places it
beside the executable as `JetBrainsMono-OFL.txt`.

## Rust

| Crate | Resolved version | License |
| --- | ---: | --- |
| `imagesize` | 0.15.0 | MIT |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 |
| `serde` | 1.0.228 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT |
| `tauri-build` (build) | 2.6.3 | Apache-2.0 OR MIT |
| `tauri-plugin-single-instance` | 2.4.2 | Apache-2.0 OR MIT |
| `url` | 2.5.8 | MIT OR Apache-2.0 |
| `windows` | 0.61.3 | MIT OR Apache-2.0 |
