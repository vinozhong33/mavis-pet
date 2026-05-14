/**
 * mavis-pet `install` wizard — 7-step one-shot bootstrap for the
 * "company mavis engineer with MiniMax Test app" scenario.
 *
 * Goal: `npx -y mavis-pet@latest install` (no slug) → desktop shows boba in
 * the bottom-right within ~5 minutes, autostart-on-login configured, fully
 * non-interactive after a single welcome confirmation.
 *
 * Steps (printed as `[i/7] <name> ...`):
 *   1. welcome           — one-line description + wait for Enter (skipped in
 *                          non-interactive shells)
 *   2. detect MiniMax    — `lsof -i :15321` (just a warning if not running,
 *                          per Q3 = "do nothing, only warn")
 *   3. floater binary    — copy bundled / dev-built floater to
 *                          ~/.mavis/pet/floater + chmod +x
 *   4. mavis hooks       — register the 6 mavis hooks via cmdHookInstall
 *   5. default pet       — try petdex CLI for boba; fallback to in-tree
 *                          bundled mikoko so first-time experience never
 *                          fails due to network
 *   6. launchd plist     — write user-level plist to
 *                          ~/Library/LaunchAgents/dev.mavis.pet.plist
 *                          (per Q2 = B, no sudo, no /Applications/)
 *   7. launchctl load    — `bootstrap gui/$(id -u)` (macOS 12+ idiom) then
 *                          poll /healthz for broker readiness
 *
 * Re-entry semantics:
 *   - re-running install detects an existing plist, calls `bootout` first,
 *     then re-writes + reloads (idempotent)
 *   - hook ledger: cmdHookInstall already short-circuits on full ledger
 *
 * Test sandboxing:
 *   - Pass `home: <tmpdir>` to redirect ALL filesystem writes (state dir,
 *     plist dir, etc.) into a tempdir
 *   - Pass `noLaunchd: true` to skip launchctl invocations in unit tests
 *
 * Files we create/touch (under `home`, default = os.homedir()):
 *   .mavis/pet/floater                       (binary, copied + chmod 755)
 *   .mavis/pets/<slug>/                      (default pet, via cmdInstall)
 *   .mavis/pet/installed-hooks.json          (hook ledger, via cmdHookInstall)
 *   Library/LaunchAgents/dev.mavis.pet.plist (launchd autostart)
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';

// Re-export the daemon port so the CLI's --help can stay in sync.
export const HJBHXEG_DAEMON_PORT = 15321;
export const BROKER_DEFAULT_PORT = 7857;
export const LAUNCHD_LABEL = 'dev.mavis.pet';
export const TOTAL_STEPS = 7;
export const DEFAULT_PET_SLUG = 'boba';
export const FALLBACK_PET_SLUG = 'mikoko'; // bundled in packages/cli/assets/pets/

// ---- types -----------------------------------------------------------------

export interface WizardOptions {
  /** Override $HOME for sandboxing. Default: os.homedir(). */
  home?: string;
  /** Skip ALL launchctl invocations. Default: auto (true if not darwin). */
  noLaunchd?: boolean;
  /** Skip the welcome readline pause. Default: auto (true if stdin not TTY). */
  skipWelcome?: boolean;
  /** Skip pet install attempt (used by uninstall preview / tests). */
  skipPetInstall?: boolean;
  /** Override path to the mavis-pet bin (the launchd plist needs an absolute path). */
  cliBinPath?: string;
  /** Override path to the floater binary source. Default: auto-resolve. */
  floaterSource?: string;
  /** Skip broker /healthz polling (testing). */
  skipHealthz?: boolean;
  /** Test hook: invoked instead of spawnSync('launchctl', ...). */
  launchctl?: (args: string[]) => { status: number; stdout: string; stderr: string };
  /** Test hook: invoked instead of `npx petdex install <slug>`. */
  petdexInstaller?: (slug: string) => { ok: boolean; reason?: string };
}

export interface StepResult {
  step: number;
  name: string;
  status: 'ok' | 'warn' | 'error' | 'skip';
  message: string;
}

