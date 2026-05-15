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
//   3. Expose Tauri commands to the WebView:
//        get_pet()           -> { slug, mime, sprite_b64, frame_w, frame_h,
//                                 rows, cols, fps_per_state }
//        list_pets()         -> [slug, ...]   (for future pet-picker)
//        open_session_url()  -> launches `open <deeplink>` for card click
//   4. Emit a `pet-reload` event when the WebView calls reload_pet()
//      so the JS side can re-fetch and rebuild the animation.
//
// Pet picker logic stays in the CLI (mavis-pet switch); the floater
// just trusts whatever config.json says is active.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

// ---- v0.7.6 click-through hit-region polling -----------------------------
// macOS WKWebView does NOT pass clicks on transparent pixels through to
// apps below — even when CSS pointer-events:none is set on the html/body.
// Workaround: keep the window's NSWindow.ignoresMouseEvents in sync with
// where the cursor actually is. Pass-through (=true) when the cursor is
// over a transparent pixel, normal (=false) when it's over the sprite or
// a card. Web reports its interactive rectangles via set_interactive_rects;
// a background polling task does the spatial check at ~60 fps.
//
// Why polling instead of a JS-driven mouseenter/leave: when ignore=true,
// the WebView does not receive mouse events at all (the OS routes them
// to the window below), so JS can never observe "cursor came back". Only
// a polling loop OUTSIDE the WebView can see it.

#[derive(Clone, Default)]
struct InteractiveRects(Arc<Mutex<Vec<(f64, f64, f64, f64)>>>);

