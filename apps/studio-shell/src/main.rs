#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct Backend(Mutex<Option<Child>>);

fn backend_path() -> PathBuf {
    if let Ok(path) = env::var("STUDIO_BACKEND_EXE") {
        return PathBuf::from(path);
    }
    let exe =
        env::current_exe().unwrap_or_else(|_| PathBuf::from("MinecraftMultiAgentStudioShell.exe"));
    exe.parent()
        .unwrap_or(Path::new("."))
        .join("MinecraftMultiAgentStudioBackend.exe")
}

fn launch_backend() -> Result<Child, String> {
    let path = backend_path();
    if !path.exists() {
        return Err(format!("backend executable not found: {}", path.display()));
    }
    Command::new(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start backend: {e}"))
}

fn wait_for_dashboard(app: tauri::AppHandle) {
    thread::spawn(move || {
        for _ in 0..240 {
            if TcpStream::connect(("127.0.0.1", 3000)).is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("studio-ready", "http://127.0.0.1:3000");
                    let _ = window.eval("window.location.replace('http://127.0.0.1:3000')");
                }
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(
                "studio-error",
                "dashboard did not become ready within 60 seconds",
            );
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Minecraft Multi-Agent Studio")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(1024.0, 700.0)
                    .build()?;
            let backend = launch_backend().unwrap_or_else(|error| panic!("{error}"));
            let mut slot = app
                .state::<Backend>()
                .0
                .lock()
                .expect("backend lock poisoned");
            *slot = Some(backend);
            wait_for_dashboard(app.handle().clone());
            let _ = window.emit("studio-starting", "Starting local services...");
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(backend) = window.app_handle().try_state::<Backend>() {
                    if let Ok(mut slot) = backend.0.lock() {
                        if let Some(mut child) = slot.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Studio shell");
}

fn main() {
    run();
}
