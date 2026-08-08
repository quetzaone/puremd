use std::{
    collections::{HashMap, HashSet},
    fmt::Write,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use std::os::windows::process::CommandExt;

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPEN_REQUEST_FLAGS,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    },
    Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, GetSaveFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    },
};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedFile {
    path: String,
    name: String,
    content: String,
    modified_ms: u128,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightFindings {
    raw_html: u32,
    unsafe_uri: u32,
    remote_images: u32,
    large_data_uri: u32,
    long_lines: u32,
    excessive_links: u32,
    excessive_images: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightFile {
    path: String,
    name: String,
    modified_ms: u128,
    token: String,
    findings: PreflightFindings,
}

struct PendingMarkdown {
    loaded: LoadedFile,
    expires_at: Instant,
}

struct PendingMarkdownFiles {
    files: Arc<Mutex<HashMap<String, PendingMarkdown>>>,
}

impl PendingMarkdownFiles {
    fn new() -> Self {
        Self {
            files: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn remove_expired(&self) -> Result<(), String> {
        let mut files = self
            .files
            .lock()
            .map_err(|_| "Pending Markdown state is unavailable.".to_string())?;
        files.retain(|_, value| value.expires_at > Instant::now());
        Ok(())
    }

    fn can_accept(&self) -> Result<(), String> {
        self.remove_expired()?;
        let files = self
            .files
            .lock()
            .map_err(|_| "Pending Markdown state is unavailable.".to_string())?;
        if files.len() >= MAX_PENDING_MARKDOWN_FILES {
            return Err("Too many Markdown files are awaiting confirmation.".into());
        }

        Ok(())
    }

    fn insert(&self, token: String, loaded: LoadedFile) -> Result<(), String> {
        self.remove_expired()?;
        let mut files = self
            .files
            .lock()
            .map_err(|_| "Pending Markdown state is unavailable.".to_string())?;
        if files.len() >= MAX_PENDING_MARKDOWN_FILES {
            return Err("Too many Markdown files are awaiting confirmation.".into());
        }

        files.insert(
            token,
            PendingMarkdown {
                loaded,
                expires_at: Instant::now() + PREFLIGHT_TOKEN_TTL,
            },
        );
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMetadata {
    modified_ms: u128,
}

struct CloseRequestState(Arc<AtomicBool>);

/// Native commands must not turn a compromised WebView into a Markdown-file
/// browser. Paths become usable only after an OS launch argument or a native
/// file dialog explicitly selected them.
struct AuthorizedMarkdownPaths(Mutex<HashSet<PathBuf>>);

/// Extra image roots the user picked with a native dialog, one per document.
/// Deliberately not folded into `AuthorizedMarkdownPaths`: extended mode hands
/// out image access with its own lifetime — revoked when the mode is switched
/// off or the tab closes — while Markdown authorization lasts for the process.
struct AuthorizedImageFolders(Mutex<HashMap<PathBuf, PathBuf>>);

/// Remote image URLs the user approved, per document. This is the only thing
/// that lets the process open a network connection at all, so the set is never
/// taken from the WebView on trust: every URL added here has to appear verbatim
/// in the document as it is on disk.
struct AllowedRemoteImages(Mutex<HashMap<PathBuf, HashSet<String>>>);

fn remote_image_is_allowed(
    allowed: &AllowedRemoteImages,
    document_path: &Path,
    image_source: &str,
) -> Result<bool, String> {
    Ok(allowed
        .0
        .lock()
        .map_err(|_| "Remote image authorization state is unavailable.".to_string())?
        .get(document_path)
        .is_some_and(|sources| sources.contains(image_source)))
}

fn authorized_image_folder(
    folders: &AuthorizedImageFolders,
    document_path: &Path,
) -> Result<Option<PathBuf>, String> {
    Ok(folders
        .0
        .lock()
        .map_err(|_| "Image folder authorization state is unavailable.".to_string())?
        .get(document_path)
        .cloned())
}

fn canonical_markdown_path(path: &Path) -> Result<PathBuf, String> {
    let path = match path.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            let parent = path
                .parent()
                .ok_or_else(|| "Markdown path has no parent directory.".to_string())?;
            let name = path
                .file_name()
                .ok_or_else(|| "Markdown path has no file name.".to_string())?;
            parent
                .canonicalize()
                .map_err(|error| error.to_string())?
                .join(name)
        }
    };

    if !is_supported_markdown_path(&path) {
        return Err("Only .md, .markdown, and .mdx files are supported.".into());
    }

    Ok(path)
}

fn authorize_path(paths: &AuthorizedMarkdownPaths, path: &Path) -> Result<PathBuf, String> {
    let path = canonical_markdown_path(path)?;
    paths
        .0
        .lock()
        .map_err(|_| "Path authorization state is unavailable.".to_string())?
        .insert(path.clone());
    Ok(path)
}

fn require_authorized_path(
    paths: &AuthorizedMarkdownPaths,
    path: &Path,
) -> Result<PathBuf, String> {
    let path = canonical_markdown_path(path)?;
    if paths
        .0
        .lock()
        .map_err(|_| "Path authorization state is unavailable.".to_string())?
        .contains(&path)
    {
        Ok(path)
    } else {
        Err("Select the Markdown file with the native Open dialog first.".into())
    }
}

fn window_state_path() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("PureMD")
            .join("window-state.json");
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("window-state.json")
}

fn webview_data_dir() -> PathBuf {
    let preferred = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("PureMD").join("WebView2"));

    if let Some(path) = preferred {
        if fs::create_dir_all(&path).is_ok() {
            return path;
        }
    }

    let fallback = std::env::temp_dir().join("PureMD").join("WebView2");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

fn load_window_state() -> Option<WindowState> {
    let path = window_state_path();
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// True when enough of the window lands on this screen to grab its titlebar.
fn window_fits_screen(window: (i32, i32, u32, u32), screen: (i32, i32, u32, u32)) -> bool {
    let (window_x, window_y, window_width, window_height) = window;
    let (screen_x, screen_y, screen_width, screen_height) = screen;
    let visible_width =
        (window_x + window_width as i32).min(screen_x + screen_width as i32) - window_x.max(screen_x);
    let visible_height = (window_y + window_height as i32).min(screen_y + screen_height as i32)
        - window_y.max(screen_y);

    visible_width >= 80 && visible_height >= 40
}

fn save_window_state<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    // Windows reports a minimized window at (-32000, -32000). Writing that down
    // restores the window off every screen next time, which looks exactly like
    // the application failing to start: a taskbar entry and nothing else. The
    // previous, usable geometry is worth more than this one.
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }

    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
        fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
    };
    let path = window_state_path();

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let content = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn restore_window_state<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Some(state) = load_window_state() else {
        return;
    };

    if !state.fullscreen && !state.maximized {
        // The saved position is only honoured if it still lands on a screen.
        // Monitors get unplugged and resolutions change; a window restored into
        // nowhere is indistinguishable from a broken application.
        let on_a_screen = window
            .available_monitors()
            .map(|monitors| {
                monitors.iter().any(|monitor| {
                    let position = monitor.position();
                    let size = monitor.size();
                    window_fits_screen(
                        (state.x, state.y, state.width, state.height),
                        (position.x, position.y, size.width, size.height),
                    )
                })
            })
            .unwrap_or(false);

        if on_a_screen {
            let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        }

        let _ = window.set_size(PhysicalSize::new(
            state.width.max(520),
            state.height.max(420),
        ));
    }

    if state.maximized {
        let _ = window.maximize();
    }

    if state.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

fn file_modified_ms(path: &Path) -> Result<u128, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    modified_ms_from_metadata(&metadata)
}

fn modified_ms_from_metadata(metadata: &fs::Metadata) -> Result<u128, String> {
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis())
}

fn is_supported_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdx"
            )
        })
        .unwrap_or(false)
}

