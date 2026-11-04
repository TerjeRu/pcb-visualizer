use tauri_build::{AppManifest, Attributes};

fn main() {
    tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(&["open_link"])),
    )
    .expect("could not build the app manifest");
}
