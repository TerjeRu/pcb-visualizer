// Starting the pcbv service and reporting why it did not start.
//
// `plan_start` decides what to run, `run_attempt` runs it within a deadline and keeps the tail of its
// error output, and `failure_url` turns a failure into the address of the splash page, which shows it.
// A service this process did not start is never stopped here.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Url;

use crate::service::Health;

/// How long the service has to answer, from the start of an attempt.
pub const START_DEADLINE: Duration = Duration::from_secs(15);
const LOG_BYTES: usize = 16 * 1024;
const DETAIL_BYTES: usize = 4 * 1024;
const POLL: Duration = Duration::from_millis(250);
const COMMAND_SEE_ERROR: &str = "Run pcbv serve in a terminal to see the full error.";

#[derive(Debug)]
pub struct Failure {
    pub reason: String,
    pub detail: String,
    pub command: String,
}

impl Failure {
    fn new(
        reason: impl Into<String>,
        detail: impl Into<String>,
        command: impl Into<String>,
    ) -> Self {
        Failure {
            reason: reason.into(),
            detail: detail.into(),
            command: command.into(),
        }
    }

    pub fn incompatible_running() -> Self {
        Failure::new(
            "The running service uses an incompatible protocol.",
            "",
            "Stop the running pcbv service, then press Retry.",
        )
    }

    pub fn stopped_answering() -> Self {
        Failure::new(
            "The service stopped answering while starting.",
            "",
            COMMAND_SEE_ERROR,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Ready,
    Failed,
}

/// Only a failed start can be retried.
pub fn retry_allowed(phase: Phase) -> bool {
    phase == Phase::Failed
}

#[derive(Debug)]
pub struct Plan {
    program: PathBuf,
    args: Vec<&'static str>,
    dir: Option<PathBuf>,
}

/// A regular file with an execute bit, named `name`, in a directory of `path`.
fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .map(|dir| dir.join(name))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

fn uv_plan(dir: &Path, path: Option<&OsStr>, what: &str) -> Result<Plan, Failure> {
    if !dir.is_dir() || !dir.join("pyproject.toml").is_file() {
        return Err(Failure::new(
            format!("{what} is not a service folder."),
            format!(
                "{} is not a directory with a pyproject.toml.",
                dir.display()
            ),
            "Set PCBV_SERVICE_DIR to the service folder of a pcb-visualizer checkout.",
        ));
    }
    let Some(uv) = find_on_path("uv", path) else {
        return Err(Failure::new(
            "uv was not found.",
            format!("The service folder {} needs uv to start.", dir.display()),
            "Install uv (sudo pacman -S uv), or install pcbv on your PATH.",
        ));
    };
    Ok(Plan {
        program: uv,
        args: vec!["run", "pcbv", "serve"],
        dir: Some(dir.to_owned()),
    })
}

/// What to run, in order: `pcbv` on the path; `uv run pcbv serve` in `service_dir` (a set but unusable
/// one is a failure, it does not fall through); the same in `checkout`; else a failure.
pub fn plan_start(
    path: Option<&OsStr>,
    service_dir: Option<&OsStr>,
    checkout: Option<&Path>,
) -> Result<Plan, Failure> {
    if let Some(pcbv) = find_on_path("pcbv", path) {
        return Ok(Plan {
            program: pcbv,
            args: vec!["serve"],
            dir: None,
        });
    }
    if let Some(dir) = service_dir {
        return uv_plan(Path::new(dir), path, "PCBV_SERVICE_DIR");
    }
    if let Some(dir) = checkout {
        return uv_plan(dir, path, "The checkout");
    }
    Err(Failure::new(
        "pcbv was not found.",
        "",
        "Install pcbv on your PATH, or set PCBV_SERVICE_DIR to the service folder of a pcb-visualizer checkout.",
    ))
}

/// Set only by the AppImage launcher, with no path in them.
const LAUNCHER_ONLY: [&str; 1] = ["PYTHONDONTWRITEBYTECODE"];

/// The AppImage launcher points PYTHONHOME, PYTHONPATH, LD_LIBRARY_PATH, PATH and others into the
/// AppImage (`APPDIR`), and every child inherits them: a Python service then cannot find its standard
/// library. This gives the changes that undo that for a child: list variables lose their entries inside
/// `appdir` (and empty entries, which Python reads as the current folder), and a variable left empty, or
/// set only by the launcher, is removed. `None` means remove. Without `appdir` there is nothing to undo.
pub fn outside_appimage(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    appdir: Option<&OsStr>,
) -> Vec<(OsString, Option<OsString>)> {
    let Some(appdir) = appdir.map(OsStr::as_bytes).filter(|dir| !dir.is_empty()) else {
        return Vec::new();
    };
    let appdir = appdir.strip_suffix(b"/").unwrap_or(appdir);
    let inside = |entry: &[u8]| {
        entry
            .strip_prefix(appdir)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(b"/"))
    };
    let mut changes = Vec::new();
    for (name, value) in vars {
        if LAUNCHER_ONLY.iter().any(|only| name == *only) {
            changes.push((name, None));
            continue;
        }
        let bytes = value.as_bytes();
        if !bytes.windows(appdir.len()).any(|window| window == appdir) {
            continue;
        }
        let kept: Vec<&[u8]> = bytes
            .split(|&byte| byte == b':')
            .filter(|entry| !entry.is_empty() && !inside(entry))
            .collect();
        let joined = kept.join(&b':');
        changes.push((
            name,
            (!joined.is_empty()).then(|| OsString::from_vec(joined)),
        ));
    }
    changes
}

type Log = Arc<Mutex<VecDeque<u8>>>;

fn keep_tail(log: &Log, chunk: &[u8]) {
    let mut log = log.lock().unwrap();
    log.extend(chunk);
    let extra = log.len().saturating_sub(LOG_BYTES);
    log.drain(..extra);
}

fn log_text(log: &Log) -> String {
    let bytes: Vec<u8> = log.lock().unwrap().iter().copied().collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Reads the child's error output to the end, so the service can never block on a full pipe.
fn spawn_reader(mut stderr: impl Read + Send + 'static, log: Log) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            keep_tail(&log, &chunk[..n]);
        }
    })
}

