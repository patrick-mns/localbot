//! Local Bot's Windows/Linux shell. Like the macOS app, it runs the brain (Node)
//! as a child process and speaks its protocol: one JSON object per line on
//! stdin/stdout. Lines go to the web UI as `brain-line` events; the UI writes
//! back through the `brain_send` command. Everything else lives in the brain.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct Brain {
    stdin: Mutex<Option<ChildStdin>>,
}

/// The packaged app ships Node and the bundled brain as resources; a dev
/// checkout runs the TypeScript sources through tsx (`LOCALBOT_BRAIN_DIR`
/// overrides where they are).
fn launch_command(app: &AppHandle) -> Command {
    if let Ok(res) = app.path().resource_dir() {
        let node = res.join(if cfg!(windows) { "node.exe" } else { "node" });
        let script = res.join("brain").join("brain.mjs");
        if node.exists() && script.exists() {
            let mut cmd = Command::new(node);
            cmd.arg(script);
            return cmd;
        }
    }
    let dir = std::env::var("LOCALBOT_BRAIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../brain"));
    let mut cmd = Command::new(if cfg!(windows) { "node.exe" } else { "node" });
    cmd.args(["--import", "tsx", "src/index.ts"]).current_dir(dir);
    cmd
}

fn start_brain(app: &AppHandle) -> Result<(), String> {
    let mut cmd = launch_command(app);
    cmd.env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    // The brain's log: <app log dir>/brain.log.
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        if let Ok(log) = File::create(dir.join("brain.log")) {
            cmd.stderr(Stdio::from(log));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Couldn’t start the brain: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *app.state::<Brain>().stdin.lock().unwrap() = child.stdin.take();

    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let _ = handle.emit("brain-line", line);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = handle.emit("brain-exit", code);
    });
    Ok(())
}

/// One protocol line from the UI to the brain.
#[tauri::command]
fn brain_send(line: String, brain: State<Brain>) -> Result<(), String> {
    let mut guard = brain.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("The brain isn’t running")?;
    stdin
        .write_all(line.trim_end().as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Starts (or restarts) the brain; the UI calls it once it listens for lines.
#[tauri::command]
fn brain_start(app: AppHandle) -> Result<(), String> {
    if app.state::<Brain>().stdin.lock().unwrap().is_some() {
        return Ok(());
    }
    start_brain(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Brain::default())
        .invoke_handler(tauri::generate_handler![brain_send, brain_start])
        .build(tauri::generate_context!())
        .expect("error while building Local Bot")
        .run(|app, event| {
            // Closing the brain's stdin is how it learns the app quit (a
            // background service, if any, then takes over).
            if let RunEvent::Exit = event {
                app.state::<Brain>().stdin.lock().unwrap().take();
            }
        });
}
