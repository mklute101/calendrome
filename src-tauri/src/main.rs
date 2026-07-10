// Calendrome — native desktop shell (#24, Option C).
//
// A thin Tauri v2 wrapper: the webview loads the local GUI server
// (the same interactive SPA the browser gets), and the shell's only
// job is native window chrome + making sure that server is running.
// All engine logic stays in Node — the shell never touches SQLite.
//
// Server discovery mirrors src/gui/launcher.ts:
//   1. If the port already answers, attach to it (the MCP `gui_start`
//      tool or a hand-run `npm run gui` may own it).
//   2. Otherwise spawn `node <repo>/dist/src/gui/server.js` detached
//      and poll until it answers. The child is deliberately left
//      running on quit — the server is shared with other consumers
//      (MCP sessions, a browser tab); killing it would yank it away.
//
// Repo location: CALENDROME_DIR env var if set, else the compile-time
// parent of src-tauri (correct for a repo-built personal app).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn gui_port() -> u16 {
    std::env::var("CALENDROME_GUI_PORT")
        .or_else(|_| std::env::var("PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3737)
}

fn server_running(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn repo_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CALENDROME_DIR") {
        return PathBuf::from(dir);
    }
    // src-tauri/ lives inside the repo; its parent is the repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

fn ensure_server(port: u16) -> Result<(), String> {
    if server_running(port) {
        return Ok(());
    }

    let server_js = repo_dir().join("dist/src/gui/server.js");
    if !server_js.exists() {
        return Err(format!(
            "GUI server not built: {} is missing. Run `npm run build` in the calendrome repo.",
            server_js.display()
        ));
    }

    Command::new("node")
        .arg(&server_js)
        .current_dir(repo_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn `node {}`: {e}", server_js.display()))?;

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if server_running(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("GUI server did not answer on port {port} within 10s"))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let port = gui_port();
            let url = match ensure_server(port) {
                Ok(()) => format!("http://localhost:{port}/"),
                Err(msg) => {
                    eprintln!("calendrome: {msg}");
                    // Show the error in-window rather than dying silently.
                    format!(
                        "data:text/html,{}",
                        urlencode(&format!(
                            "<body style=\"background:#0d1117;color:#e6edf3;font-family:sans-serif;padding:40px\"><h2>Calendrome server unavailable</h2><p>{msg}</p><p>Start it manually with <code>npm run gui</code>, then relaunch.</p></body>"
                        ))
                    )
                }
            };
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("valid url")),
            )
            .title("Calendrome")
            .inner_size(1440.0, 900.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running calendrome");
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