impl InteractiveRects {
    fn replace(&self, rects: Vec<(f64, f64, f64, f64)>) {
        if let Ok(mut g) = self.0.lock() {
            *g = rects;
        }
    }
    fn snapshot(&self) -> Vec<(f64, f64, f64, f64)> {
        self.0.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

/// v0.7.6.7 — shared, live window-position state, written from
/// (a) the startup positioning code and (b) WindowEvent::Moved on user
/// drag. The hit-region poller reads from this instead of NSPanel's
/// `[NSWindow frame]` (which goes stale under tauri-nspanel's swizzle
/// and silently keeps reporting the construction-time position).
///
/// Stored in PHYSICAL pixels, top-left, global coords (same units as
/// Tauri's PhysicalPosition / WindowEvent::Moved payload).
#[derive(Clone, Default)]
struct WindowFrameState(Arc<Mutex<Option<(f64, f64, f64, f64, f64)>>>);

impl WindowFrameState {
    fn set(&self, x: f64, y: f64, w: f64, h: f64, sf: f64) {
        if let Ok(mut g) = self.0.lock() {
            *g = Some((x, y, w, h, sf));
        }
    }
    fn snapshot(&self) -> Option<(f64, f64, f64, f64, f64)> {
        self.0.lock().ok().and_then(|g| *g)
    }
    fn move_to(&self, x: f64, y: f64) {
        if let Ok(mut g) = self.0.lock() {
            if let Some((_, _, w, h, sf)) = *g {
                *g = Some((x, y, w, h, sf));
            }
        }
    }
}

#[tauri::command]
fn set_interactive_rects(
    rects: Vec<[f64; 4]>,
    state: tauri::State<'_, InteractiveRects>,
) {
    let parsed: Vec<(f64, f64, f64, f64)> = rects
        .into_iter()
        .map(|r| (r[0], r[1], r[2], r[3]))
        .collect();
    state.replace(parsed);
}

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

/// Default pet slug used as a tie-breaker in `first_available_pet` when no
/// pet is explicitly active in `~/.mavis/pet/config.json`. v0.4.2: changed
/// from `boba` to `mikoko` (petdex/issues/241 — vino's coral-red octopus
/// submission). If `mikoko` isn't installed we fall through to the
/// alphabetically-first installed pet.
const DEFAULT_PET_SLUG: &str = "mikoko";

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
    // v0.4.2: prefer DEFAULT_PET_SLUG (mikoko) when present, regardless of
    // alphabetical order. This makes mikoko the out-of-the-box pet for
    // anyone who runs `mavis-pet start` without first calling `switch`.
    if let Some(dir) = locate_pet(DEFAULT_PET_SLUG) {
        let pet_json = dir.join("pet.json");
        let webp = dir.join("spritesheet.webp");
        let png = dir.join("spritesheet.png");
        if pet_json.exists() && (webp.exists() || png.exists()) {
            return Some((DEFAULT_PET_SLUG.to_string(), dir));
        }
    }

    // Fallback: first installed pet by lexicographic name across all bases.
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
    /// Optional explicit state→row map. Lets adapters (e.g. petdex) override
    /// the default "STATES array index = row index" assumption when the
    /// spritesheet uses a different row order. Keys are the mavis-pet states
    /// (idle/wave/run/jump/review/failed/extra1/extra2). When absent, the
    /// floater falls back to the implicit positional mapping.
    #[serde(skip_serializing_if = "Option::is_none")]
    state_rows: Option<BTreeMap<String, u32>>,
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
    let mut state_rows: Option<BTreeMap<String, u32>> = None;

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
            if let Some(map) = v.get("state_rows").and_then(|x| x.as_object()) {
                let mut parsed: BTreeMap<String, u32> = BTreeMap::new();
                for (k, val) in map {
                    if let Some(n) = val.as_u64() {
                        parsed.insert(k.clone(), n as u32);
                    }
                }
                if !parsed.is_empty() {
                    state_rows = Some(parsed);
                }
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
        state_rows,
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

/// v0.6.1 — open a MiniMax deeplink (e.g. `minimax-cn-test://chat?chat_id=…`)
/// or fall back to focusing the MiniMax Test app, called from the floater's
/// JS card click handler.
///
/// Behavior:
///   - empty / None url → `open -a "MiniMax Test"` (focus only)
///   - any of the known MiniMax URL schemes → `open <url>` (deeplink)
///   - anything else → reject (defends against injected payloads)
///
/// We hardcode `/usr/bin/open` to avoid PATH lookup races and don't rely
/// on tauri-plugin-shell (would require a capability allow + bumps the
/// closed-shell-allowlist surface area).
#[tauri::command]
fn open_session_url(url: Option<String>) -> Result<(), String> {
    let raw = url.unwrap_or_default();
    let trimmed = raw.trim();

    // Empty / focus-only fallback path (Step 0 fallback when broker has no
    // deeplink template configured or MiniMax main process can't navigate
    // to a specific session yet).
    if trimmed.is_empty() {
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-a", "MiniMax Test"])
            .status()
            .map_err(|e| format!("spawn open -a: {e}"))?;
        if !status.success() {
            return Err(format!("open -a exited with {status}"));
        }
        return Ok(());
    }

    // Whitelist: only known MiniMax URL schemes (Test / Staging / Prod, EN/CN).
    let allowed_schemes = [
        "minimax://",
        "minimax-cn://",
        "minimax-test://",
        "minimax-cn-test://",
        "minimax-staging://",
        "minimax-cn-staging://",
    ];
    if !allowed_schemes.iter().any(|p| trimmed.starts_with(p)) {
        return Err(format!("rejected non-MiniMax URL scheme: {trimmed}"));
    }

    let status = std::process::Command::new("/usr/bin/open")
        .arg(trimmed)
        .status()
        .map_err(|e| format!("spawn open: {e}"))?;
    if !status.success() {
        return Err(format!("open exited with {status}"));
    }
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
        .manage(InteractiveRects::default())
        .manage(WindowFrameState::default())
        .invoke_handler(tauri::generate_handler![
            get_pet,
            list_pets,
            reload_pet,
            open_session_url,
            set_interactive_rects
        ])
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

                // v0.7.6.6 — defer positioning by 500ms. Calling
                // set_position inside the setup hook (right after
                // install_pet_panel.show()) gets overridden by NSPanel's
                // own show-time position handling — the actual visible
                // panel ended up at its construction-time position. A
                // brief delay lets the panel settle, then set_position
                // sticks.
                let window_for_pos = window.clone();
                let frame_state: tauri::State<'_, WindowFrameState> = app.state();
                let frame_state_clone = frame_state.inner().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    position_bottom_right_v2(&window_for_pos, &frame_state_clone);
                });

                // v0.7.6.7 — keep WindowFrameState in sync with user drags.
                // tauri-nspanel's NSWindow swizzle makes [NSWindow frame]
                // stale, so the poller can't read live position from
                // AppKit; instead it reads from WindowFrameState which we
                // update here on every move event.
                let frame_state_for_event = frame_state.inner().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(pos) = event {
                        // pos is PhysicalPosition<i32>, top-left, global.
                        frame_state_for_event.move_to(pos.x as f64, pos.y as f64);
                    }
                });

                // v0.7.6 — start the click-through hit-region polling task.
                // 8ms cadence (~120 fps) is responsive enough that the user
                // doesn't notice the toggle when crossing the sprite border.
                let rects: tauri::State<'_, InteractiveRects> = app.state();
                let frame_state_for_poll = frame_state.inner().clone();
                spawn_hit_region_poller(window.clone(), rects.inner().clone(), frame_state_for_poll);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mavis-pet-floater");
}