fn arg_markdown_path() -> Option<PathBuf> {
    markdown_path_from_args(std::env::args())
}

fn markdown_path_from_args(args: impl IntoIterator<Item = String>) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_file() && is_supported_markdown_path(path))
}

const MAX_MARKDOWN_FILE_SIZE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_LOCAL_IMAGE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LOCAL_IMAGE_PIXELS: usize = 40_000_000;
const PREFLIGHT_TOKEN_TTL: Duration = Duration::from_secs(60);
const PREFLIGHT_CLEANUP_INTERVAL: Duration = Duration::from_secs(10);
const MAX_PENDING_MARKDOWN_FILES: usize = 4;
const LONG_LINE_BYTES: usize = 16 * 1024;
const LARGE_DATA_URI_BYTES: usize = 64 * 1024;
const EXCESSIVE_LINKS: u32 = 1_000;
const EXCESSIVE_IMAGES: u32 = 250;

/// Image failures are returned as stable codes rather than sentences so the
/// placeholder can explain the reason in the user's language, and so the one
/// recoverable case — an image outside the document folder — can offer the
/// native dialog that authorizes it.
const IMAGE_ERROR_MISSING: &str = "image-missing";
const IMAGE_ERROR_OUTSIDE_FOLDER: &str = "image-outside-folder";
const IMAGE_ERROR_UNSUPPORTED: &str = "image-unsupported";
const IMAGE_ERROR_TOO_LARGE: &str = "image-too-large";
/// The document was restored from the last session, so its path was never
/// authorized in this process. The file is there; the application simply has no
/// right to touch it yet, and saying "no such file" would be a lie.
const IMAGE_ERROR_UNAUTHORIZED: &str = "image-unauthorized";
const IMAGE_ERROR_REMOTE_BLOCKED: &str = "image-remote-blocked";
const IMAGE_ERROR_REMOTE_FAILED: &str = "image-remote-failed";

/// Milliseconds. A remote image is a convenience, never something worth
/// keeping the reader waiting for.
const REMOTE_IMAGE_TIMEOUT_MS: i32 = 10_000;
const REMOTE_IMAGE_RECEIVE_TIMEOUT_MS: i32 = 20_000;

fn ensure_markdown_file_size(path: &Path) -> Result<u128, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let size = metadata.len();
    if size > MAX_MARKDOWN_FILE_SIZE_BYTES {
        return Err(format!(
            "Markdown files larger than {} MiB are not supported.",
            MAX_MARKDOWN_FILE_SIZE_BYTES / (1024 * 1024)
        ));
    }

    modified_ms_from_metadata(&metadata)
}

fn ensure_markdown_content_size(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_MARKDOWN_FILE_SIZE_BYTES {
        return Err(format!(
            "Markdown content larger than {} MiB is not supported.",
            MAX_MARKDOWN_FILE_SIZE_BYTES / (1024 * 1024)
        ));
    }

    Ok(())
}

fn require_main_webview<R: Runtime>(webview: &WebviewWindow<R>) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("This command is only available to the main application window.".into())
    }
}

fn is_allowed_navigation_url(url: &url::Url) -> bool {
    let bundled_app = url.scheme() == "tauri"
        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost");
    let development_app = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1420);

    bundled_app || development_app
}

/// The format is decided by the signature alone. Everything that reaches a
/// `<img>` has passed through here first, whether it came from disk or from a
/// `data:` URI in the document.
fn image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

/// On disk the extension has to agree with the signature too, so a `.png` that
/// is really something else stays out even when its bytes are a valid image.
fn local_image_mime(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    let mime = image_mime_from_bytes(bytes)?;
    let agrees = match extension.as_str() {
        "png" => mime == "image/png",
        "jpg" | "jpeg" => mime == "image/jpeg",
        "gif" => mime == "image/gif",
        "webp" => mime == "image/webp",
        _ => false,
    };

    agrees.then_some(mime)
}

