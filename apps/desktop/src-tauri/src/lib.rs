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
    /// How the brain was started, for the error screen when it stops.
    command: Mutex<String>,
}

/// The packaged app ships Node and the bundled brain as resources; a dev
/// checkout runs the TypeScript sources through tsx (`LOCALBOT_BRAIN_DIR`
/// overrides where they are).
fn launch_command(app: &AppHandle) -> Result<Command, String> {
    let res = app.path().resource_dir().map_err(|e| format!("No resource folder: {e}"))?;
    // Node can't load an ES module from a verbatim (\\?\C:\…) path.
    let res = match res.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(plain) if !plain.starts_with("UNC") => PathBuf::from(plain),
        _ => res,
    };
    let node = res.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = res.join("brain").join("brain.mjs");
    if node.exists() && script.exists() {
        let mut cmd = Command::new(node);
        cmd.arg(script).current_dir(&res);
        return Ok(cmd);
    }
    // An installed app always has them: say what's missing instead of
    // falling back to a source checkout that isn't there.
    if !cfg!(debug_assertions) {
        return Err(format!(
            "Local Bot is missing its brain: {} {}, {} {}",
            node.display(), if node.exists() { "found" } else { "not found" },
            script.display(), if script.exists() { "found" } else { "not found" },
        ));
    }
    let dir = std::env::var("LOCALBOT_BRAIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../brain"));
    let mut cmd = Command::new(if cfg!(windows) { "node.exe" } else { "node" });
    cmd.args(["--import", "tsx", "src/index.ts"]).current_dir(dir);
    Ok(cmd)
}

fn start_brain(app: &AppHandle) -> Result<(), String> {
    let mut cmd = launch_command(app)?;
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

    *app.state::<Brain>().command.lock().unwrap() = format!("{:?}", cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn’t start the brain ({:?}): {e}", cmd))?;
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
        // Ready for a restart (the UI's "Try again").
        handle.state::<Brain>().stdin.lock().unwrap().take();
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

/// What the error screen shows when the brain stops: how it was started and
/// the end of its log.
#[tauri::command]
fn brain_diagnostics(app: AppHandle) -> String {
    let command = app.state::<Brain>().command.lock().unwrap().clone();
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join("brain.log"))
        .and_then(|p| fs::read_to_string(&p).ok().map(|t| (p, t)))
        .map(|(p, t)| {
            let tail: String = t.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
            format!("{}:\n{}", p.display(), tail)
        })
        .unwrap_or_else(|| "(no brain log)".into());
    format!("{command}\n\n{log}")
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Brain::default())
        .invoke_handler(tauri::generate_handler![brain_send, brain_start, brain_diagnostics])
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