#[cfg(target_os = "macos")]
fn position_bottom_right(window: &tauri::WebviewWindow, _margin_px: i32) {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSRect;
    unsafe {
        let main_screen: id = NSScreen::mainScreen(nil);
        if main_screen == nil { return; }
        // visibleFrame excludes the menu bar (top) and the Dock area —
        // safer than frame() for "right-bottom corner" placement.
        let vis: NSRect = NSScreen::visibleFrame(main_screen);
        // visibleFrame uses macOS BOTTOM-LEFT logical points. Tauri
        // set_position uses TOP-LEFT logical points relative to the
        // primary screen (origin top-left).
        // Convert: vis.origin is bottom-left in macOS coords; the bottom
        // of the visible area in TOP-LEFT coords is the screen height
        // minus visiblY.
        let full: NSRect = NSScreen::frame(main_screen);
        let screen_top_height = full.size.height as f64;
        let vis_x = vis.origin.x as f64;
        let vis_y_bottomleft = vis.origin.y as f64;
        let vis_w = vis.size.width as f64;
        let vis_h = vis.size.height as f64;
        // Top-Y of the visible area (in top-left coords).
        let vis_top_y = screen_top_height - (vis_y_bottomleft + vis_h);

        let win_w = 380.0;
        let win_h = 400.0;
        // The sprite sits at the bottom-RIGHT of the window. To put the
        // VISIBLE Pikachu at the bottom-right of the screen, we need the
        // window's bottom-right to be inside the visible area. Add a small
        // margin so the chevron isn't clipped (chevron pokes 4px right).
        let margin = 20.0;
        let x = (vis_x + vis_w - win_w + margin).max(vis_x);  // +margin pushes window slightly off-screen-right so the sprite (which sits at window's right edge) lands ON the screen edge
        let y = (vis_top_y + vis_h - win_h + margin).max(vis_top_y);
        // Debug log so we can see what we calculated.
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open(dirs::home_dir().unwrap_or_default().join(".mavis/pet/logs/floater-hitregion.log")) {
            use std::io::Write;
            let _ = writeln!(
                f,
                "[STARTUP] mainScreen full=({:.0},{:.0},{:.0},{:.0}) vis=({:.0},{:.0},{:.0},{:.0}) vis_top_y={:.0} -> set_position logical=({:.0},{:.0})",
                full.origin.x as f64, full.origin.y as f64, full.size.width as f64, full.size.height as f64,
                vis_x, vis_y_bottomleft, vis_w, vis_h,
                vis_top_y, x, y
            );
        }
        let _ = window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition { x, y },
        ));
    }
}

#[cfg(not(target_os = "macos"))]
fn position_bottom_right(_window: &tauri::WebviewWindow, _margin_px: i32) {}