fn ensure_local_image_dimensions(bytes: &[u8]) -> Result<(), String> {
    let size = imagesize::blob_size(bytes).map_err(|_| IMAGE_ERROR_UNSUPPORTED.to_string())?;
    if size.width == 0 || size.height == 0 {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    let pixels = size
        .width
        .checked_mul(size.height)
        .ok_or_else(|| IMAGE_ERROR_TOO_LARGE.to_string())?;
    if pixels > MAX_LOCAL_IMAGE_PIXELS {
        return Err(IMAGE_ERROR_TOO_LARGE.into());
    }

    Ok(())
}

/// Strict standard-alphabet base64. Whitespace is skipped because Markdown
/// wrapping splits long `data:` URIs across lines; anything else outside the
/// alphabet, and any padding that does not match the length, is rejected.
fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    fn sextet(symbol: u8) -> Option<u32> {
        match symbol {
            b'A'..=b'Z' => Some(u32::from(symbol - b'A')),
            b'a'..=b'z' => Some(u32::from(symbol - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(symbol - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let symbols: Vec<u8> = value
        .bytes()
        .filter(|symbol| !symbol.is_ascii_whitespace())
        .collect();
    let (symbols, padding) = if let Some(rest) = symbols.strip_suffix(b"==") {
        (rest, 2)
    } else if let Some(rest) = symbols.strip_suffix(b"=") {
        (rest, 1)
    } else {
        (&symbols[..], 0)
    };

    if symbols.contains(&b'=') || (symbols.len() + padding) % 4 != 0 {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }
    if symbols.len() / 4 * 3 > MAX_LOCAL_IMAGE_SIZE_BYTES as usize {
        return Err(IMAGE_ERROR_TOO_LARGE.into());
    }

    let mut bytes = Vec::with_capacity(symbols.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for symbol in symbols {
        accumulator = (accumulator << 6) | sextet(*symbol).ok_or(IMAGE_ERROR_UNSUPPORTED)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits) as u8);
        }
    }

    Ok(bytes)
}

/// `data:image/png;base64,…` embedded in the document. The declared type has
/// to agree with the signature, and the same size and pixel ceilings apply as
/// for a file on disk.
fn decode_data_image(image_source: &str) -> Result<Vec<u8>, String> {
    let rest = image_source
        .trim()
        .strip_prefix("data:")
        .ok_or(IMAGE_ERROR_UNSUPPORTED)?;
    let (metadata, payload) = rest.split_once(',').ok_or(IMAGE_ERROR_UNSUPPORTED)?;
    let metadata = metadata.to_ascii_lowercase();
    let parameters = metadata
        .strip_suffix(";base64")
        .ok_or(IMAGE_ERROR_UNSUPPORTED)?;
    let declared = parameters.split(';').next().unwrap_or_default();

    if !matches!(
        declared,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    let bytes = decode_base64(payload)?;
    if bytes.len() as u64 > MAX_LOCAL_IMAGE_SIZE_BYTES {
        return Err(IMAGE_ERROR_TOO_LARGE.into());
    }
    if image_mime_from_bytes(&bytes) != Some(declared) {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    ensure_local_image_dimensions(&bytes)?;
    Ok(bytes)
}

fn resolve_local_image_path(
    document_path: &Path,
    image_folder: Option<&Path>,
    image_source: &str,
) -> Result<PathBuf, String> {
    let image_source = image_source.trim();
    if image_source.is_empty()
        || image_source.contains(['?', '#'])
        || url::Url::parse(image_source).is_ok()
    {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    let decoded = percent_encoding::percent_decode_str(image_source)
        .decode_utf8()
        .map_err(|_| IMAGE_ERROR_UNSUPPORTED.to_string())?;
    let relative_path = Path::new(decoded.as_ref());
    // `has_root` as well as `is_absolute`: on Windows a leading slash is rooted
    // but not absolute, and joining it silently jumps to the drive root. That
    // shape is the site-root-relative path docs repositories use, which has no
    // meaning for a local file — reject it instead of resolving it somewhere.
    if relative_path.is_absolute() || relative_path.has_root() {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    let document_root = document_path
        .parent()
        .ok_or_else(|| IMAGE_ERROR_MISSING.to_string())?
        .canonicalize()
        .map_err(|_| IMAGE_ERROR_MISSING.to_string())?;
    let image_path = document_root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| IMAGE_ERROR_MISSING.to_string())?;

    // ponytail: the resolved file has to land inside one of the two allowed
    // roots. No search-path fallback — a source that resolves nowhere stays
    // missing. Add one only if a real document turns out to need it.
    let allowed = image_path.starts_with(&document_root)
        || image_folder.is_some_and(|folder| image_path.starts_with(folder));
    if !allowed {
        return Err(IMAGE_ERROR_OUTSIDE_FOLDER.into());
    }

    Ok(image_path)
}

fn loaded_file(path: &Path, content: String, modified_ms: u128) -> Result<LoadedFile, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.md")
        .to_string();

    Ok(LoadedFile {
        path: path.to_string_lossy().to_string(),
        name,
        content,
        modified_ms,
    })
}

fn ascii_eq_at(bytes: &[u8], index: usize, needle: &[u8]) -> bool {
    bytes
        .get(index..index + needle.len())
        .map(|slice| {
            slice
                .iter()
                .zip(needle)
                .all(|(left, right)| left.eq_ignore_ascii_case(right))
        })
        .unwrap_or(false)
}

fn is_inline_event_at(bytes: &[u8], index: usize) -> bool {
    if !ascii_eq_at(bytes, index, b"on")
        || index > 0 && !matches!(bytes[index - 1], b'<' | b' ' | b'\t' | b'\n' | b'\r')
    {
        return false;
    }

    let mut cursor = index + 2;
    let limit = (index + 34).min(bytes.len());
    while cursor < limit && bytes[cursor].is_ascii_alphabetic() {
        cursor += 1;
    }
    cursor > index + 2 && cursor < bytes.len() && bytes[cursor] == b'='
}

fn fence_run(line: &[u8]) -> Option<(u8, usize, usize)> {
    let indent = line.iter().take_while(|byte| **byte == b' ').count();
    if indent > 3 {
        return None;
    }

    let marker = *line.get(indent)?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }

    let length = line[indent..]
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    (length >= 3).then_some((marker, length, indent + length))
}

fn code_mask(bytes: &[u8]) -> Vec<bool> {
    let mut mask = vec![false; bytes.len()];
    let mut fence: Option<(u8, usize)> = None;
    let mut line_start = 0;

    while line_start < bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| line_start + offset)
            .unwrap_or(bytes.len());
        let line = &bytes[line_start..line_end];

        if let Some((marker, length)) = fence {
            mask[line_start..line_end].fill(true);
            if let Some((candidate, candidate_length, after_marker)) = fence_run(line) {
                if candidate == marker
                    && candidate_length >= length
                    && line[after_marker..].iter().all(|byte| byte.is_ascii_whitespace())
                {
                    fence = None;
                }
            }
        } else if let Some((marker, length, _)) = fence_run(line) {
            mask[line_start..line_end].fill(true);
            fence = Some((marker, length));
        }

        line_start = line_end + 1;
    }

    // Inline spans, one line at a time. The backtick runs on a line are collected
    // once and then matched against each other, so a run that finds no partner
    // costs nothing for the runs that follow it.
    //
    // Scanning forward from every run instead was superlinear: each failed run
    // re-read the rest of its line, and a line whose runs have pairwise distinct
    // lengths has enough of them to make that hurt. A 20 MiB document shaped that
    // way took 25 seconds to check, against 80 ms for ordinary text of the same
    // size — and preflight runs before the window is shown, so opening one looked
    // exactly like the application failing to start.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut partner: Vec<Option<usize>> = Vec::new();
    let mut next_of_length: HashMap<usize, usize> = HashMap::new();
    let mut line_start = 0;

    while line_start < bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| line_start + offset)
            .unwrap_or(bytes.len());

        // A fenced line is masked whole by the pass above, and a span never
        // crosses a newline, so the whole line is already decided.
        if mask[line_start] {
            line_start = line_end + 1;
            continue;
        }

        runs.clear();
        let mut cursor = line_start;
        while cursor < line_end {
            if bytes[cursor] != b'`' {
                cursor += 1;
                continue;
            }

            let length = bytes[cursor..line_end]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            runs.push((cursor, length));
            cursor += length;
        }

        // Nothing can pair up with fewer than two runs, and that is nearly every
        // line in a real document — worth checking before touching the map.
        if runs.len() >= 2 {
            // Walking backwards, every run learns the next run of its own length —
            // the closer the forward scan used to go looking for.
            partner.clear();
            partner.resize(runs.len(), None);
            next_of_length.clear();
            for index in (0..runs.len()).rev() {
                partner[index] = next_of_length.get(&runs[index].1).copied();
                next_of_length.insert(runs[index].1, index);
            }

            let mut index = 0;
            while index < runs.len() {
                if let Some(close) = partner[index] {
                    let (close_start, close_length) = runs[close];
                    mask[runs[index].0..close_start + close_length].fill(true);
                    index = close + 1;
                } else {
                    index += 1;
                }
            }
        }

        line_start = line_end + 1;
    }

    mask
}

fn scan_markdown(bytes: &[u8]) -> PreflightFindings {
    let mut findings = PreflightFindings::default();
    let code = code_mask(bytes);
    let mut line_len = 0usize;
    let mut long_line_reported = false;
    let mut links = 0u32;
    let mut images = 0u32;
    let mut image_state = 0u8;
    let mut data_uri_len: Option<usize> = None;

    for index in 0..bytes.len() {
        let byte = bytes[index];
        if byte == b'\n' {
            line_len = 0;
            long_line_reported = false;
        } else {
            line_len += 1;
            if line_len > LONG_LINE_BYTES && !long_line_reported {
                findings.long_lines += 1;
                long_line_reported = true;
            }
        }

        if code[index] {
            data_uri_len = None;
            image_state = 0;
            continue;
        }

        if let Some(length) = data_uri_len.as_mut() {
            if matches!(byte, b')' | b'\'' | b'\"' | b' ' | b'\t' | b'\r' | b'\n') {
                data_uri_len = None;
            } else {
                *length += 1;
                if *length == LARGE_DATA_URI_BYTES + 1 {
                    findings.large_data_uri += 1;
                }
            }
        }

        if byte == b'<'
            && (ascii_eq_at(bytes, index + 1, b"script")
                || ascii_eq_at(bytes, index + 1, b"iframe")
                || ascii_eq_at(bytes, index + 1, b"object")
                || ascii_eq_at(bytes, index + 1, b"embed")
                || ascii_eq_at(bytes, index + 1, b"svg"))
        {
            findings.raw_html += 1;
        }
        if is_inline_event_at(bytes, index) {
            findings.raw_html += 1;
        }
        if ascii_eq_at(bytes, index, b"javascript:")
            || ascii_eq_at(bytes, index, b"data:")
            || ascii_eq_at(bytes, index, b"file:")
            || ascii_eq_at(bytes, index, b"vbscript:")
        {
            findings.unsafe_uri += 1;
            if ascii_eq_at(bytes, index, b"data:") {
                data_uri_len = Some(0);
            }
        }

        match image_state {
            0 if byte == b'!' => image_state = 1,
            1 if byte == b'[' => image_state = 2,
            1 => image_state = 0,
            2 if byte == b']' => image_state = 3,
            2 => {}
            3 if byte == b'(' => image_state = 4,
            3 => image_state = 0,
            4 => {
                images += 1;
                if ascii_eq_at(bytes, index, b"http://") || ascii_eq_at(bytes, index, b"https://") {
                    findings.remote_images += 1;
                }
                image_state = 0;
            }
            _ => image_state = 0,
        }

        if byte == b']'
            && index + 1 < bytes.len()
            && bytes[index + 1] == b'('
            && (index == 0 || bytes[index - 1] != b'!')
        {
            links += 1;
        }
    }

    if links > EXCESSIVE_LINKS {
        findings.excessive_links = links;
    }
    if images > EXCESSIVE_IMAGES {
        findings.excessive_images = images;
    }
    findings
}

