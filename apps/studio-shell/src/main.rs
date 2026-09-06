#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

const CURRENT_VERSION: &str = "0.1.0";

struct Backend(Mutex<Option<Child>>);

#[derive(Debug, Deserialize)]
struct UpdateManifest {
    version: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct UpdateStatus {
    current_version: String,
    available: bool,
    version: Option<String>,
    url: Option<String>,
    sha256: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn check_for_update(manifest_url: String) -> UpdateStatus {
    let base = UpdateStatus {
        current_version: CURRENT_VERSION.into(),
        available: false,
        version: None,
        url: None,
        sha256: None,
        error: None,
    };
    let response = match reqwest::blocking::get(&manifest_url) {
        Ok(value) => value,
        Err(error) => {
            return UpdateStatus {
                error: Some(error.to_string()),
                ..base
            }
        }
    };
    let manifest = match response.json::<UpdateManifest>() {
        Ok(value) => value,
        Err(error) => {
            return UpdateStatus {
                error: Some(format!("invalid update manifest: {error}")),
                ..base
            }
        }
    };
    if manifest.sha256.len() != 64 || !manifest.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return UpdateStatus {
            error: Some("update manifest has invalid sha256".into()),
            ..base
        };
    }
    let available = manifest.version != CURRENT_VERSION;
    UpdateStatus {
        current_version: CURRENT_VERSION.into(),
        available,
        version: Some(manifest.version),
        url: Some(manifest.url),
        sha256: Some(manifest.sha256),
        error: None,
    }
}

#[tauri::command]
fn download_update(url: String, sha256: String) -> Result<String, String> {
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid update checksum".into());
    }
    let response = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
    if let Some(size) = response.content_length() {
        if size > 512 * 1024 * 1024 {
            return Err("update is larger than 512 MiB".into());
        }
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("update is larger than 512 MiB".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != sha256.to_ascii_lowercase() {
        return Err("update checksum mismatch".into());
    }
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = current.with_extension("new.exe");
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn install_update(app: tauri::AppHandle, downloaded: String) -> Result<(), String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let current_q = current.to_string_lossy().replace('\'', "''");
    let downloaded_q = downloaded.replace('\'', "''");
    let script = format!("Start-Sleep -Seconds 2; Move-Item -LiteralPath '{downloaded_q}' -Destination '{current_q}' -Force; Start-Process -FilePath '{current_q}'");
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

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
                    let _ = window.eval(
                        "window.__studioReady && window.__studioReady('http://127.0.0.1:3000')",
                    );
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
        .invoke_handler(tauri::generate_handler![
            check_for_update,
            download_update,
            install_update
        ])
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
