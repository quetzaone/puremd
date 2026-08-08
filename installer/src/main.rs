// PureMD setup: a frameless WebView2 window in front of a silent NSIS install.
// The NSIS installer still does the real work — files, registry, shortcuts,
// uninstall entry, .md association. This binary only owns the window.
#![windows_subsystem = "windows"]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::{fs, io, thread};

use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const SETUP: &[u8] = include_bytes!("../payload/setup.exe");
const HTML: &str = include_str!("../ui/index.html");
const FONTS: &str = include_str!(concat!(env!("OUT_DIR"), "/fonts.css"));

const APP_EXE: &str = "puremd.exe";
const LICENSE_URL: &str = "https://github.com/quetzaone/puremd/blob/main/LICENSE";

// ponytail: measured from a real install (puremd.exe + uninstall.exe ≈ 8.8 MB).
// Revisit if the bundle ever grows a resources folder.
const INSTALL_MB: u64 = 9;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

enum Msg {
    Drag,
    Minimize,
    Close,
    Pick,
    License,
    Install,
    Abort,
    Launch,
    Phase(usize),
    Done,
    Failed(i32),
}

fn main() -> wry::Result<()> {
    let mut path = default_dir();

    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("PureMD Setup")
        .with_inner_size(LogicalSize::new(600.0, 420.0))
        .with_resizable(false)
        .with_maximizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .with_visible(false)
        .build(&event_loop)
        .expect("window");

    round_corners(&window);
    center(&window);

    let ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_html(page(&path))
        .with_background_color((13, 18, 25, 255))
        .with_ipc_handler(move |req| {
            let msg = match req.body().as_str() {
                "drag" => Msg::Drag,
                "minimize" => Msg::Minimize,
                "close" => Msg::Close,
                "pick" => Msg::Pick,
                "license" => Msg::License,
                "install" => Msg::Install,
                "abort" => Msg::Abort,
                "launch" => Msg::Launch,
                _ => return,
            };
            let _ = ipc.send_event(msg);
        })
        .build(&window)?;

    window.set_visible(true);
    window.set_focus();

    let mut aborted: Option<Arc<AtomicBool>> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit
            }
            Event::UserEvent(msg) => match msg {
                Msg::Drag => {
                    let _ = window.drag_window();
                }
                Msg::Minimize => window.set_minimized(true),
                Msg::Close => *control_flow = ControlFlow::Exit,
                Msg::License => open_url(LICENSE_URL),
                Msg::Pick => {
                    if let Some(picked) = rfd::FileDialog::new()
                        .set_directory(nearest_existing(&path))
                        .pick_folder()
                    {
                        // Installing straight into a shared folder would scatter
                        // files through it, so keep our own subfolder.
                        path = if picked.file_name().map(|n| n == "PureMD").unwrap_or(false) {
                            picked
                        } else {
                            picked.join("PureMD")
                        };
                        let _ = webview
                            .evaluate_script(&format!("setPath({})", js(&path.display().to_string())));
                    }
                }
                Msg::Install => {
                    let flag = Arc::new(AtomicBool::new(false));
                    aborted = Some(flag.clone());
                    let (dir, tx) = (path.clone(), proxy.clone());
                    thread::spawn(move || install(dir, tx, flag));
                }
                Msg::Abort => {
                    if let Some(flag) = &aborted {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
                Msg::Launch => {
                    let _ = Command::new(path.join(APP_EXE)).spawn();
                    *control_flow = ControlFlow::Exit;
                }
                Msg::Phase(n) => {
                    let _ = webview.evaluate_script(&format!("setPhase({n})"));
                }
                Msg::Done => {
                    let _ = webview.evaluate_script("setDone()");
                }
                Msg::Failed(code) => {
                    let (label, denied) = code_label(code);
                    let _ = webview
                        .evaluate_script(&format!("setFailed({}, {denied})", js(&label)));
                }
            },
            _ => {}
        }
    });
}