fn preflight_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    unsafe {
        BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
            .ok()
            .map_err(|error| format!("Could not create Markdown preflight token: {error}"))?;
    }

    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(token)
}

fn start_pending_markdown_cleanup(files: Arc<Mutex<HashMap<String, PendingMarkdown>>>) {
    let _ = thread::Builder::new()
        .name("markdown-preflight-cleanup".into())
        .spawn(move || loop {
            thread::sleep(PREFLIGHT_CLEANUP_INTERVAL);
            if let Ok(mut files) = files.lock() {
                files.retain(|_, value| value.expires_at > Instant::now());
            }
        });
}

fn prepare_file(path: &Path, pending: &PendingMarkdownFiles) -> Result<PreflightFile, String> {
    pending.can_accept()?;
    let modified_ms = ensure_markdown_file_size(path)?;
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let findings = scan_markdown(content.as_bytes());
    let loaded = loaded_file(path, content, modified_ms)?;
    let token = preflight_token()?;
    let path = loaded.path.clone();
    let name = loaded.name.clone();
    pending.insert(token.clone(), loaded)?;
    Ok(PreflightFile {
        path,
        name,
        modified_ms,
        token,
        findings,
    })
}

fn spawn_hidden_command(command: &mut Command) -> Result<(), String> {
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_filter() -> Vec<u16> {
    "Markdown files\0*.md;*.markdown;*.mdx\0All files\0*.*\0\0"
        .encode_utf16()
        .collect()
}

fn wide_image_filter() -> Vec<u16> {
    "Images\0*.png;*.jpg;*.jpeg;*.gif;*.webp\0\0"
        .encode_utf16()
        .collect()
}

/// Closes its WinHTTP handle on every path out of `fetch_remote_image_bytes`,
/// including the early returns.
struct WinHttpHandle(*mut std::ffi::c_void);

impl Drop for WinHttpHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

/// The one place in PureMD that opens a network connection, and it is reached
/// only after the user approved this exact URL for this exact document.
///
/// WinHTTP rather than an HTTP crate on purpose: it is already on the machine,
/// it uses the system certificate store and system proxy settings, and it adds
/// nothing to what this application ships. No User-Agent is sent — the request
/// carries the IP address and the timing and nothing else that names the reader.
/// WinHTTP's default redirect policy refuses to follow https down to http.
fn fetch_remote_image_bytes(url: &url::Url) -> Result<Vec<u8>, String> {
    let host = url.host_str().ok_or(IMAGE_ERROR_REMOTE_FAILED)?;
    let secure = url.scheme() == "https";
    let port = url
        .port_or_known_default()
        .ok_or(IMAGE_ERROR_REMOTE_FAILED)?;
    let mut target = url.path().to_string();
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }

    let session = WinHttpHandle(unsafe {
        WinHttpOpen(
            PCWSTR::null(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    });
    if session.0.is_null() {
        return Err(IMAGE_ERROR_REMOTE_FAILED.into());
    }

    unsafe {
        WinHttpSetTimeouts(
            session.0,
            REMOTE_IMAGE_TIMEOUT_MS,
            REMOTE_IMAGE_TIMEOUT_MS,
            REMOTE_IMAGE_TIMEOUT_MS,
            REMOTE_IMAGE_RECEIVE_TIMEOUT_MS,
        )
        .map_err(|_| IMAGE_ERROR_REMOTE_FAILED.to_string())?;
    }

    let host_wide = wide_null(host);
    let connection =
        WinHttpHandle(unsafe { WinHttpConnect(session.0, PCWSTR(host_wide.as_ptr()), port, 0) });
    if connection.0.is_null() {
        return Err(IMAGE_ERROR_REMOTE_FAILED.into());
    }

    let verb = wide_null("GET");
    let target_wide = wide_null(&target);
    let request = WinHttpHandle(unsafe {
        WinHttpOpenRequest(
            connection.0,
            PCWSTR(verb.as_ptr()),
            PCWSTR(target_wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            if secure {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        )
    });
    if request.0.is_null() {
        return Err(IMAGE_ERROR_REMOTE_FAILED.into());
    }

    unsafe {
        WinHttpSendRequest(request.0, None, None, 0, 0, 0)
            .map_err(|_| IMAGE_ERROR_REMOTE_FAILED.to_string())?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut())
            .map_err(|_| IMAGE_ERROR_REMOTE_FAILED.to_string())?;
    }

    let mut status: u32 = 0;
    let mut status_size = std::mem::size_of::<u32>() as u32;
    let mut header_index: u32 = 0;
    unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut std::ffi::c_void),
            &mut status_size,
            &mut header_index,
        )
        .map_err(|_| IMAGE_ERROR_REMOTE_FAILED.to_string())?;
    }
    if status != 200 {
        return Err(IMAGE_ERROR_REMOTE_FAILED.into());
    }

    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let mut read: u32 = 0;
        unsafe {
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr() as *mut std::ffi::c_void,
                chunk.len() as u32,
                &mut read,
            )
            .map_err(|_| IMAGE_ERROR_REMOTE_FAILED.to_string())?;
        }

        if read == 0 {
            break;
        }

        bytes.extend_from_slice(&chunk[..read as usize]);
        // Checked while reading, not after: a server that keeps sending must
        // not be able to fill memory first and be rejected second.
        if bytes.len() as u64 > MAX_LOCAL_IMAGE_SIZE_BYTES {
            return Err(IMAGE_ERROR_TOO_LARGE.into());
        }
    }

    Ok(bytes)
}

fn selected_dialog_path(
    window: &tauri::Window,
    title: &str,
    initial_directory: Option<&Path>,
    initial_file_name: Option<&str>,
    save: bool,
    filter: &[u16],
) -> Result<Option<PathBuf>, String> {
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let title = wide_null(title);
    let default_ext = wide_null("md");
    let initial_directory = initial_directory.map(|path| wide_null(&path.to_string_lossy()));
    let mut file_buffer = vec![0u16; 32768];

    if let Some(initial_file_name) = initial_file_name {
        let initial_file_name = wide_null(initial_file_name);
        let copy_len = initial_file_name.len().min(file_buffer.len());
        file_buffer[..copy_len].copy_from_slice(&initial_file_name[..copy_len]);
    }

    let mut dialog = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner,
        lpstrFilter: PCWSTR(filter.as_ptr()),
        lpstrFile: PWSTR(file_buffer.as_mut_ptr()),
        nMaxFile: file_buffer.len() as u32,
        lpstrInitialDir: initial_directory
            .as_ref()
            .map(|path| PCWSTR(path.as_ptr()))
            .unwrap_or_else(PCWSTR::null),
        lpstrTitle: PCWSTR(title.as_ptr()),
        lpstrDefExt: PCWSTR(default_ext.as_ptr()),
        Flags: OFN_EXPLORER | OFN_HIDEREADONLY | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST,
        ..Default::default()
    };

    if save {
        dialog.Flags |= OFN_OVERWRITEPROMPT;
    } else {
        dialog.Flags |= OFN_FILEMUSTEXIST;
    }

    let accepted = unsafe {
        if save {
            GetSaveFileNameW(&mut dialog)
        } else {
            GetOpenFileNameW(&mut dialog)
        }
    };

    if accepted.as_bool() {
        let end = file_buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(file_buffer.len());
        let path = String::from_utf16_lossy(&file_buffer[..end]);
        return Ok(Some(PathBuf::from(path)));
    }

    let error = unsafe { CommDlgExtendedError() };
    if error.0 == 0 {
        Ok(None)
    } else {
        Err(format!("Native file dialog failed with code {}.", error.0))
    }
}

