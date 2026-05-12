// mavis-pet floater — Tauri v2 transparent always-on-top sprite window.
//
// Window properties (transparent, frameless, alwaysOnTop, no shadow) are
// declared in tauri.conf.json. macOSPrivateApi=true is required there
// AND the `macos-private-api` feature in Cargo.toml — both must match.
//
// Backend responsibility:
//   1. Locate the active pet (from ~/.mavis/pet/config.json or first
//      pet found in ~/.mavis/pets/ or ~/.codex/pets/).
//   2. Read the spritesheet bytes and pet.json metadata.
//   3. Expose two Tauri commands to the WebView:
//        get_pet()   -> { slug, mime, sprite_b64, frame_w, frame_h,
//                         rows, cols, fps_per_state }
//        list_pets() -> [slug, ...]   (for future pet-picker)
//   4. Emit a `pet-reload` event when the WebView calls reload_pet()
//      so the JS side can re-fetch and rebuild the animation.
//
// Pet picker logic stays in the CLI (mavis-pet switch); the floater
// just trusts whatever config.json says is active.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

// ---- macOS: lift floater above fullscreen Spaces & menu bar ---------------
//
// v0.4.1 — On macOS 26 plain NSWindow can NOT be made to ride above other
// apps' fullscreen Spaces, no matter what NSWindowCollectionBehavior flags
// or NSWindowLevel you set. macOS 26 only honors FullScreenAuxiliary on
// NSPanel subclasses. We use `tauri-nspanel` (BongoCat 20.8k⭐ same
// use-case dependency) to swizzle Tauri's default NSWindow into an
// NSPanel subclass with NonactivatingPanel mask, which is the only
// macOS-26-compatible path. Setting setLevel to anything > NSDockWindowLevel
// (=20) actually *triggers* fullscreen lockdown and blocks IME, so we
// stay at PanelLevel::Dock.

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, PanelLevel, StyleMask,
    WebviewWindowExt as _,
};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(PetPanel {
        config: {
            // Desktop pet — never wants keyboard focus (would steal IME).
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
        }
    })
}

/// Convert Tauri's default NSWindow into an NSPanel via tauri-nspanel,
/// then apply the macOS-26-compatible visibility flags. Replaces the
/// pre-v0.4.1 raw cocoa setCollectionBehavior + setLevel approach
/// (which silently no-ops on macOS 26).
#[cfg(target_os = "macos")]
fn install_pet_panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    let panel = window
        .to_panel::<PetPanel>()
        .map_err(|e| format!("to_panel: {e:?}"))?;

    // Dock level (=20). NOT NSScreenSaverWindowLevel (1000) — high level
    // triggers macOS 26 fullscreen lockdown and blocks IME (verified by
    // tauri-nspanel issue #104).
    panel.set_level(PanelLevel::Dock.value());

    // NonactivatingPanel mask — required so the panel does NOT become
    // active app on click, AND is what makes macOS 26 honor the
    // FullScreenAuxiliary collection behavior.
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());

    // Now collection behavior flags actually take effect (they didn't on
    // plain NSWindow under macOS 26):
    //   - can_join_all_spaces: appear on every Space, not just current
    //   - full_screen_auxiliary: ride on top of other apps' fullscreen
    //   - stationary: don't move with Space-switch animation
    //
    // NOTE: tried `move_to_active_space()` in place of `stationary()` to
    // try to eliminate the small flicker on Space transitions — broke the
    // "follow into fullscreen" behavior entirely. The two flags are
    // mutually exclusive at the macOS level: move_to_active_space says
    // "I live in one Space at a time and follow you", which conflicts
    // with can_join_all_spaces ("I exist in every Space simultaneously").
    // Accepting the small flicker as a known minor visual cost — the
    // primary fix (visible above fullscreen) is intact.
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .into(),
    );

    panel.show();
    eprintln!("[mavis-pet-floater] PetPanel installed (NSPanel + nonactivating + FullScreenAuxiliary, level=Dock)");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_pet_panel(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Set NSApplication activation policy to **Accessory** (background app).
/// Required so this binary doesn't show up in the Dock and doesn't steal
/// focus. Combined with the NSPanel + nonactivating_panel mask above,
/// this gives the standard macOS desktop-widget profile.
#[cfg(target_os = "macos")]
fn set_accessory_activation_policy() {
    use cocoa::appkit::{NSApp, NSApplication, NSApplicationActivationPolicy};
    unsafe {
        let app = NSApp();
        app.setActivationPolicy_(
            NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
        );
        eprintln!("[mavis-pet-floater] NSApplication activationPolicy = Accessory");
    }
}

#[cfg(not(target_os = "macos"))]
fn set_accessory_activation_policy() {}

#[cfg(not(target_os = "macos"))]
fn elevate_for_fullscreen(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

// ---- Pet discovery ---------------------------------------------------------

fn pets_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    vec![home.join(".mavis/pets"), home.join(".codex/pets")]
}

fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    home.join(".mavis/pet/config.json")
}

fn read_active_slug() -> Option<String> {
    let path = config_path();
    let txt = fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    v.get("active")?.as_str().map(|s| s.to_string())
}

fn locate_pet(slug: &str) -> Option<PathBuf> {
    for base in pets_dirs() {
        let candidate = base.join(slug);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn first_available_pet() -> Option<(String, PathBuf)> {
    for base in pets_dirs() {
        if let Ok(read) = fs::read_dir(&base) {
            let mut entries: Vec<_> = read
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let path = entry.path();
                let pet_json = path.join("pet.json");
                let webp = path.join("spritesheet.webp");
                let png = path.join("spritesheet.png");
                if pet_json.exists() && (webp.exists() || png.exists()) {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        return Some((name.to_string(), path.clone()));
                    }
                }
            }
        }
    }
    None
}