// ---- pure helpers ----------------------------------------------------------

/**
 * Generate the launchd .plist XML content. Pure function; takes resolved
 * absolute paths (no $HOME / ~ expansion — launchd does not expand env
 * vars in path positions, so the caller must pre-resolve via os.homedir()).
 *
 * The EnvironmentVariables.PATH is critical: launchd-spawned processes get
 * a minimal PATH (usually /usr/bin:/bin:/usr/sbin:/sbin) which can miss
 * /usr/local/bin (Homebrew) and the user's .npm-global/bin, so any nested
 * shell-out (e.g. spawnSync('npx', ...) inside the wizard) silently fails.
 */
export function generateLaunchdPlist(opts: {
  label: string;
  programArgs: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  pathEnv: string;
  homeEnv: string;
}): string {
  const argLines = opts.programArgs
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(opts.pathEnv)}</string>
    <key>HOME</key>
    <string>${escapeXml(opts.homeEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Check whether a TCP port is listening on 127.0.0.1. */
export function checkPortListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

/** GET http://127.0.0.1:<port>/healthz. Resolves true on 2xx. */
export function checkBrokerHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: timeoutMs }, (res) => {
      res.resume();
      const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Resolve the floater binary location. Search order:
 *   1. opts.floaterSource (test override)
 *   2. env MAVIS_PET_FLOATER
 *   3. <home>/.mavis/pet/floater (already-installed user copy)
 *   4. dev workspace: <packages/floater/target/release/mavis-pet-floater>
 *      (relative to this module — works in dev when cli.ts and floater
 *       live in the same monorepo)
 *   5. arch-aware bundled: <packages/cli/assets/floater-binary/<platform>-<arch>/mavis-pet-floater>
 *      (this path IS in the npm tarball via package.json `files: ["assets"]`,
 *       so v0.7.0+ npm install ships the floater binary out of the box).
 *   6. legacy bundled: <packages/cli/floater-binary/mavis-pet-floater>
 *      (kept for compat in case someone shipped this layout in 0.6.x)
 * Returns null if none found.
 */
export function locateFloaterBinary(opts: { home: string; floaterSource?: string; moduleDir: string }): string | null {
  const candidates: string[] = [];
  if (opts.floaterSource) candidates.push(opts.floaterSource);
  if (process.env.MAVIS_PET_FLOATER) candidates.push(process.env.MAVIS_PET_FLOATER);
  candidates.push(path.join(opts.home, '.mavis/pet/floater'));
  candidates.push(path.resolve(opts.moduleDir, '../../floater/target/release/mavis-pet-floater'));
  // v0.7.0: arch-aware bundled binary, shipped in npm tarball under assets/.
  // process.arch on Apple Silicon = "arm64"; process.platform on macOS = "darwin".
  const archDir = `${process.platform}-${process.arch}`;
  candidates.push(path.resolve(opts.moduleDir, `../assets/floater-binary/${archDir}/mavis-pet-floater`));
  candidates.push(path.resolve(opts.moduleDir, '../floater-binary/mavis-pet-floater'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/** Return the resolved CLI bin path. Used as ProgramArguments[0]. */
export function resolveCliBinPath(override?: string): string {
  if (override) return override;
  // 1. argv[1] — when run via `node /path/to/cli.js install`, argv[1] is the
  //    cli.js path (works for both dev `node packages/cli/dist/cli.js` and
  //    npm-installed `~/.npm-global/lib/node_modules/mavis-pet/dist/cli.js`).
  // 2. Fallback to looking up `mavis-pet` in PATH via `which`.
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) {
    return argv1;
  }
  const r = spawnSync('which', ['mavis-pet'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // Last resort: hardcoded npm-global path. Caller should override in prod.
  return path.join(os.homedir(), '.npm-global/bin/mavis-pet');
}

// ---- step implementations --------------------------------------------------

function logStep(step: number, name: string, status: StepResult['status'], message: string): StepResult {
  const tag =
    status === 'ok' ? kleur.green('✓') :
    status === 'warn' ? kleur.yellow('⚠') :
    status === 'skip' ? kleur.dim('—') :
    kleur.red('✗');
  console.log(`${kleur.dim(`[${step}/${TOTAL_STEPS}]`)} ${name} ${tag} ${kleur.dim(message)}`);
  return { step, name, status, message };
}

async function step1Welcome(opts: WizardOptions): Promise<StepResult> {
  // skip if explicitly requested, OR stdin isn't a TTY (npx in a script,
  // CI, etc.), OR the MAVIS_PET_NONINTERACTIVE env var is set.
  const skip =
    opts.skipWelcome === true ||
    !process.stdin.isTTY ||
    process.env.MAVIS_PET_NONINTERACTIVE === '1';
  if (skip) {
    return logStep(1, 'welcome', 'skip', 'non-interactive mode (TTY=false or MAVIS_PET_NONINTERACTIVE=1)');
  }
  console.log('');
  console.log(kleur.bold('  mavis-pet install wizard'));
  console.log('');
  console.log('  This will install the desktop pet + configure launchd autostart (~30s).');
  console.log('  Press Enter to continue, Ctrl+C to abort.');
  console.log('');
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('> ', () => { rl.close(); resolve(); });
  });
  return logStep(1, 'welcome', 'ok', 'confirmed');
}

async function step2DetectHjbhxeg(_opts: WizardOptions): Promise<StepResult> {
  const listening = await checkPortListening(HJBHXEG_DAEMON_PORT);
  if (listening) {
    return logStep(2, 'MiniMax detect', 'ok', `daemon listening on :${HJBHXEG_DAEMON_PORT}`);
  }
  return logStep(
    2,
    'MiniMax detect',
    'warn',
    `not running (port :${HJBHXEG_DAEMON_PORT} closed) — wizard continues, but pet won't see status changes until you launch the MiniMax Test app`,
  );
}

function step3InstallFloater(opts: WizardOptions, moduleDir: string): StepResult {
  const home = opts.home ?? os.homedir();
  const dest = path.join(home, '.mavis/pet/floater');
  const src = locateFloaterBinary({ home, floaterSource: opts.floaterSource, moduleDir });
  if (!src) {
    return logStep(
      3,
      'floater binary',
      'error',
      `no floater binary found. Tried env MAVIS_PET_FLOATER, ${dest}, dev workspace, bundled path. Fix: build floater from source ` +
      `(cd packages/floater && cargo build --release) or set MAVIS_PET_FLOATER=/path/to/binary.`,
    );
  }
  // If the source IS the destination already (user re-runs after manual install),
  // skip the copy but still report ok.
  if (path.resolve(src) === path.resolve(dest)) {
    try { fs.chmodSync(dest, 0o755); } catch { /* tolerate */ }
    return logStep(3, 'floater binary', 'ok', `already installed at ${dest}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  } catch (e: any) {
    return logStep(
      3,
      'floater binary',
      'error',
      `copy failed (${src} -> ${dest}): ${e.message}. Fix: check write permissions on ${path.dirname(dest)}.`,
    );
  }
  return logStep(3, 'floater binary', 'ok', `${src} -> ${dest}`);
}

/**
 * Step 4: install the 6 mavis hooks. Delegates to the existing
 * `mavis-pet hook install` command path (cmdHookInstall) by re-importing
 * cli.ts dynamically. We do this rather than copy-paste the hook install
 * loop to ensure a single source of truth for hook bodies.
 */
async function step4InstallHooks(opts: WizardOptions, moduleDir: string): Promise<StepResult> {
  // In sandbox tests we pass home != os.homedir() — cmdHookInstall reads
  // os.homedir() directly so it would write to the real ~/.mavis. Skip
  // hook install in that case but record it as 'skip' so the test can
  // verify wizard completed all 7 steps logically.
  const sandboxed = (opts.home ?? os.homedir()) !== os.homedir();
  if (sandboxed) {
    return logStep(4, 'mavis hooks', 'skip', 'sandboxed home — hook install requires real $HOME');
  }
  // Run `mavis-pet hook install` in a subshell so it picks up the test's
  // CLI bin path and we don't have to worry about ESM import side-effects
  // (cmdHookInstall reads global module-scope constants like STATE_DIR).
  const cliBin = resolveCliBinPath(opts.cliBinPath);
  let r: { status: number | null; stdout: string; stderr: string };
  try {
    r = spawnSync(process.execPath, [cliBin, 'hook', 'install'], { encoding: 'utf8' });
  } catch (e: any) {
    return logStep(4, 'mavis hooks', 'error', `spawn failed: ${e.message}. Fix: ensure ${cliBin} exists and is readable.`);
  }
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\n/).slice(-3).join(' | ');
    return logStep(
      4,
      'mavis hooks',
      'error',
      `'mavis-pet hook install' exited ${r.status}: ${tail || '(no output)'}. Fix: check that the 'mavis' CLI is on PATH (the hooks call out to it).`,
    );
  }
  // cmdHookInstall prints "installed hook ..." per success; just count them.
  const ok = (r.stdout.match(/installed hook /g) ?? []).length;
  if (ok === 0) {
    return logStep(4, 'mavis hooks', 'ok', 'hooks already installed (idempotent)');
  }
  return logStep(4, 'mavis hooks', 'ok', `${ok} hooks registered`);
}

/**
 * Step 5: install default pet. Strategy:
 *   1. If `boba` already in ~/.mavis/pets/, done.
 *   2. Else try `npx -y petdex install boba` (or opts.petdexInstaller in tests).
 *      On success, adapt via existing `mavis-pet install boba`.
 *   3. On failure, fall back to bundled `mikoko` (which always works because
 *      it ships in packages/cli/assets/pets/).
 */
async function step5InstallDefaultPet(opts: WizardOptions): Promise<StepResult> {
  if (opts.skipPetInstall) {
    return logStep(5, 'default pet', 'skip', 'skipped (skipPetInstall=true)');
  }
  const home = opts.home ?? os.homedir();
  const bobaDir = path.join(home, '.mavis/pets', DEFAULT_PET_SLUG);
  const sandboxed = home !== os.homedir();

  // Already installed → idempotent ok.
  if (fs.existsSync(path.join(bobaDir, 'pet.json'))) {
    return logStep(5, 'default pet', 'ok', `boba already at ${bobaDir}`);
  }

  if (sandboxed) {
    // Sandbox: synthesize a minimal pet.json so the rest of the test can
    // see the "pet installed" state without invoking petdex/mavis-pet CLI.
    fs.mkdirSync(bobaDir, { recursive: true });
    fs.writeFileSync(
      path.join(bobaDir, 'pet.json'),
      JSON.stringify({ slug: DEFAULT_PET_SLUG, name: 'Boba', synthesized: true }, null, 2),
    );
    return logStep(5, 'default pet', 'ok', `synthesized boba placeholder (sandboxed home)`);
  }

  // 1. Try petdex CLI to fetch boba.
  const petdexResult = opts.petdexInstaller
    ? opts.petdexInstaller(DEFAULT_PET_SLUG)
    : runPetdexInstall(DEFAULT_PET_SLUG);

  let chosenSlug = DEFAULT_PET_SLUG;
  if (!petdexResult.ok) {
    // Fall back to bundled mikoko.
    chosenSlug = FALLBACK_PET_SLUG;
    console.log(kleur.dim(`     petdex install failed (${petdexResult.reason ?? 'unknown'}); falling back to bundled '${chosenSlug}'`));
  }

  // 2. Use mavis-pet install <slug> to adapt or copy bundled.
  const cliBin = resolveCliBinPath(opts.cliBinPath);
  const r = spawnSync(process.execPath, [cliBin, 'install', chosenSlug], { encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\n/).slice(-3).join(' | ');
    return logStep(
      5,
      'default pet',
      'error',
      `'mavis-pet install ${chosenSlug}' exited ${r.status}: ${tail || '(no output)'}. ` +
      `Fix: try manually 'mavis-pet install mikoko' to debug.`,
    );
  }
  return logStep(5, 'default pet', 'ok', `installed ${chosenSlug}`);
}

function runPetdexInstall(slug: string): { ok: boolean; reason?: string } {
  // npx -y petdex install <slug> — short timeout so the wizard doesn't hang
  // for minutes if npm cache is cold and petdex tarball is huge.
  // On success petdex writes ~/.petdex/pets/<slug>/{pet.json,spritesheet.webp}
  // which mavis-pet's adapter then picks up.
  const r = spawnSync('npx', ['-y', 'petdex', 'install', slug], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: 'pipe',
  });
  if (r.error) return { ok: false, reason: `spawn error: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\n/).slice(-2).join(' | ');
    return { ok: false, reason: `exit ${r.status}: ${tail || 'no output'}` };
  }
  return { ok: true };
}

function step6WriteLaunchdPlist(opts: WizardOptions): StepResult & { plistPath?: string } {
  const home = opts.home ?? os.homedir();
  const cliBin = resolveCliBinPath(opts.cliBinPath);
  const plistDir = path.join(home, 'Library/LaunchAgents');
  const plistPath = path.join(plistDir, `${LAUNCHD_LABEL}.plist`);
  const logDir = path.join(home, '.mavis/pet/logs');

  // PATH for launchd — must include node + npm-global bin so spawn('npx',...)
  // inside cmdStart can find children. Add brew paths for completeness.
  const nodeBinDir = path.dirname(process.execPath);
  const pathEnv = [
    nodeBinDir,
    path.join(home, '.npm-global/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  const content = generateLaunchdPlist({
    label: LAUNCHD_LABEL,
    programArgs: [process.execPath, cliBin, 'start'],
    workingDirectory: home,
    stdoutPath: path.join(logDir, 'stdout.log'),
    stderrPath: path.join(logDir, 'stderr.log'),
    pathEnv,
    homeEnv: home,
  });

  fs.mkdirSync(plistDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const replaced = fs.existsSync(plistPath);
  fs.writeFileSync(plistPath, content);
  return { ...logStep(6, 'launchd plist', 'ok', `wrote ${plistPath}${replaced ? ' (overwrote existing)' : ''}`), plistPath };
}

async function step7LoadLaunchd(opts: WizardOptions, plistPath: string | undefined): Promise<StepResult> {
  if (opts.noLaunchd ?? process.platform !== 'darwin') {
    return logStep(7, 'launchctl load', 'skip', `noLaunchd=${opts.noLaunchd ?? false} or platform=${process.platform}`);
  }
  if (!plistPath) {
    return logStep(7, 'launchctl load', 'error', 'plist path missing (step 6 failed). Cannot proceed.');
  }
  const launchctl = opts.launchctl ?? defaultLaunchctlRunner;

  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const domain = `gui/${uid}`;

  // Idempotency: if already loaded, bootout first so bootstrap doesn't
  // fail with "service already loaded".
  const printRes = launchctl(['print', target]);
  if (printRes.status === 0) {
    console.log(kleur.dim(`     existing service detected, unloading first...`));
    const bootout = launchctl(['bootout', target]);
    if (bootout.status !== 0) {
      console.log(kleur.dim(`     bootout returned ${bootout.status} (continuing): ${bootout.stderr.trim().split(/\n/)[0]}`));
    }
  }

  const bootstrap = launchctl(['bootstrap', domain, plistPath]);
  if (bootstrap.status !== 0) {
    return logStep(
      7,
      'launchctl load',
      'error',
      `'launchctl bootstrap ${domain} <plist>' exited ${bootstrap.status}: ${(bootstrap.stderr || bootstrap.stdout).trim().split(/\n/).slice(-1)[0]}. ` +
      `Fix: run 'launchctl print ${target}' to inspect; check ${path.dirname(plistPath)} permissions.`,
    );
  }

  // Skip healthz wait when requested (tests).
  if (opts.skipHealthz) {
    return logStep(7, 'launchctl load', 'ok', `bootstrapped ${target} (healthz skipped)`);
  }

  // Poll broker /healthz for up to 8s. Broker startup includes node spawn
  // + listen — typically <2s on a warm machine.
  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < 8000) {
    if (await checkBrokerHealth(BROKER_DEFAULT_PORT, 800)) { healthy = true; break; }
    await sleep(400);
  }
  if (!healthy) {
    return logStep(
      7,
      'launchctl load',
      'warn',
      `bootstrapped ${target} but broker /healthz did not respond within 8s. ` +
      `Check 'launchctl print ${target}' for LastExitStatus, or tail ~/.mavis/pet/logs/stderr.log.`,
    );
  }
  return logStep(7, 'launchctl load', 'ok', `bootstrapped ${target}, broker healthy on :${BROKER_DEFAULT_PORT}`);
}

function defaultLaunchctlRunner(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---- main wizard -----------------------------------------------------------

/**
 * v0.7.1 — Sandbox auto-detect. When opts.home is set AND differs from
 * the real os.homedir(), the caller is running in a sandbox (verifier
 * adversarial probe / temp-HOME e2e test / dry-run). In that case force
 * noLaunchd=true so the wizard does NOT actually `launchctl bootstrap`
 * the agent — which would spawn a real broker + floater that connect
 * to the user's real desktop and leave orphan processes after the
 * sandbox HOME is rm -rf'd.
 *
 * Bug this fixes: 2026-05-14, verifier ran wizard twice in sandbox HOMEs
 * /var/folders/.../mavis-pet-verify-* during adversarial idempotency probe;
 * each run launchctl-bootstrapped a real LaunchAgent which spawned floater
 * binaries from the (about-to-be-deleted) sandbox path. The agents stayed
 * registered with launchd after sandbox cleanup → orphan floater windows
 * on user's real desktop.
 *
 * Override: set MAVIS_PET_FORCE_LAUNCHD=1 to skip this auto-detect (rare
 * case where someone really wants to test launchctl in a sandbox HOME
 * and is prepared to clean up themselves).
 */
function normalizeOptsForSandbox(opts: WizardOptions): WizardOptions {
  // Only apply when caller passed explicit home AND it differs from real home.
  if (!opts.home) return opts;
  const realHome = os.homedir();
  if (opts.home === realHome) return opts;
  if (process.env.MAVIS_PET_FORCE_LAUNCHD === '1') return opts;
  // Caller already explicitly set noLaunchd — don't override their choice.
  if (opts.noLaunchd !== undefined) return opts;
  console.log(
    kleur.dim(
      `[sandbox] opts.home=${opts.home} != real home=${realHome} → ` +
      `auto-set noLaunchd=true (set MAVIS_PET_FORCE_LAUNCHD=1 to override).`,
    ),
  );
  return { ...opts, noLaunchd: true };
}

/**
 * Run the full 7-step wizard. Returns the per-step results so callers
 * (mainly tests) can assert on them. The function never throws — it
 * coerces all step failures into StepResult{status: 'error'}.
 */
export async function runInstallWizard(opts: WizardOptions = {}): Promise<StepResult[]> {
  opts = normalizeOptsForSandbox(opts);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const results: StepResult[] = [];

  console.log('');
  console.log(kleur.bold('mavis-pet install — one-shot bootstrap'));
  console.log('');

  results.push(await step1Welcome(opts));
  results.push(await step2DetectHjbhxeg(opts));
  results.push(step3InstallFloater(opts, moduleDir));
  results.push(await step4InstallHooks(opts, moduleDir));
  results.push(await step5InstallDefaultPet(opts));
  const r6 = step6WriteLaunchdPlist(opts);
  results.push(r6);
  results.push(await step7LoadLaunchd(opts, (r6 as any).plistPath));

  // Summary line.
  const okCount = results.filter((r) => r.status === 'ok').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;
  const errCount = results.filter((r) => r.status === 'error').length;
  const skipCount = results.filter((r) => r.status === 'skip').length;
  console.log('');
  if (errCount === 0) {
    console.log(kleur.green(`✓ wizard complete: ${okCount} ok, ${warnCount} warn, ${skipCount} skip`));
    if (warnCount === 0 && skipCount === 0) {
      console.log(kleur.dim(`  pet should appear shortly. Check 'mavis-pet status' to verify.`));
    }
  } else {
    console.log(kleur.red(`✗ wizard finished with ${errCount} error(s) — see messages above`));
  }
  return results;
}

// ---- uninstall (reverse of wizard) ----------------------------------------

/**
 * Reverse the wizard:
 *   1. launchctl bootout + delete plist
 *   2. delete ~/.mavis/pet/floater (+ pid files)
 *   3. mavis-pet hook uninstall
 *   (deliberately preserves ~/.mavis/pets/ — user pet data is not
 *   considered installer-managed)
 */
export async function runUninstall(opts: WizardOptions = {}): Promise<StepResult[]> {
  opts = normalizeOptsForSandbox(opts);
  const home = opts.home ?? os.homedir();
  const results: StepResult[] = [];

  console.log('');
  console.log(kleur.bold('mavis-pet uninstall — removing autostart, floater binary, hooks'));
  console.log(kleur.dim('(your installed pets in ~/.mavis/pets/ will be preserved)'));
  console.log('');

  // 1. Stop + remove launchd job.
  const plistPath = path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const skipLaunchd = opts.noLaunchd ?? process.platform !== 'darwin';
  if (skipLaunchd) {
    results.push(logStep(1, 'launchctl unload', 'skip', `noLaunchd=${opts.noLaunchd ?? false} or platform=${process.platform}`));
  } else {
    const launchctl = opts.launchctl ?? defaultLaunchctlRunner;
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${LAUNCHD_LABEL}`;
    const bootout = launchctl(['bootout', target]);
    if (bootout.status === 0) {
      results.push(logStep(1, 'launchctl unload', 'ok', `bootout ${target}`));
    } else {
      // 'service not loaded' is fine — just means it wasn't running.
      const tail = (bootout.stderr || bootout.stdout).trim().split(/\n/).slice(-1)[0];
      results.push(logStep(1, 'launchctl unload', 'warn', `bootout returned ${bootout.status}: ${tail || '(no output)'} — ok if not loaded`));
    }
  }

  // 2. Delete plist.
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    results.push(logStep(2, 'plist file', 'ok', `removed ${plistPath}`));
  } else {
    results.push(logStep(2, 'plist file', 'skip', `not present: ${plistPath}`));
  }

  // 3. Delete floater binary + state pid files.
  const floaterPath = path.join(home, '.mavis/pet/floater');
  const removed: string[] = [];
  for (const p of [
    floaterPath,
    path.join(home, '.mavis/pet/floater.pid'),
    path.join(home, '.mavis/pet/broker.pid'),
  ]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); removed.push(path.relative(home, p)); } catch { /* ignore */ }
    }
  }
  if (removed.length > 0) {
    results.push(logStep(3, 'floater + pid files', 'ok', `removed: ${removed.join(', ')}`));
  } else {
    results.push(logStep(3, 'floater + pid files', 'skip', 'nothing to remove'));
  }

  // 4. Hook uninstall (delegates to existing cmdHookUninstall via subshell).
  const sandboxed = home !== os.homedir();
  if (sandboxed) {
    results.push(logStep(4, 'mavis hooks', 'skip', 'sandboxed home — hook uninstall requires real $HOME'));
  } else {
    const cliBin = resolveCliBinPath(opts.cliBinPath);
    const r = spawnSync(process.execPath, [cliBin, 'hook', 'uninstall'], { encoding: 'utf8' });
    if (r.status === 0) {
      const removed = (r.stdout.match(/removed /g) ?? []).length;
      results.push(logStep(4, 'mavis hooks', 'ok', removed > 0 ? `removed ${removed} hooks` : 'no hooks were registered'));
    } else {
      const tail = (r.stderr || r.stdout || '').trim().split(/\n/).slice(-2).join(' | ');
      results.push(logStep(4, 'mavis hooks', 'warn', `'mavis-pet hook uninstall' exited ${r.status}: ${tail}`));
    }
  }

  console.log('');
  console.log(kleur.green(`✓ uninstall complete (preserved ~/.mavis/pets/ — delete manually if you want a full wipe)`));
  return results;
}