#[tauri::command]
fn get_initial_file(
    webview: WebviewWindow,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    pending: tauri::State<'_, PendingMarkdownFiles>,
) -> Result<Option<PreflightFile>, String> {
    require_main_webview(&webview)?;
    let Some(path) = arg_markdown_path() else {
        return Ok(None);
    };

    let path = authorize_path(&paths, &path)?;
    prepare_file(&path, &pending).map(Some)
}

#[tauri::command]
fn read_markdown_file(
    webview: WebviewWindow,
    path: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    pending: tauri::State<'_, PendingMarkdownFiles>,
) -> Result<PreflightFile, String> {
    require_main_webview(&webview)?;
    let path = require_authorized_path(&paths, Path::new(&path))?;
    prepare_file(&path, &pending)
}

#[tauri::command]
fn confirm_markdown_preflight(
    webview: WebviewWindow,
    token: String,
    pending: tauri::State<'_, PendingMarkdownFiles>,
) -> Result<LoadedFile, String> {
    require_main_webview(&webview)?;
    let mut files = pending
        .files
        .lock()
        .map_err(|_| "Pending Markdown state is unavailable.".to_string())?;
    let now = Instant::now();
    files.retain(|_, value| value.expires_at > now);
    files
        .remove(&token)
        .map(|value| value.loaded)
        .ok_or_else(|| "This Markdown opening request has expired or was already used.".to_string())
}

#[tauri::command]
fn cancel_markdown_preflight(
    webview: WebviewWindow,
    token: String,
    pending: tauri::State<'_, PendingMarkdownFiles>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    pending
        .files
        .lock()
        .map_err(|_| "Pending Markdown state is unavailable.".to_string())?
        .remove(&token);
    Ok(())
}

#[tauri::command]
fn file_metadata(
    webview: WebviewWindow,
    path: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
) -> Result<FileMetadata, String> {
    require_main_webview(&webview)?;
    let path = require_authorized_path(&paths, Path::new(&path))?;

    Ok(FileMetadata {
        modified_ms: file_modified_ms(&path)?,
    })
}

#[tauri::command]
fn open_markdown_dialog(
    webview: WebviewWindow,
    window: tauri::Window,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    pending: tauri::State<'_, PendingMarkdownFiles>,
) -> Result<Option<PreflightFile>, String> {
    require_main_webview(&webview)?;
    let Some(path) = selected_dialog_path(&window, "Open Markdown", None, None, false, &wide_filter())?
    else {
        return Ok(None);
    };

    let path = authorize_path(&paths, &path)?;
    prepare_file(&path, &pending).map(Some)
}

#[tauri::command]
fn write_markdown_file(
    webview: WebviewWindow,
    path: String,
    content: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
) -> Result<LoadedFile, String> {
    require_main_webview(&webview)?;
    let path = require_authorized_path(&paths, Path::new(&path))?;

    ensure_markdown_content_size(&content)?;
    fs::write(&path, &content).map_err(|error| error.to_string())?;
    loaded_file(&path, content, file_modified_ms(&path)?)
}

#[tauri::command]
fn save_markdown_dialog(
    webview: WebviewWindow,
    window: tauri::Window,
    current_path: Option<String>,
    content: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
) -> Result<Option<LoadedFile>, String> {
    require_main_webview(&webview)?;
    let current_path = current_path.map(PathBuf::from);
    let file_name = current_path
        .as_deref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("notes.md");
    let initial_directory = current_path
        .as_deref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf);
    let Some(mut path) = selected_dialog_path(
        &window,
        "Save Markdown",
        initial_directory.as_deref(),
        Some(file_name),
        true,
        &wide_filter(),
    )?
    else {
        return Ok(None);
    };

    if path.extension().is_none() {
        path.set_extension("md");
    }

    let path = authorize_path(&paths, &path)?;
    ensure_markdown_content_size(&content)?;
    fs::write(&path, &content).map_err(|error| error.to_string())?;
    loaded_file(&path, content, file_modified_ms(&path)?).map(Some)
}

#[tauri::command]
fn set_window_title<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    title: String,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.set_title(&title).map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main_window<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_main_window<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    close_request: tauri::State<'_, CloseRequestState>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    close_request.0.store(true, Ordering::SeqCst);
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_main_window<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize_main_window<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };

    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }

    Ok(!maximized)
}

#[tauri::command]
fn is_main_window_maximized<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };

    window.is_maximized().map_err(|error| error.to_string())
}

/// Hands the drag off to the OS so the custom titlebar moves the window and
/// keeps Windows' own snap-to-edge behaviour.
#[tauri::command]
fn start_window_drag<R: Runtime>(
    webview: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_external_url(webview: WebviewWindow, url: String) -> Result<(), String> {
    require_main_webview(&webview)?;
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https links can be opened.".into());
    }

    // The parsed form, not the string that arrived. Parsing accepts input that
    // it has to encode on the way in — a raw quote, a tab, a leading space — and
    // handing the original on would mean opening something other than what was
    // checked, and other than what the confirmation dialog showed.
    spawn_hidden_command(Command::new("explorer.exe").arg(parsed.as_str()))
}

#[tauri::command]
fn read_local_image(
    webview: WebviewWindow,
    document_path: String,
    image_source: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    folders: tauri::State<'_, AuthorizedImageFolders>,
) -> Result<tauri::ipc::Response, String> {
    require_main_webview(&webview)?;
    let document_path = require_authorized_path(&paths, Path::new(&document_path))
        .map_err(|_| IMAGE_ERROR_UNAUTHORIZED.to_string())?;
    let image_folder = authorized_image_folder(&folders, &document_path)?;
    let image_path =
        resolve_local_image_path(&document_path, image_folder.as_deref(), &image_source)?;
    let metadata = fs::metadata(&image_path).map_err(|_| IMAGE_ERROR_MISSING.to_string())?;
    if !metadata.is_file() {
        return Err(IMAGE_ERROR_MISSING.into());
    }
    if metadata.len() > MAX_LOCAL_IMAGE_SIZE_BYTES {
        return Err(IMAGE_ERROR_TOO_LARGE.into());
    }

    let bytes = fs::read(&image_path).map_err(|_| IMAGE_ERROR_MISSING.to_string())?;
    if local_image_mime(&image_path, &bytes).is_none() {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }
    ensure_local_image_dimensions(&bytes)?;

    Ok(tauri::ipc::Response::new(bytes))
}