/// v0.7.6.5 — Tauri-API-only positioning. Uses Window::current_monitor()
/// which returns physical-pixel monitor info in the SAME coordinate space
/// that Tauri's set_position(PhysicalPosition) expects. Avoids the cocoa
/// logical-vs-Tauri-global-logical mismatch that pushed Pikachu off-screen
/// on multi-monitor setups.
fn position_bottom_right_v2(window: &tauri::WebviewWindow, frame_state: &WindowFrameState) {
    // Try current_monitor (where the window sits) first; fall back to
    // primary_monitor (whichever screen Tauri considers primary) if the
    // window hasn't settled on a monitor yet.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let monitor = match monitor {
        Some(m) => m,
        None => return,
    };
    let mp = monitor.position();   // PhysicalPosition<i32>
    let ms = monitor.size();        // PhysicalSize<u32>
    let sf = monitor.scale_factor(); // f64

    // Window logical size from conf (380x400). Convert to physical.
    let win_w_phys = (380.0 * sf) as i32;
    let win_h_phys = (400.0 * sf) as i32;
    let margin_phys = (40.0 * sf) as i32;
    let dock_phys = (110.0 * sf) as i32;

    let new_x = mp.x + (ms.width as i32) - win_w_phys - margin_phys;
    let new_y = mp.y + (ms.height as i32) - win_h_phys - dock_phys;

    let clamp_x = new_x.max(mp.x);
    let clamp_y = new_y.max(mp.y);

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(dirs::home_dir().unwrap_or_default().join(".mavis/pet/logs/floater-hitregion.log")) {
        use std::io::Write;
        let _ = writeln!(
            f,
            "[STARTUP v2] monitor pos=({},{}) size={}x{} sf={} -> set_position physical=({},{}) (clamp={},{})",
            mp.x, mp.y, ms.width, ms.height, sf, new_x, new_y, clamp_x, clamp_y
        );
    }

    let _ = window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition { x: clamp_x, y: clamp_y },
    ));
    // v0.7.6.7 — record the live position into shared state. The poller
    // reads from here instead of NSPanel's stale [NSWindow frame].
    frame_state.set(
        clamp_x as f64, clamp_y as f64,
        win_w_phys as f64, win_h_phys as f64,
        sf,
    );
}

/// Background task: every 8ms read the global cursor position, compare to
/// the union of interactive rects (in window-local CSS pixels) reported by
/// the WebView, and toggle ignoresMouseEvents on the panel accordingly.
fn spawn_hit_region_poller(
    window: tauri::WebviewWindow,
    rects: InteractiveRects,
    frame_state: WindowFrameState,
) {
    std::thread::spawn(move || {
        // v0.7.6.2 debug — write polling state to a log file so we can
        // diagnose without relying on stderr (launchd plist captures the
        // CLI's stderr, not the floater child process's).
        let log_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".mavis/pet/logs/floater-hitregion.log");
        let mut log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        let mut tick: u64 = 0;
        // Last known state, used to skip redundant invocations.
        let mut last_ignore: Option<bool> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(8));
            tick += 1;

            // 1. Cursor position. mouse_position::Mouse on macOS calls
            //    CGEvent::location() which returns CGPoint in LOGICAL
            //    POINTS (top-left global), NOT physical pixels. We
            //    therefore work in logical points throughout — convert
            //    the window frame from physical to logical via sf.
            let cursor = match mouse_position::mouse_position::Mouse::get_mouse_position() {
                mouse_position::mouse_position::Mouse::Position { x, y } => (x as f64, y as f64),
                _ => continue,
            };

            // 2. Live window frame from WindowFrameState (kept in sync
            //    by startup positioning + WindowEvent::Moved). Don't use
            //    read_panel_frame_top_left — its [NSWindow frame] call
            //    goes stale under tauri-nspanel's swizzle, locking the
            //    poller to the construction-time position.
            let (wx_phys, wy_phys, ww_phys, wh_phys, sf) = match frame_state.snapshot() {
                Some(v) => v,
                None => continue,  // not positioned yet (first 500ms)
            };
            // Convert to logical points to match cursor units.
            let wx = wx_phys / sf;
            let wy = wy_phys / sf;
            let ww = ww_phys / sf;
            let wh = wh_phys / sf;

            // 3. Quick reject: cursor outside the window's outer frame.
            let inside_window = cursor.0 >= wx
                && cursor.0 < wx + ww
                && cursor.1 >= wy
                && cursor.1 < wy + wh;

            // 4. Inside the window: convert cursor to CSS pixels relative
            //    to the WebView's top-left and check against the rect set.
            //    CSS pixels == logical points on macOS, so this is just
            //    a translate (no further scaling).
            let snapshot = rects.snapshot();
            let cursor_in_interactive = if inside_window {
                let local_x = cursor.0 - wx;
                let local_y = cursor.1 - wy;
                snapshot.iter().any(|(rx, ry, rw, rh)| {
                    local_x >= *rx
                        && local_x < *rx + *rw
                        && local_y >= *ry
                        && local_y < *ry + *rh
                })
            } else {
                false
            };

            let want_ignore = !cursor_in_interactive;
            if last_ignore != Some(want_ignore) {
                let _ = window.set_ignore_cursor_events(want_ignore);
                last_ignore = Some(want_ignore);
                if let Some(f) = log_file.as_mut() {
                    use std::io::Write;
                    let _ = writeln!(
                        f,
                        "[t={}] cursor=({:.0},{:.0}) win=({:.0},{:.0},{:.0},{:.0}) inside_win={} rects={} in_interactive={} -> ignore={}",
                        tick, cursor.0, cursor.1, wx, wy, ww, wh,
                        inside_window, snapshot.len(), cursor_in_interactive, want_ignore
                    );
                    let _ = f.flush();
                }
            }
            // Heartbeat every ~5s.
            if tick % 625 == 0 {
                if let Some(f) = log_file.as_mut() {
                    use std::io::Write;
                    let first_rect = snapshot.first()
                        .map(|(x, y, w, h)| format!("[{:.0},{:.0},{:.0},{:.0}]", x, y, w, h))
                        .unwrap_or_else(|| "none".to_string());
                    let _ = writeln!(
                        f,
                        "[t={} HB] cursor=({:.0},{:.0}) win=({:.0},{:.0},{:.0},{:.0}) sf={} rects={} first_rect={} ignore={:?}",
                        tick, cursor.0, cursor.1, wx, wy, ww, wh, sf, snapshot.len(), first_rect, last_ignore
                    );
                    let _ = f.flush();
                }
            }
        }
    });
}