fn list_all_pets() -> Vec<String> {
    let mut out = Vec::new();
    for base in pets_dirs() {
        if let Ok(read) = fs::read_dir(&base) {
            for entry in read.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let has_pet = path.join("pet.json").exists()
                    && (path.join("spritesheet.webp").exists()
                        || path.join("spritesheet.png").exists());
                if !has_pet {
                    continue;
                }
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !out.iter().any(|s: &String| s == name) {
                        out.push(name.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

// ---- Pet payload ----------------------------------------------------------

#[derive(Serialize, Clone)]
struct PetPayload {
    slug: String,
    mime: String,
    sprite_b64: String,
    frame_w: u32,
    frame_h: u32,
    rows: u32,
    cols: u32,
    /// Frames per animation row (subset of cols actually used)
    frame_count: u32,
    // CSS animation duration in ms per row (idle/wave/run/failed/...)
    frame_duration_ms: u32,
}

fn load_pet_payload(slug_hint: Option<String>) -> Result<PetPayload, String> {
    // resolve slug
    let (slug, dir) = match slug_hint {
        Some(s) => match locate_pet(&s) {
            Some(d) => (s, d),
            None => return Err(format!("pet '{s}' not found")),
        },
        None => match read_active_slug().and_then(|s| locate_pet(&s).map(|d| (s, d))) {
            Some(pair) => pair,
            None => first_available_pet()
                .ok_or_else(|| "no pets installed (run `mavis-pet install <slug>`)".to_string())?,
        },
    };

    // load spritesheet
    let webp = dir.join("spritesheet.webp");
    let png = dir.join("spritesheet.png");
    let (sprite_path, mime) = if webp.exists() {
        (webp, "image/webp")
    } else if png.exists() {
        (png, "image/png")
    } else {
        return Err(format!("no spritesheet in {}", dir.display()));
    };
    let bytes = fs::read(&sprite_path).map_err(|e| format!("read sprite: {e}"))?;
    let sprite_b64 = B64.encode(&bytes);

    // pet.json may declare frame size / rows / cols / loop ms; fall back to
    // petdex defaults (192x208, 8 cols × 9 rows, 1100ms / 6 frames per state).
    // Actual petdex spritesheets measure 1536 × 1872 = 8 col × 9 row.
    let mut frame_w: u32 = 192;
    let mut frame_h: u32 = 208;
    let mut rows: u32 = 9;
    let mut cols: u32 = 8;
    // Each row uses the FIRST 6 frames as the looping animation; the
    // remaining 2 frames per row are reserved/unused per petdex spec.
    let mut frame_count: u32 = 6;
    let mut frame_duration_ms: u32 = 1100;

    if let Ok(raw) = fs::read_to_string(dir.join("pet.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(n) = v.get("frame_w").and_then(|x| x.as_u64()) {
                frame_w = n as u32;
            }
            if let Some(n) = v.get("frame_h").and_then(|x| x.as_u64()) {
                frame_h = n as u32;
            }
            if let Some(n) = v.get("rows").and_then(|x| x.as_u64()) {
                rows = n as u32;
            }
            if let Some(n) = v.get("cols").and_then(|x| x.as_u64()) {
                cols = n as u32;
            }
            if let Some(n) = v.get("frame_count").and_then(|x| x.as_u64()) {
                frame_count = n as u32;
            }
            if let Some(n) = v.get("frame_duration_ms").and_then(|x| x.as_u64()) {
                frame_duration_ms = n as u32;
            }
        }
    }

    Ok(PetPayload {
        slug,
        mime: mime.to_string(),
        sprite_b64,
        frame_w,
        frame_h,
        rows,
        cols,
        frame_count,
        frame_duration_ms,
    })
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
fn get_pet(slug: Option<String>) -> Result<PetPayload, String> {
    load_pet_payload(slug)
}

#[tauri::command]
fn list_pets() -> Vec<String> {
    list_all_pets()
}

#[tauri::command]
fn reload_pet(app: tauri::AppHandle) -> Result<(), String> {
    app.emit("pet-reload", ())
        .map_err(|e| format!("emit: {e}"))?;
    Ok(())
}

// ---- Entry point ----------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // tauri-nspanel plugin MUST be registered BEFORE any setup hook calls
        // `to_panel()` — it installs the PanelManager state container that
        // `to_panel` looks up. If we register after setup, `to_panel` panics
        // with "PanelManager not found in app state".
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![get_pet, list_pets, reload_pet])
        .setup(|app| {
            // Touch the path to surface "no home dir" failures early in stderr.
            let _ = config_path();
            // Switch to Accessory app type (no Dock entry, no focus stealing).
            // Combined with NSPanel + nonactivating_panel mask below, this is
            // the canonical macOS desktop-widget profile.
            set_accessory_activation_policy();

            // v0.4.1 — swap Tauri's default NSWindow for an NSPanel via
            // tauri-nspanel. macOS 26 stopped honoring FullScreenAuxiliary on
            // plain NSWindow; only NSPanel subclasses are allowed to ride
            // above other apps' fullscreen Spaces. set_visible_on_all_workspaces
            // remains useful as a hint but no longer sufficient on its own.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_visible_on_all_workspaces(true);

                #[cfg(target_os = "macos")]
                if let Err(e) = install_pet_panel(&window) {
                    eprintln!("[mavis-pet-floater] panel install failed: {e}");
                }
                // No watchdog — NSPanel's collectionBehavior + level survive
                // fullscreen / Space transitions natively, unlike the v0.4.0
                // raw-NSWindow approach.
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mavis-pet-floater");
}

// keep compile unused-var lint quiet
#[allow(dead_code)]
fn _unused_path_helper(_p: &Path) {}