/// A `data:` image carries its own bytes, so no path is authorized and no file
/// is touched. Rust still decodes and validates it so every image the WebView
/// displays has passed the same checks and arrives the same way: as bytes that
/// the frontend turns into a Blob URL.
#[tauri::command]
fn read_data_image(
    webview: WebviewWindow,
    image_source: String,
) -> Result<tauri::ipc::Response, String> {
    require_main_webview(&webview)?;
    let bytes = decode_data_image(&image_source)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Widens image access for one document to a second folder. The user picks an
/// image inside that folder in the native dialog; the app tells them the whole
/// folder is what gets allowed before the dialog opens.
#[tauri::command]
fn choose_image_folder(
    webview: WebviewWindow,
    window: tauri::Window,
    document_path: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    folders: tauri::State<'_, AuthorizedImageFolders>,
) -> Result<Option<String>, String> {
    require_main_webview(&webview)?;
    let document_path = require_authorized_path(&paths, Path::new(&document_path))?;
    let initial_directory = document_path.parent().map(Path::to_path_buf);
    let Some(selected) = selected_dialog_path(
        &window,
        "Select an image from the folder to allow",
        initial_directory.as_deref(),
        None,
        false,
        &wide_image_filter(),
    )?
    else {
        return Ok(None);
    };

    let folder = selected
        .parent()
        .ok_or(IMAGE_ERROR_MISSING)?
        .canonicalize()
        .map_err(|_| IMAGE_ERROR_MISSING.to_string())?;

    folders
        .0
        .lock()
        .map_err(|_| "Image folder authorization state is unavailable.".to_string())?
        .insert(document_path, folder.clone());

    Ok(Some(folder.to_string_lossy().to_string()))
}

/// Whether the document names this URL, rather than merely containing its
/// characters somewhere.
///
/// A bare substring search was not enough in either direction. An ordinary link
/// such as `https://example.com/r?to=https://elsewhere.example/pixel.png` contains
/// the second URL, which made that second host approvable although nobody wrote
/// it down as an image source; and a document naming `https://host/pixel.png.bak`
/// made `https://host/pixel.png` approvable the same way. Requiring a delimiter on
/// both sides closes both: the match has to stand on its own.
fn document_names_url(content: &str, source: &str) -> bool {
    fn is_boundary(symbol: char) -> bool {
        symbol.is_whitespace() || matches!(symbol, '(' | ')' | '<' | '>' | '"' | '\'' | '|')
    }

    content.match_indices(source).any(|(at, _)| {
        content[..at].chars().next_back().is_none_or(is_boundary)
            && content[at + source.len()..]
                .chars()
                .next()
                .is_none_or(is_boundary)
    })
}

fn is_remote_image_url(source: &str) -> bool {
    url::Url::parse(source).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// Records the remote images the user approved for one document.
///
/// The URLs are not taken on trust. Each one has to appear verbatim in the
/// document as it is on disk, so a WebView that has been taken over cannot name
/// a destination the document does not already contain — which is what keeps
/// this from becoming a way to send anything out.
#[tauri::command]
fn allow_remote_images(
    webview: WebviewWindow,
    document_path: String,
    sources: Vec<String>,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    allowed: tauri::State<'_, AllowedRemoteImages>,
) -> Result<Vec<String>, String> {
    require_main_webview(&webview)?;
    let document_path = require_authorized_path(&paths, Path::new(&document_path))?;
    let content =
        fs::read_to_string(&document_path).map_err(|_| IMAGE_ERROR_MISSING.to_string())?;

    let mut store = allowed
        .0
        .lock()
        .map_err(|_| "Remote image authorization state is unavailable.".to_string())?;
    let approved = store.entry(document_path).or_default();
    for source in sources {
        if is_remote_image_url(&source) && document_names_url(&content, &source) {
            approved.insert(source);
        }
    }

    // The whole approved set, not what this call added: the frontend then holds
    // exactly what the native side will honour, with nothing to drift apart.
    Ok(approved.iter().cloned().collect())
}

#[tauri::command]
fn fetch_remote_image(
    webview: WebviewWindow,
    document_path: String,
    image_source: String,
    paths: tauri::State<'_, AuthorizedMarkdownPaths>,
    allowed: tauri::State<'_, AllowedRemoteImages>,
) -> Result<tauri::ipc::Response, String> {
    require_main_webview(&webview)?;
    let document_path = require_authorized_path(&paths, Path::new(&document_path))
        .map_err(|_| IMAGE_ERROR_UNAUTHORIZED.to_string())?;
    if !remote_image_is_allowed(&allowed, &document_path, &image_source)? {
        return Err(IMAGE_ERROR_REMOTE_BLOCKED.into());
    }
    if !is_remote_image_url(&image_source) {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }

    let url = url::Url::parse(&image_source).map_err(|_| IMAGE_ERROR_UNSUPPORTED.to_string())?;
    let bytes = fetch_remote_image_bytes(&url)?;
    // Same checks a file from disk gets. A server that answers with something
    // other than a supported raster image is a failure, not a special case.
    if image_mime_from_bytes(&bytes).is_none() {
        return Err(IMAGE_ERROR_UNSUPPORTED.into());
    }
    ensure_local_image_dimensions(&bytes)?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn clear_remote_images(
    webview: WebviewWindow,
    document_path: String,
    allowed: tauri::State<'_, AllowedRemoteImages>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let key = canonical_markdown_path(Path::new(&document_path))?;
    allowed
        .0
        .lock()
        .map_err(|_| "Remote image authorization state is unavailable.".to_string())?
        .remove(&key);
    Ok(())
}

/// Called when the document leaves extended mode or its tab closes. Giving
/// access up needs no authorization, so a path that no longer resolves is
/// still accepted as a key.
#[tauri::command]
fn clear_image_folder(
    webview: WebviewWindow,
    document_path: String,
    folders: tauri::State<'_, AuthorizedImageFolders>,
) -> Result<(), String> {
    require_main_webview(&webview)?;
    let key = canonical_markdown_path(Path::new(&document_path))?;
    folders
        .0
        .lock()
        .map_err(|_| "Image folder authorization state is unavailable.".to_string())?
        .remove(&key);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(CloseRequestState(Arc::new(AtomicBool::new(false))))
        .manage(AuthorizedMarkdownPaths(Mutex::new(HashSet::new())))
        .manage(AuthorizedImageFolders(Mutex::new(HashMap::new())))
        .manage(AllowedRemoteImages(Mutex::new(HashMap::new())))
        .manage({
            let pending = PendingMarkdownFiles::new();
            start_pending_markdown_cleanup(Arc::clone(&pending.files));
            pending
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            if let Some(path) = markdown_path_from_args(args) {
                let _ = authorize_path(&app.state::<AuthorizedMarkdownPaths>(), &path);
                let _ = app.emit("open-file-requested", path.to_string_lossy().to_string());
            }
        }))
        .setup(move |app| {
            let main_handle = app.handle().clone();
            // Attempted twice. Why one retry helps is not recorded anywhere, and
            // the two attempts were byte-identical copies of each other; keeping
            // them as one call at least guarantees they stay that way. Drop the
            // retry once someone can say what it was for.
            let build_main_window = || {
                WebviewWindowBuilder::new(
                    &main_handle,
                    "main",
                    WebviewUrl::App("index.html".into()),
                )
                .title("PureMD")
                .inner_size(980.0, 720.0)
                .min_inner_size(520.0, 420.0)
                .center()
                .decorations(false)
                .visible(false)
                .data_directory(webview_data_dir())
                .on_navigation(is_allowed_navigation_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()
            };

            if let Ok(window) = build_main_window().or_else(|_| build_main_window()) {
                restore_window_state(&window);

                let tracked_window = window.clone();
                let close_request = app.state::<CloseRequestState>().0.clone();
                let close_app = app.handle().clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        let _ = save_window_state(&tracked_window);
                        // the custom titlebar swaps its maximize glyph on this
                        let _ = tracked_window.emit(
                            "window-maximized",
                            tracked_window.is_maximized().unwrap_or(false),
                        );
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        let _ = save_window_state(&tracked_window);
                        if close_request.swap(false, Ordering::SeqCst) {
                            return;
                        }

                        api.prevent_close();
                        let _ = close_app.emit("close-requested", ());
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            file_metadata,
            open_markdown_dialog,
            read_markdown_file,
            confirm_markdown_preflight,
            cancel_markdown_preflight,
            save_markdown_dialog,
            write_markdown_file,
            set_window_title,
            show_main_window,
            close_main_window,
            minimize_main_window,
            toggle_maximize_main_window,
            is_main_window_maximized,
            start_window_drag,
            open_external_url,
            read_local_image,
            read_data_image,
            choose_image_folder,
            clear_image_folder,
            allow_remote_images,
            fetch_remote_image,
            clear_remote_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running PureMD");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_flags_raw_html_and_event_handlers() {
        let findings = scan_markdown(b"<script>x</script>\n<img onerror=alert(1)>");
        assert_eq!(findings.raw_html, 2);
    }

    #[test]
    fn preflight_detects_existing_dangerous_fixture() {
        let findings = scan_markdown(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-files/dangerous-markdown-fixtures.md"
        )));
        assert!(findings.raw_html > 0);
        assert!(findings.unsafe_uri > 0);
        assert!(findings.remote_images > 0);
    }

    #[test]
    fn preflight_flags_unsafe_uri_schemes_case_insensitively() {
        let findings =
            scan_markdown(b"[x](JaVaScRiPt:alert(1)) data:text/plain,x FILE:///C:/x vbscript:x");
        assert_eq!(findings.unsafe_uri, 4);
    }

    #[test]
    fn preflight_ignores_uri_examples_in_code_but_flags_a_real_link() {
        let findings = scan_markdown(
            b"`javascript:alert(1)`\n```md\n[data](data:text/plain,x)\n```\n[x](javascript:alert(1))",
        );

        assert_eq!(findings.unsafe_uri, 1);
    }

    #[test]
    fn preflight_keeps_testing_guide_quiet() {
        let findings = scan_markdown(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../TESTING.md"
        )));

        assert_eq!(findings.unsafe_uri, 0);
    }

    #[test]
    fn preflight_flags_remote_images_but_not_an_https_link() {
        let findings =
            scan_markdown(b"[site](https://example.com)\n![image](https://example.com/image.png)");
        assert_eq!(findings.remote_images, 1);
        assert_eq!(findings.excessive_links, 0);
    }

    #[test]
    fn preflight_flags_large_data_uri() {
        let mut input = b"![x](data:image/png;base64,".to_vec();
        input.extend(std::iter::repeat_n(b'A', LARGE_DATA_URI_BYTES + 1));
        input.push(b')');
        let findings = scan_markdown(&input);
        assert_eq!(findings.large_data_uri, 1);
    }

    #[test]
    fn preflight_flags_long_lines_and_excessive_links_and_images() {
        let mut input = vec![b'a'; LONG_LINE_BYTES + 1];
        for _ in 0..=EXCESSIVE_LINKS {
            input.extend_from_slice(b"[x](https://example.com)\n");
        }
        for _ in 0..=EXCESSIVE_IMAGES {
            input.extend_from_slice(b"![x](https://example.com/image.png)\n");
        }
        let findings = scan_markdown(&input);
        assert_eq!(findings.long_lines, 1);
        assert!(findings.excessive_links > EXCESSIVE_LINKS);
        assert!(findings.excessive_images > EXCESSIVE_IMAGES);
    }

    #[test]
    fn preflight_keeps_normal_markdown_quiet() {
        let findings = scan_markdown(b"# Notes\n\nA normal [HTTPS link](https://example.com).\n");
        assert_eq!(findings.raw_html, 0);
        assert_eq!(findings.unsafe_uri, 0);
        assert_eq!(findings.remote_images, 0);
        assert_eq!(findings.large_data_uri, 0);
        assert_eq!(findings.long_lines, 0);
        assert_eq!(findings.excessive_links, 0);
        assert_eq!(findings.excessive_images, 0);
    }

    #[test]
    fn preflight_scans_a_large_allowed_buffer_in_one_call() {
        let input = vec![b'a'; MAX_MARKDOWN_FILE_SIZE_BYTES as usize];
        let findings = scan_markdown(&input);
        assert_eq!(findings.long_lines, 1);
        assert_eq!(findings.unsafe_uri, 0);
    }

    /// The shape that used to take 25 seconds at the file-size limit, while the
    /// uniform buffer above stayed at 80 ms. A run of backticks only re-read the
    /// rest of its line when it found no partner, so a line whose runs all have
    /// distinct lengths made every one of them do it. Preflight runs before the
    /// window is shown, so this was a hostile document holding the application
    /// off the screen, not merely a slow scan.
    #[test]
    fn preflight_scans_an_adversarial_buffer_without_stalling() {
        // Two documents of the same size: ordinary prose, and one whose backtick
        // runs all have distinct lengths so that none of them ever finds a
        // partner. The scan used to be about 1300 times slower on the second.
        //
        // The assertion compares the two rather than naming a wall-clock bound,
        // because the absolute number moves by two orders of magnitude between a
        // debug and a release build. What has to hold is that the shape of the
        // document barely matters, and that survives the build profile.
        const SIZE: usize = 8 * 1024 * 1024;

        let mut ordinary = Vec::with_capacity(SIZE);
        while ordinary.len() < SIZE {
            ordinary.extend_from_slice(b"Some ordinary paragraph text with `code` in it.\n");
        }
        ordinary.truncate(SIZE);

        let mut adversarial = Vec::with_capacity(SIZE);
        let mut run = 1usize;
        while adversarial.len() + run < SIZE {
            adversarial.extend(std::iter::repeat_n(b'`', run));
            adversarial.push(b'x');
            run += 1;
        }
        adversarial.resize(SIZE, b'x');

        let started = Instant::now();
        scan_markdown(&ordinary);
        let baseline = started.elapsed();

        let started = Instant::now();
        let findings = scan_markdown(&adversarial);
        let hostile = started.elapsed();

        assert_eq!(findings.unsafe_uri, 0);
        assert!(
            hostile < baseline * 10,
            "adversarial preflight took {hostile:?}, against {baseline:?} for ordinary text of the same size"
        );
    }

    #[test]
    fn preflight_tokens_are_unique_and_unpredictable_length() {
        let first = preflight_token().unwrap();
        let second = preflight_token().unwrap();

        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "puremd-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// A real 1×1 transparent PNG, so `imagesize` has an IHDR to read.
    const PIXEL_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn local_images_accept_supported_files_below_the_document_directory() {
        let root = temp_root("local-image");
        let assets = root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let document = root.join("document.md");
        let image = assets.join("pixel.png");
        fs::write(&document, "![pixel](assets/pixel.png)").unwrap();
        fs::write(&image, b"\x89PNG\r\n\x1a\ncontent").unwrap();

        let resolved = resolve_local_image_path(&document, None, "assets/pixel.png").unwrap();
        let bytes = fs::read(&resolved).unwrap();

        assert_eq!(resolved, image.canonicalize().unwrap());
        assert_eq!(local_image_mime(&resolved, &bytes), Some("image/png"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_images_reject_encoded_parent_traversal_and_remote_urls() {
        let root = temp_root("local-image-boundary");
        let documents = root.join("documents");
        fs::create_dir_all(&documents).unwrap();
        let document = documents.join("document.md");
        fs::write(&document, "document").unwrap();
        fs::write(root.join("secret.png"), b"\x89PNG\r\n\x1a\nsecret").unwrap();

        assert!(resolve_local_image_path(&document, None, "%2e%2e/secret.png").is_err());
        assert!(resolve_local_image_path(&document, None, "https://example.com/pixel.png").is_err());
        assert!(resolve_local_image_path(&document, None, "data:image/png;base64,AAAA").is_err());
        // Site-root-relative on Windows is rooted but not absolute, so it would
        // otherwise resolve against the drive root.
        assert_eq!(
            resolve_local_image_path(&document, None, "/secret.png").unwrap_err(),
            IMAGE_ERROR_UNSUPPORTED
        );
        assert_eq!(
            resolve_local_image_path(&document, None, "\\secret.png").unwrap_err(),
            IMAGE_ERROR_UNSUPPORTED
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_authorized_image_folder_opens_that_folder_and_nothing_around_it() {
        let root = temp_root("image-folder");
        let documents = root.join("documents");
        let assets = root.join("assets");
        fs::create_dir_all(&documents).unwrap();
        fs::create_dir_all(&assets).unwrap();
        let document = documents.join("document.md");
        fs::write(&document, "![logo](../assets/logo.png)").unwrap();
        fs::write(assets.join("logo.png"), b"\x89PNG\r\n\x1a\ncontent").unwrap();
        fs::write(root.join("secret.png"), b"\x89PNG\r\n\x1a\nsecret").unwrap();
        let assets = assets.canonicalize().unwrap();

        assert_eq!(
            resolve_local_image_path(&document, None, "../assets/logo.png").unwrap_err(),
            IMAGE_ERROR_OUTSIDE_FOLDER
        );
        assert_eq!(
            resolve_local_image_path(&document, Some(&assets), "../assets/logo.png").unwrap(),
            assets.join("logo.png").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_local_image_path(&document, Some(&assets), "../secret.png").unwrap_err(),
            IMAGE_ERROR_OUTSIDE_FOLDER
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_window_restored_off_every_screen_is_rejected() {
        let left = (0, 0, 1920, 1080);
        let right = (1920, 0, 1920, 1080);

        assert!(window_fits_screen((100, 100, 1200, 800), left));
        assert!(window_fits_screen((2200, 60, 1200, 800), right));
        // Straddling the two is still fine.
        assert!(window_fits_screen((1800, 100, 1200, 800), left));
        // What Windows records for a minimized window.
        assert!(!window_fits_screen((-32000, -32000, 536, 429), left));
        assert!(!window_fits_screen((-32000, -32000, 536, 429), right));
        // A sliver too thin to aim at does not count as visible.
        assert!(!window_fits_screen((-1180, 100, 1200, 800), left));
    }

    #[test]
    fn remote_image_urls_accept_only_plain_http_and_https() {
        assert!(is_remote_image_url("https://example.com/badge.png"));
        assert!(is_remote_image_url("http://example.com/shot.png"));
        // Credentials in the URL, non-web schemes, and relative paths never
        // reach the fetcher.
        assert!(!is_remote_image_url("https://user:secret@example.com/x.png"));
        assert!(!is_remote_image_url("https://user@example.com/x.png"));
        assert!(!is_remote_image_url("file:///C:/Windows/win.ini"));
        assert!(!is_remote_image_url("data:image/png;base64,AAAA"));
        assert!(!is_remote_image_url("assets/pixel.png"));
    }

    #[test]
    fn a_url_counts_as_named_only_when_the_document_names_it_whole() {
        let document = "\
![badge](https://example.com/badge.png)
<img src=\"https://example.com/shot.png\">
See [the redirect](https://example.com/r?to=https://elsewhere.example/pixel.png).
A backup at https://example.com/badge.png.bak too.
";

        // What the document actually offers as an image source.
        assert!(document_names_url(document, "https://example.com/badge.png"));
        assert!(document_names_url(document, "https://example.com/shot.png"));

        // Nested inside another URL's query: present as characters, never named.
        assert!(!document_names_url(
            document,
            "https://elsewhere.example/pixel.png"
        ));
        // A prefix of a longer URL, which a substring search also used to accept.
        assert!(!document_names_url(document, "https://example.com/badge.png.b"));
        assert!(!document_names_url(document, "https://example.com/sho"));
        // Absent entirely.
        assert!(!document_names_url(document, "https://evil.example/x.png"));

        // A bare URL on its own line, and one at the very end without a newline.
        assert!(document_names_url(
            "https://example.com/a.png",
            "https://example.com/a.png"
        ));
    }

    #[test]
    fn base64_decoding_is_strict_about_the_alphabet_and_the_padding() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVs\n bG8=").unwrap(), b"hello");
        assert!(decode_base64("aGVsbG8").is_err());
        assert!(decode_base64("aGVsbG8_").is_err());
        assert!(decode_base64("aG=sbG8=").is_err());
    }

    #[test]
    fn data_images_accept_a_matching_type_and_reject_everything_else() {
        let png = format!("data:image/png;base64,{PIXEL_PNG_BASE64}");
        assert_eq!(
            image_mime_from_bytes(&decode_data_image(&png).unwrap()),
            Some("image/png")
        );

        // A type the bytes do not back, a format that is not raster at all,
        // and a URI that is not base64 to begin with.
        assert_eq!(
            decode_data_image(&format!("data:image/gif;base64,{PIXEL_PNG_BASE64}")).unwrap_err(),
            IMAGE_ERROR_UNSUPPORTED
        );
        assert_eq!(
            decode_data_image("data:image/svg+xml;base64,PHN2Zy8+").unwrap_err(),
            IMAGE_ERROR_UNSUPPORTED
        );
        assert_eq!(
            decode_data_image("data:image/png,%89PNG").unwrap_err(),
            IMAGE_ERROR_UNSUPPORTED
        );
    }

    #[test]
    fn local_images_reject_svg_and_extension_content_mismatches() {
        assert_eq!(local_image_mime(Path::new("image.svg"), b"<svg/>"), None);
        assert_eq!(
            local_image_mime(Path::new("not-really.png"), b"GIF89acontent"),
            None
        );
    }

    #[test]
    fn local_images_reject_excessive_decoded_dimensions() {
        fn png_header(width: u32, height: u32) -> Vec<u8> {
            let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
            bytes.extend_from_slice(&width.to_be_bytes());
            bytes.extend_from_slice(&height.to_be_bytes());
            bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
            bytes
        }

        assert!(ensure_local_image_dimensions(&png_header(1, 1)).is_ok());
        assert!(ensure_local_image_dimensions(&png_header(10_000, 10_000)).is_err());
    }

    #[test]
    fn navigation_guard_allows_app_pages_and_rejects_external_sites() {
        assert!(is_allowed_navigation_url(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(is_allowed_navigation_url(
            &url::Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(!is_allowed_navigation_url(
            &url::Url::parse("https://example.com/").unwrap()
        ));
    }

    #[test]
    fn expired_pending_markdown_is_removed() {
        let pending = PendingMarkdownFiles::new();
        pending.files.lock().unwrap().insert(
            "expired".into(),
            PendingMarkdown {
                loaded: LoadedFile {
                    path: "expired.md".into(),
                    name: "expired.md".into(),
                    content: "expired".into(),
                    modified_ms: 0,
                },
                expires_at: Instant::now() - Duration::from_secs(1),
            },
        );

        pending.remove_expired().unwrap();

        assert!(pending.files.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_markdown_limit_is_enforced() {
        let pending = PendingMarkdownFiles::new();
        for index in 0..MAX_PENDING_MARKDOWN_FILES {
            pending
                .insert(
                    index.to_string(),
                    LoadedFile {
                        path: format!("{index}.md"),
                        name: format!("{index}.md"),
                        content: "pending".into(),
                        modified_ms: 0,
                    },
                )
                .unwrap();
        }

        assert!(matches!(
            pending.insert(
                "overflow".into(),
                LoadedFile {
                    path: "overflow.md".into(),
                    name: "overflow.md".into(),
                    content: "pending".into(),
                    modified_ms: 0,
                },
            ),
            Err(message) if message.contains("Too many")
        ));
    }

    #[test]
    fn rejects_markdown_symlink_to_non_markdown_target() {
        use std::os::windows::fs::symlink_file;

        let root =
            std::env::temp_dir().join(format!("puremd-path-guard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let target = root.join("target.txt");
        let link = root.join("document.md");
        fs::write(&target, "not Markdown").unwrap();
        symlink_file(&target, &link).unwrap();

        assert!(canonical_markdown_path(&link).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_markdown_file_larger_than_limit() {
        let path = std::env::temp_dir().join(format!(
            "puremd-too-large-{}-{}.md",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_MARKDOWN_FILE_SIZE_BYTES + 1)
            .unwrap();

        let pending = PendingMarkdownFiles::new();
        assert!(
            matches!(prepare_file(&path, &pending), Err(message) if message.contains("larger than"))
        );

        fs::remove_file(path).unwrap();
    }
}