/// Read the live NSPanel frame (origin + size) directly via AppKit.
/// Returns (x, y, w, h) in TOP-LEFT origin, PHYSICAL pixels — same
/// convention as mouse_position::Mouse::Position on macOS.
///
/// Why not Tauri's `window.outer_position()` / `outer_size()`?
/// tauri-nspanel swizzles the underlying NSWindow class but Tauri's
/// runtime still serves outer_position() from a cache populated at
/// construction time. After the user drags the panel, that cache is
/// stale — outer_position() returns the panel's INITIAL position, not
/// where the user dragged it to. set_ignore_cursor_events gating
/// requires the LIVE position; only [NSWindow frame] gives that.
#[cfg(target_os = "macos")]
fn read_panel_frame_top_left(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64, f64)> {
    use cocoa::appkit::{NSScreen, NSWindow};
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSRect};
    let ns_window: id = window.ns_window().ok()? as id;
    if ns_window.is_null() { return None; }
    unsafe {
        // [NSWindow frame] — bottom-left origin, points (logical px).
        let frame: NSRect = NSWindow::frame(ns_window);
        // Backing scale factor of the window's screen.
        let screen: id = ns_window.screen();
        let sf: f64 = if screen != nil {
            NSScreen::backingScaleFactor(screen) as f64
        } else {
            1.0
        };
        // Convert bottom-left → top-left. Use the primary screen height as
        // reference (matches macOS top-left convention used by Tauri /
        // mouse_position).
        let screens: id = NSScreen::screens(nil);
        if screens == nil || screens.count() == 0 { return None; }
        let primary: id = screens.objectAtIndex(0);
        let primary_frame: NSRect = NSScreen::frame(primary);
        let primary_height = primary_frame.size.height as f64;

        let x_logical = frame.origin.x as f64;
        let y_bottom_logical = frame.origin.y as f64;
        let w_logical = frame.size.width as f64;
        let h_logical = frame.size.height as f64;
        let y_top_logical = primary_height - (y_bottom_logical + h_logical);

        let x = x_logical * sf;
        let y = y_top_logical * sf;
        let w = w_logical * sf;
        let h = h_logical * sf;
        Some((x, y, w, h, sf))
    }
}

#[cfg(not(target_os = "macos"))]
fn read_panel_frame_top_left(_window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64, f64)> {
    None
}

// keep compile unused-var lint quiet
#[allow(dead_code)]
fn _unused_path_helper(_p: &Path) {}
