use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=payload/setup.exe");
    println!("cargo:rerun-if-changed=ui/index.html");
    println!("cargo:rerun-if-changed=installer.rc");
    println!("cargo:rerun-if-changed=installer.manifest");

    let _ = embed_resource::compile("installer.rc", embed_resource::NONE);

    // The window has no network and no file:// origin to load fonts from, so
    // the two weight-400 JetBrains Mono subsets go in as data URIs. ~35 KB.
    let fonts = "../src/assets/fonts";
    let css = format!(
        "@font-face{{font-family:'JetBrains Mono';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,{}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}}\n\
         @font-face{{font-family:'JetBrains Mono';font-style:normal;font-weight:400;src:url(data:font/woff2;base64,{}) format('woff2');unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}}",
        b64(&read(&format!("{fonts}/jetbrains-mono-latin-400.woff2"))),
        b64(&read(&format!("{fonts}/jetbrains-mono-cyrillic-400.woff2"))),
    );
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("fonts.css");
    fs::write(out, css).unwrap();
    println!("cargo:rerun-if-changed={fonts}");
}

fn read(path: &str) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}
