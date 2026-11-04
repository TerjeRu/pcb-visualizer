// PCB Visualizer desktop shell.
//
// The app itself is served by the local pcbv service; this shell only provides windows around it.
// On start it looks for a running service (the address and token pcbv advertises in
// $XDG_RUNTIME_DIR/pcbv/service.json, confirmed by /api/health). If there is none it starts one with
// `pcbv serve` (see startup.rs) and stops it again on exit. A service
// started by someone else is left alone. The window starts with a one-time login code minted from the
// advertised token, never with the token. Panel windows are opened by the app itself through Tauri's
// window API, each with a code of its own; see app/js/main.js.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Child;
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

mod guard;
mod links;
mod service;
mod startup;
mod window;
use guard::Allowed;
use service::Running;
use startup::{Failure, Phase, START_DEADLINE};

/// The service we started, so it can be stopped on exit.
struct Started(Mutex<Option<Child>>);

struct State(Mutex<Phase>);

/// The service folder of this checkout, in debug builds only: a release binary neither contains nor
/// uses the build path.
#[cfg(debug_assertions)]
fn checkout() -> Option<std::path::PathBuf> {
    Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../service"))
}

#[cfg(not(debug_assertions))]
fn checkout() -> Option<std::path::PathBuf> {
    None
}

/// Finds or starts the service within the deadline and returns the checked address and token.
fn start(handle: &AppHandle) -> Result<service::Service, Failure> {
    match service::running_service() {
        Running::Ready(found) => return Ok(found),
        Running::Incompatible => return Err(Failure::incompatible_running()),
        Running::Absent => {}
    }
    let began = Instant::now();
    let path = std::env::var_os("PATH");
    let service_dir = std::env::var_os("PCBV_SERVICE_DIR");
    let plan = startup::plan_start(
        path.as_deref(),
        service_dir.as_deref(),
        checkout().as_deref(),
    )?;
    let probe = || match service::running_service() {
        Running::Ready(_) => service::Health::Ready,
        Running::Incompatible => service::Health::Incompatible,
        Running::Absent => service::Health::Down,
    };
    startup::run_attempt(
        &plan,
        START_DEADLINE.saturating_sub(began.elapsed()),
        probe,
        &handle.state::<Started>().0,
    )?;
    match service::running_service() {
        Running::Ready(found) => Ok(found),
        _ => Err(Failure::stopped_answering()),
    }
}

/// Runs one start attempt on a new thread and shows its result in the main window.
fn spawn_attempt(handle: AppHandle) {
    thread::spawn(move || {
        let result = start(&handle);
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        match result {
            Ok((address, token)) => {
                // A one-time code (60 seconds, one use) travels in the fragment, which is never sent to
                // the server or logged. The page exchanges it for the token. Without a code (a stale
                // service.json, say) the app still opens and offers to paste the token.
                let code = service::mint_code(&address, &token);
                if handle
                    .add_capability(guard::service_capability(&address))
                    .is_err()
                {
                    let failure = Failure::stopped_answering();
                    *handle.state::<State>().0.lock().unwrap() = Phase::Failed;
                    if let Ok(base) = window.url() {
                        let _ = window.navigate(startup::failure_url(&base, &failure));
                    }
                    return;
                }
                *handle.state::<Allowed>().0.lock().unwrap() = Some(address.clone());
                *handle.state::<State>().0.lock().unwrap() = Phase::Ready;
                let _ = window.navigate(service::app_url(&address, code.as_deref()));
            }
            Err(failure) => {
                *handle.state::<State>().0.lock().unwrap() = Phase::Failed;
                if let Ok(base) = window.url() {
                    let _ = window.navigate(startup::failure_url(&base, &failure));
                }
            }
        }
    });
}

/// The splash's Retry button: only a failed start is started again.
fn retry(handle: &AppHandle) {
    {
        let state = handle.state::<State>();
        let mut phase = state.0.lock().unwrap();
        if !startup::retry_allowed(*phase) {
            return;
        }
        *phase = Phase::Starting;
    }
    let handle = handle.clone();
    thread::spawn(move || {
        if let Some(mut child) = handle.state::<Started>().0.lock().unwrap().take() {
            startup::stop_child(&mut child);
        }
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(mut url) = window.url() {
                url.set_query(None);
                let _ = window.navigate(url);
            }
        }
        spawn_attempt(handle);
    });
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Started(Mutex::new(None)))
        .manage(State(Mutex::new(Phase::Starting)))
        .manage(Allowed(Mutex::new(None)))
        .plugin(guard::navigation_plugin())
        .invoke_handler(tauri::generate_handler![links::open_link])
        .setup(|app| {
            let handle = app.handle().clone();
            let screen = app
                .primary_monitor()
                .ok()
                .flatten()
                // GDK has no primary monitor on Wayland; the first listed monitor is the next best guess.
                .or_else(|| {
                    app.available_monitors()
                        .ok()
                        .and_then(|all| all.into_iter().next())
                })
                .map(|monitor| {
                    let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    (size.width, size.height)
                });
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("pcbv");
            let builder = match window::initial_size(screen) {
                window::Initial::Sized(width, height) => builder.inner_size(width, height).center(),
                window::Initial::Maximized => builder.maximized(true),
            };
            builder
                .on_navigation({
                    let handle = handle.clone();
                    move |url| {
                        if startup::is_retry_address(url) {
                            retry(&handle);
                            return false;
                        }
                        true
                    }
                })
                .build()?;
            spawn_attempt(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start the PCB Visualizer window");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Started>().0.lock().unwrap().take() {
                startup::stop_child(&mut child);
            }
        }
    });
}