/// Runs the bundled NSIS installer silently and reports what can actually be
/// observed. There is no progress percentage to report — see `installing` in
/// the design notes.
fn install(dir: PathBuf, proxy: EventLoopProxy<Msg>, aborted: Arc<AtomicBool>) {
    let existed = dir.exists();
    let exe = dir.join(APP_EXE);
    let lnk = start_menu_lnk();
    // Only a marker that is missing right now can later prove a phase finished.
    // On a reinstall both are already there, so the phase list simply stays put
    // rather than advancing on a lie.
    let watch_exe = !exe.exists();
    let watch_lnk = !lnk.exists();

    let tmp = std::env::temp_dir().join("puremd-setup.exe");
    if let Err(e) = fs::write(&tmp, SETUP) {
        let _ = proxy.send_event(Msg::Failed(os_code(&e)));
        return;
    }

    let mut cmd = Command::new(&tmp);
    cmd.arg("/S").creation_flags(CREATE_NO_WINDOW);
    // NSIS requires /D last, unquoted, spaces and all — raw_arg is the only way
    // to get that past Rust's argument escaping.
    cmd.raw_arg(format!("/D={}", dir.display()));

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            let _ = proxy.send_event(Msg::Failed(os_code(&e)));
            return;
        }
    };

    let mut phase = 0usize;
    loop {
        if aborted.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            rollback(&dir, existed);
            let _ = fs::remove_file(&tmp);
            return;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = fs::remove_file(&tmp);
                let _ = proxy.send_event(if status.success() {
                    Msg::Done
                } else {
                    Msg::Failed(status.code().unwrap_or(-1))
                });
                return;
            }
            Ok(None) => {}
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                let _ = proxy.send_event(Msg::Failed(os_code(&e)));
                return;
            }
        }
        if phase == 0 && watch_exe && exe.exists() {
            phase = 1;
            let _ = proxy.send_event(Msg::Phase(1));
        }
        if phase == 1 && watch_lnk && lnk.exists() {
            phase = 2;
            let _ = proxy.send_event(Msg::Phase(2));
        }
        thread::sleep(Duration::from_millis(150));
    }
}

/// The abort bar promises the copied files go away, so they have to.
fn rollback(dir: &Path, existed: bool) {
    let uninstall = dir.join("uninstall.exe");
    if uninstall.exists() {
        let _ = Command::new(&uninstall)
            .arg("/S")
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        return;
    }
    // ponytail: only a directory this run created is ours to delete. A folder
    // that was already there stays, even if it now holds a half-copied app —
    // NSIS aborted mid-upgrade is a mess we cannot safely clean by guessing.
    if !existed && dir.parent().is_some() {
        let _ = fs::remove_dir_all(dir);
    }
}

fn page(path: &Path) -> String {
    let boot = format!(
        "boot({{version:{},path:{},reqMb:{},freeGb:{}}})",
        js(env!("CARGO_PKG_VERSION")),
        js(&path.display().to_string()),
        INSTALL_MB,
        free_gb(path),
    );
    HTML.replace("/*FONTS*/", FONTS).replace("/*BOOT*/", &boot)
}

fn default_dir() -> PathBuf {
    // Matches the NSIS currentUser default, so the prefilled path is the path
    // the installer would pick on its own.
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\".into());
    PathBuf::from(local).join("PureMD")
}

fn start_menu_lnk() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata)
        .join("Microsoft\\Windows\\Start Menu\\Programs")
        .join("PureMD.lnk")
}

fn nearest_existing(dir: &Path) -> PathBuf {
    let mut p = dir;
    while !p.exists() {
        match p.parent() {
            Some(parent) => p = parent,
            None => break,
        }
    }
    p.to_path_buf()
}

fn code_label(code: i32) -> (String, bool) {
    match code {
        5 => ("exit 0x80070005 · ERROR_ACCESS_DENIED".into(), true),
        _ => (format!("exit {code}"), false),
    }
}

fn os_code(e: &io::Error) -> i32 {
    e.raw_os_error().unwrap_or(-1)
}

fn js(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn open_url(url: &str) {
    let _ = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn free_gb(dir: &Path) -> u64 {
    let root = wide(&nearest_existing(dir));
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(root.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
    };
    if ok == 0 {
        0
    } else {
        free / 1_073_741_824
    }
}

fn center(window: &tao::window::Window) {
    if let Some(monitor) = window.current_monitor() {
        let (area, origin) = (monitor.size(), monitor.position());
        let size = window.outer_size();
        window.set_outer_position(PhysicalPosition::new(
            origin.x + (area.width as i32 - size.width as i32) / 2,
            origin.y + (area.height as i32 - size.height as i32) / 2,
        ));
    }
}

/// Win11 does not round an undecorated window on its own, and a hard-cornered
/// rectangle is exactly the "old Windows" look this replaces.
fn round_corners(window: &tao::window::Window) {
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    let pref = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            window.hwnd(),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(
        directory: *const u16,
        free_to_caller: *mut u64,
        total: *mut u64,
        total_free: *mut u64,
    ) -> i32;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const c_void, size: u32) -> i32;
}