/// SIGTERM, not SIGKILL: uv passes it on to pcbv, which closes captures and removes its service.json.
/// After 5 seconds the child is killed.
pub fn stop_child(child: &mut Child) {
    let _ = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Takes the owned child out of `owned` (so the lock is released) and stops it.
fn stop_owned(owned: &Mutex<Option<Child>>) {
    let child = owned.lock().unwrap().take();
    if let Some(mut child) = child {
        stop_child(&mut child);
    }
}

/// `run_attempt`, also giving the kept error output so tests can look at it.
fn attempt(
    plan: &Plan,
    deadline: Duration,
    probe: impl Fn() -> Health,
    owned: &Mutex<Option<Child>>,
) -> (Result<(), Failure>, Log) {
    let log: Log = Arc::default();
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .stdin(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(dir) = &plan.dir {
        command.current_dir(dir);
    }
    for (name, value) in
        outside_appimage(std::env::vars_os(), std::env::var_os("APPDIR").as_deref())
    {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    // After the loop above, so nothing can remove it. The service ends when this process does, even when
    // this process is killed and runs no code (`pcbv serve` watches it).
    command.env("PCBV_STOP_WITH_PID", std::process::id().to_string());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return (
                Err(Failure::new(
                    "The service could not be started.",
                    error.to_string(),
                    COMMAND_SEE_ERROR,
                )),
                log,
            )
        }
    };
    let reader = child
        .stderr
        .take()
        .map(|stderr| spawn_reader(stderr, log.clone()));
    // Owned from the moment it runs, so quitting the app while it starts stops it too.
    *owned.lock().unwrap() = Some(child);
    let failure = |reason: String| Failure::new(reason, log_text(&log), COMMAND_SEE_ERROR);
    let started = Instant::now();
    let result = loop {
        match probe() {
            Health::Ready => break Ok(()),
            Health::Incompatible => {
                stop_owned(owned);
                break Err(Failure {
                    command: "The pcbv found by the app is a different version; update it.".into(),
                    ..failure("The running service uses an incompatible protocol.".into())
                });
            }
            Health::Down => {}
        }
        let exited = match owned.lock().unwrap().as_mut() {
            Some(child) => child.try_wait().ok().flatten().map(Some),
            // Someone else (the app quitting) took and stopped it.
            None => Some(None),
        };
        if let Some(status) = exited {
            owned.lock().unwrap().take();
            let Some(status) = status else {
                break Err(failure("The service was stopped while starting.".into()));
            };
            // Give the reader a moment to take the last bytes the child wrote.
            if let Some(reader) = &reader {
                let until = Instant::now() + Duration::from_millis(300);
                while !reader.is_finished() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            let code = status
                .code()
                .map_or("none".to_string(), |code| code.to_string());
            break Err(failure(format!(
                "The service stopped while starting (exit status {code})."
            )));
        }
        if started.elapsed() >= deadline {
            stop_owned(owned);
            // The limit as the user knows it, not the time left of it when this attempt began.
            break Err(failure(format!(
                "The service did not answer within {} seconds.",
                START_DEADLINE.as_secs()
            )));
        }
        thread::sleep(POLL.min(deadline.saturating_sub(started.elapsed())));
    };
    (result, log)
}

/// Starts the plan and waits until `probe` says Ready, the child exits, or `deadline` passes. The child
/// is put in `owned` as soon as it runs and stays there on success; a child that fails or answers
/// `Incompatible` is stopped and taken out before the failure is returned.
pub fn run_attempt(
    plan: &Plan,
    deadline: Duration,
    probe: impl Fn() -> Health,
    owned: &Mutex<Option<Child>>,
) -> Result<(), Failure> {
    attempt(plan, deadline, probe, owned).0
}

fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The splash page's address for a failure: `base` (the main window's current address) with its query
/// replaced. The texts travel as query values, which `query_pairs_mut` encodes.
pub fn failure_url(base: &Url, failure: &Failure) -> Url {
    let mut url = base.clone();
    url.set_fragment(None);
    url.query_pairs_mut()
        .clear()
        .append_pair("state", "failed")
        .append_pair("reason", &failure.reason)
        .append_pair("detail", tail(&failure.detail, DETAIL_BYTES))
        .append_pair("command", &failure.command);
    url
}

/// The address the splash's Retry button asks for: the app's own page (not http or https) with `retry=1`
/// in the query. Tauri serves `index.html` at the root and shows it as `tauri://localhost`, whose path
/// is empty, so the root counts as well as `/index.html`.
pub fn is_retry_address(url: &Url) -> bool {
    !matches!(url.scheme(), "http" | "https")
        && matches!(url.path(), "" | "/" | "/index.html")
        && url
            .query_pairs()
            .any(|(key, value)| key == "retry" && value == "1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh folder under the temp directory, removed again when the test drops it.
    struct Scratch(PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = PathBuf;
        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch_dir() -> Scratch {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pcbv-startup-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    /// Writes a script that a test then runs. A child process writes the file, so this process never
    /// holds it open for writing. When this process wrote it, another test thread could start a program
    /// in that moment, the program got a copy of the open file, and running the script then failed with
    /// "Text file busy".
    fn script(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
        let path = dir.join(name);
        let written = Command::new("sh")
            .args(["-c", "printf '%s' \"$1\" > \"$2\"", "sh"])
            .arg(format!("#!/bin/sh\n{body}\n"))
            .arg(&path)
            .status()
            .unwrap();
        assert!(written.success());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn plan_for(path: PathBuf) -> Plan {
        Plan {
            program: path,
            args: vec![],
            dir: None,
        }
    }

    fn pid_gone(pid: u32) -> bool {
        !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    fn service_folder() -> Scratch {
        let dir = scratch_dir();
        std::fs::write(dir.join("pyproject.toml"), "").unwrap();
        dir
    }

    #[test]
    fn pcbv_on_the_path_wins() {
        let bin = scratch_dir();
        let pcbv = script(&bin, "pcbv", "", 0o755);
        let plan = plan_start(
            Some(bin.as_os_str()),
            Some(service_folder().as_os_str()),
            None,
        )
        .unwrap();
        assert_eq!(plan.program, pcbv);
        assert_eq!(plan.args, ["serve"]);
    }

    #[test]
    fn a_non_executable_pcbv_is_ignored() {
        let bin = scratch_dir();
        script(&bin, "pcbv", "", 0o644);
        let failure = plan_start(Some(bin.as_os_str()), None, None).unwrap_err();
        assert_eq!(failure.reason, "pcbv was not found.");
    }

    #[test]
    fn a_service_folder_without_pyproject_fails_with_its_own_reason() {
        let bin = scratch_dir();
        script(&bin, "uv", "", 0o755);
        let empty = scratch_dir();
        let checkout = service_folder();
        let failure = plan_start(
            Some(bin.as_os_str()),
            Some(empty.as_os_str()),
            Some(checkout.as_path()),
        )
        .unwrap_err();
        assert!(
            failure.reason.contains("PCBV_SERVICE_DIR"),
            "{}",
            failure.reason
        );
    }

    #[test]
    fn the_service_folder_is_used_when_pcbv_is_absent_and_uv_present() {
        let bin = scratch_dir();
        let uv = script(&bin, "uv", "", 0o755);
        let folder = service_folder();
        let plan = plan_start(Some(bin.as_os_str()), Some(folder.as_os_str()), None).unwrap();
        assert_eq!(plan.program, uv);
        assert_eq!(plan.args, ["run", "pcbv", "serve"]);
        assert_eq!(plan.dir, Some(folder.to_path_buf()));
    }

    #[test]
    fn a_missing_uv_fails() {
        let bin = scratch_dir();
        let folder = service_folder();
        let failure =
            plan_start(Some(bin.as_os_str()), Some(folder.as_os_str()), None).unwrap_err();
        assert_eq!(failure.reason, "uv was not found.");
    }

    #[test]
    fn nothing_found_gives_the_not_found_failure() {
        let bin = scratch_dir();
        let failure = plan_start(Some(bin.as_os_str()), None, None).unwrap_err();
        assert_eq!(failure.reason, "pcbv was not found.");
        assert!(failure.command.contains("PCBV_SERVICE_DIR"));
        assert!(plan_start(None, None, None).is_err());
    }

    #[test]
    fn the_checkout_is_used_last() {
        let bin = scratch_dir();
        script(&bin, "uv", "", 0o755);
        let checkout = service_folder();
        let plan = plan_start(Some(bin.as_os_str()), None, Some(checkout.as_path())).unwrap();
        assert_eq!(plan.dir, Some(checkout.to_path_buf()));
        let other = service_folder();
        let plan = plan_start(
            Some(bin.as_os_str()),
            Some(other.as_os_str()),
            Some(checkout.as_path()),
        )
        .unwrap();
        assert_eq!(plan.dir, Some(other.to_path_buf()));
    }

    fn changes(vars: &[(&str, &str)], appdir: Option<&str>) -> Vec<(String, Option<String>)> {
        let vars = vars
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        outside_appimage(vars, appdir.map(OsStr::new))
            .into_iter()
            .map(|(name, value)| {
                (
                    name.into_string().unwrap(),
                    value.map(|value| value.into_string().unwrap()),
                )
            })
            .collect()
    }

    #[test]
    fn the_appimage_launcher_variables_are_undone_for_the_service() {
        let a = "/tmp/.mount_PCB ViaeDHjb";
        let vars = [
            ("PYTHONHOME", "/tmp/.mount_PCB ViaeDHjb/usr/"),
            ("PYTHONPATH", "/tmp/.mount_PCB ViaeDHjb/usr/share/pyshared/:"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("PATH", "/tmp/.mount_PCB ViaeDHjb/usr/bin/:/tmp/.mount_PCB ViaeDHjb/bin/:/home/t/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_PCB ViaeDHjb/usr/lib/:/tmp/.mount_PCB ViaeDHjb/lib64/:/opt/lib"),
            ("GTK_PATH", "/tmp/.mount_PCB ViaeDHjb//usr/lib/gtk-3.0"),
            ("XDG_DATA_DIRS", "/tmp/.mount_PCB ViaeDHjb/usr/share:/usr/share:/usr/local/share"),
            ("HOME", "/home/t"),
            ("NEARBY", "/tmp/.mount_PCB ViaeDHjbX/usr/lib"),
        ];
        let got = changes(&vars, Some(a));
        let expect =
            |name: &str, value: Option<&str>| (name.to_string(), value.map(str::to_string));
        assert_eq!(
            got,
            vec![
                expect("PYTHONHOME", None),
                expect("PYTHONPATH", None),
                expect("PYTHONDONTWRITEBYTECODE", None),
                expect("PATH", Some("/home/t/bin:/usr/bin")),
                expect("LD_LIBRARY_PATH", Some("/opt/lib")),
                expect("GTK_PATH", None),
                expect("XDG_DATA_DIRS", Some("/usr/share:/usr/local/share")),
                expect("NEARBY", Some("/tmp/.mount_PCB ViaeDHjbX/usr/lib")),
            ]
        );
        assert_eq!(changes(&vars, Some(&format!("{a}/"))), got);
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        let vars = [
            ("PYTHONHOME", "/opt/py"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("PATH", "/usr/bin"),
        ];
        assert!(changes(&vars, None).is_empty());
        assert!(changes(&vars, Some("")).is_empty());
    }

    #[test]
    fn a_child_that_exits_gives_a_failure_with_its_error_output() {
        let dir = scratch_dir();
        let plan = plan_for(script(&dir, "boom", "echo boom >&2\nexit 3", 0o755));
        let started = Instant::now();
        let failure = run_attempt(
            &plan,
            Duration::from_secs(10),
            || Health::Down,
            &Mutex::default(),
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(failure.detail.contains("boom"), "{}", failure.detail);
        assert!(
            failure.reason.contains("exit status 3"),
            "{}",
            failure.reason
        );
    }

    #[test]
    fn the_service_is_told_to_end_with_this_process() {
        let dir = scratch_dir();
        let out = dir.join("seen");
        let plan = plan_for(script(
            &dir,
            "env",
            &format!(
                "echo \"$PCBV_STOP_WITH_PID\" > {}\nexec sleep 30",
                out.display()
            ),
            0o755,
        ));
        let owned = Mutex::default();
        run_attempt(
            &plan,
            Duration::from_secs(10),
            || {
                if out.exists() {
                    Health::Ready
                } else {
                    Health::Down
                }
            },
            &owned,
        )
        .unwrap();
        stop_owned(&owned);
        assert_eq!(
            std::fs::read_to_string(&out).unwrap().trim(),
            std::process::id().to_string()
        );
    }

    #[test]
    fn a_noisy_child_is_never_blocked_and_only_the_tail_is_kept() {
        let dir = scratch_dir();
        let marker = dir.join("marker");
        let body = format!(
            "head -c 102400 /dev/zero | tr '\\0' 'a' >&2\necho END >&2\ntouch {}\nexec sleep 30",
            marker.display()
        );
        let plan = plan_for(script(&dir, "noisy", &body, 0o755));
        let owned = Mutex::default();
        let (result, log) = attempt(
            &plan,
            Duration::from_secs(10),
            || {
                if marker.exists() {
                    Health::Ready
                } else {
                    Health::Down
                }
            },
            &owned,
        );
        result.expect("the marker appeared, so the pipe did not block");
        let until = Instant::now() + Duration::from_secs(3);
        while !log_text(&log).ends_with("END\n") && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        let kept = log_text(&log);
        stop_owned(&owned);
        assert!(kept.len() <= LOG_BYTES, "{}", kept.len());
        assert!(kept.ends_with("aaaEND\n"));
    }

    #[test]
    fn the_deadline_stops_the_child() {
        let dir = scratch_dir();
        let plan = plan_for(script(&dir, "slow", "exec sleep 30", 0o755));
        let started = Instant::now();
        let owned = Mutex::default();
        let (result, _) = attempt(&plan, Duration::from_secs(1), || Health::Down, &owned);
        let failure = result.unwrap_err();
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(900) && elapsed < Duration::from_secs(4),
            "{elapsed:?}"
        );
        // The message names the app's limit, not the deadline this attempt was given.
        assert_eq!(
            failure.reason,
            "The service did not answer within 15 seconds."
        );
        assert!(owned.lock().unwrap().is_none());
    }

    #[test]
    fn a_child_that_answers_on_the_third_poll_is_returned() {
        let dir = scratch_dir();
        let plan = plan_for(script(&dir, "ok", "exec sleep 30", 0o755));
        let calls = std::cell::Cell::new(0);
        let owned = Mutex::default();
        run_attempt(
            &plan,
            Duration::from_secs(10),
            || {
                calls.set(calls.get() + 1);
                if calls.get() >= 3 {
                    Health::Ready
                } else {
                    Health::Down
                }
            },
            &owned,
        )
        .expect("ready on the third call");
        assert_eq!(calls.get(), 3);
        assert!(
            owned.lock().unwrap().is_some(),
            "the started child stays owned"
        );
        stop_owned(&owned);
    }

    #[test]
    fn an_incompatible_child_is_stopped_at_once() {
        let dir = scratch_dir();
        let pid_file = dir.join("pid");
        let plan = plan_for(script(
            &dir,
            "old",
            &format!(
                "echo $$ > {}\necho old >&2\nexec sleep 30",
                pid_file.display()
            ),
            0o755,
        ));
        let started = Instant::now();
        let failure = run_attempt(
            &plan,
            Duration::from_secs(10),
            || {
                while !pid_file.exists() {
                    thread::sleep(Duration::from_millis(10));
                }
                Health::Incompatible
            },
            &Mutex::default(),
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(
            failure.reason,
            "The running service uses an incompatible protocol."
        );
        assert_eq!(
            failure.command,
            "The pcbv found by the app is a different version; update it."
        );
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(pid_gone(pid));
    }

    #[test]
    fn a_deadline_child_is_gone_afterwards() {
        let dir = scratch_dir();
        let pid_file = dir.join("pid");
        let plan = plan_for(script(
            &dir,
            "slow",
            &format!("echo $$ > {}\nexec sleep 30", pid_file.display()),
            0o755,
        ));
        let _ = run_attempt(
            &plan,
            Duration::from_secs(1),
            || Health::Down,
            &Mutex::default(),
        )
        .unwrap_err();
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(pid_gone(pid));
    }

    #[test]
    fn the_child_is_owned_while_it_starts() {
        // Quitting the app during startup must find the child to stop it.
        let dir = scratch_dir();
        let plan = plan_for(script(&dir, "slow", "exec sleep 30", 0o755));
        let owned = Mutex::default();
        let seen = std::cell::Cell::new(None);
        let _ = run_attempt(
            &plan,
            Duration::from_secs(1),
            || {
                if seen.get().is_none() {
                    seen.set(owned.lock().unwrap().as_ref().map(Child::id));
                }
                Health::Down
            },
            &owned,
        );
        let pid = seen.get().expect("the child was owned before it answered");
        assert!(pid_gone(pid));
    }

    #[test]
    fn a_child_stopped_by_the_app_quitting_ends_the_attempt() {
        let dir = scratch_dir();
        let plan = plan_for(script(&dir, "slow", "exec sleep 30", 0o755));
        let owned = Mutex::default();
        let started = Instant::now();
        let failure = run_attempt(
            &plan,
            Duration::from_secs(10),
            || {
                stop_owned(&owned);
                Health::Down
            },
            &owned,
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(failure.reason, "The service was stopped while starting.");
    }

    #[test]
    fn only_a_failed_start_can_be_retried() {
        assert!(retry_allowed(Phase::Failed));
        assert!(!retry_allowed(Phase::Starting));
        assert!(!retry_allowed(Phase::Ready));
    }

    #[test]
    fn the_failure_address_replaces_the_query_and_encodes_the_texts() {
        // The address Tauri really gives the splash: the root, with an empty path.
        let base = Url::parse("tauri://localhost?retry=1").unwrap();
        let failure = Failure::new("A & B", "x".repeat(5000) + "é", "run <this>");
        let url = failure_url(&base, &failure);
        assert_eq!(url.scheme(), "tauri");
        assert_eq!(url.path(), "");
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["state"], "failed");
        assert_eq!(pairs["reason"], "A & B");
        assert_eq!(pairs["command"], "run <this>");
        assert!(pairs["detail"].len() <= DETAIL_BYTES && pairs["detail"].ends_with('é'));
        assert!(!pairs.contains_key("retry"));
    }

    #[test]
    fn only_the_apps_own_retry_address_is_a_retry() {
        // `tauri://localhost?retry=1` is what the splash's Retry button really asks for.
        for good in [
            "tauri://localhost?retry=1",
            "tauri://localhost/?retry=1",
            "tauri://localhost/index.html?retry=1",
            "http://tauri.localhost/index.html?retry=1&x=2",
        ] {
            let url = Url::parse(good).unwrap();
            assert_eq!(is_retry_address(&url), good.starts_with("tauri"), "{good}");
        }
        for bad in [
            "tauri://localhost",
            "tauri://localhost?state=failed",
            "tauri://localhost/index.html",
            "tauri://localhost/index.html?retry=2",
            "tauri://localhost/other.html?retry=1",
            "https://example.com/index.html?retry=1",
            "http://127.0.0.1:8765/index.html?retry=1",
        ] {
            assert!(!is_retry_address(&Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
