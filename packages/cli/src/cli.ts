/**
 * mavis-pet CLI — install/list/switch/start/stop/status/hook.
 *
 * Command surface mirrors the petdex CLI but targets mavis daemon hooks.
 *
 * Files we touch:
 *   ~/.mavis/pets/<slug>/{pet.json, spritesheet.{webp,png}}   pet packages
 *   ~/.mavis/pet/config.json                                  active pet
 *   ~/.mavis/pet/broker.pid                                   running broker pid
 *   ~/.mavis/pet/floater.pid                                  running floater pid
 *   ~/.mavis/pet/installed-hooks.json                         hook id ledger
 *
 * Broker / floater discovery:
 *   broker  — sibling npm package @mavis-pet/broker (resolved from package
 *             root, falls back to ../broker/bin/mavis-pet-broker.mjs).
 *   floater — env MAVIS_PET_FLOATER else first match in:
 *             ~/.mavis/pet/floater  (preferred user install)
 *             ../floater/target/release/mavis-pet-floater  (dev workspace)
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';
import {
  adaptPetdexPet,
  findPetdexPet,
  listPetdexPets,
} from './petdex-adapter.js';

const HOME = os.homedir();
const PET_DIR = path.join(HOME, '.mavis/pets');
const STATE_DIR = path.join(HOME, '.mavis/pet');
const CODEX_PET_DIR = path.join(HOME, '.codex/pets');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const BROKER_PID = path.join(STATE_DIR, 'broker.pid');
const FLOATER_PID = path.join(STATE_DIR, 'floater.pid');
const HOOKS_LEDGER = path.join(STATE_DIR, 'installed-hooks.json');
const BROKER_PORT = Number(process.env.MAVIS_PET_BROKER_PORT ?? 7857);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const PETDEX_MANIFEST = process.env.MAVIS_PET_MANIFEST ?? 'https://petdex.crafter.run/api/manifest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- helpers ---------------------------------------------------------------

function ensureDir(d: string) { fs.mkdirSync(d, { recursive: true }); }

function readJson<T = unknown>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}

function writeJson(p: string, data: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function loadConfig(): { active: string | null } {
  return readJson<{ active: string | null }>(CONFIG_PATH) ?? { active: null };
}
function saveConfig(c: { active: string | null }) { writeJson(CONFIG_PATH, c); }

function listInstalledPets(): { slug: string; dir: string; source: 'mavis' | 'codex' | 'petdex' }[] {
  const out: { slug: string; dir: string; source: 'mavis' | 'codex' | 'petdex' }[] = [];
  for (const [base, source] of [[PET_DIR, 'mavis'], [CODEX_PET_DIR, 'codex']] as const) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const hasPet = fs.existsSync(path.join(dir, 'pet.json'));
      const hasSprite = fs.existsSync(path.join(dir, 'spritesheet.webp'))
        || fs.existsSync(path.join(dir, 'spritesheet.png'));
      if (hasPet && hasSprite) {
        if (!out.some((p) => p.slug === entry.name)) {
          // Detect mavis-pet entries that originated from petdex (the
          // adapter writes `source: "petdex"` into the translated pet.json).
          // We surface them to the user under their original origin so the
          // status/list output makes the source obvious without a separate
          // `~/.petdex/pets/` scan.
          let resolvedSource: 'mavis' | 'codex' | 'petdex' = source;
          if (source === 'mavis') {
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8')) as { source?: string };
              if (meta.source === 'petdex') resolvedSource = 'petdex';
            } catch { /* ignore — still list under the directory's source */ }
          }
          out.push({ slug: entry.name, dir, source: resolvedSource });
        }
      }
    }
  }
  // Surface petdex pets that have NOT yet been adapted into ~/.mavis/pets/
  // so the user can see what's available locally without leaving the CLI.
  // These are read-only previews — switching to one will trigger the
  // adapter (cmdSwitch handles the auto-install).
  for (const p of listPetdexPets()) {
    if (out.some((existing) => existing.slug === p.slug)) continue;
    out.push({ slug: p.slug, dir: p.dir, source: 'petdex' });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function downloadTo(url: string, dest: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
}

async function brokerStatus(): Promise<{ running: boolean; state?: string } > {
  return new Promise((resolve) => {
    const req = http.get(`${BROKER_URL}/status`, { timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ running: true, ...JSON.parse(body) }); }
        catch { resolve({ running: true }); }
      });
    });
    req.on('error', () => resolve({ running: false }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false }); });
  });
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
      timeout: 1500,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0 }));
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.write(data); req.end();
  });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile(p: string): number | null {
  if (!fs.existsSync(p)) return null;
  const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function resolveBrokerEntry(): string {
  // Sibling workspace
  const sibling = path.resolve(__dirname, '../../broker/bin/mavis-pet-broker.mjs');
  if (fs.existsSync(sibling)) return sibling;
  // Try resolving as installed package
  try {
    return fileURLToPath(import.meta.resolve('@mavis-pet/broker/bin/mavis-pet-broker.mjs'));
  } catch { /* ignore */ }
  throw new Error('cannot locate broker entry — set MAVIS_PET_BROKER to its path');
}

function resolveFloater(): string {
  if (process.env.MAVIS_PET_FLOATER) return process.env.MAVIS_PET_FLOATER;
  const userInstall = path.join(STATE_DIR, 'floater');
  if (fs.existsSync(userInstall)) return userInstall;
  // Dev workspace path
  const dev = path.resolve(__dirname, '../../floater/target/release/mavis-pet-floater');
  if (fs.existsSync(dev)) return dev;
  throw new Error('cannot locate floater binary — set MAVIS_PET_FLOATER to its path');
}

/**
 * Locate a pet bundled inside this npm package (packages/cli/assets/pets/<slug>/).
 * Returns null if not bundled. Used as a zero-network fallback by cmdInstall so
 * `mavis-pet install mikoko` works even when the petdex manifest is unreachable
 * or hasn't yet listed a pet (v0.4.2: mikoko is the default and ships in-tree).
 *
 * Path resolution:
 *   - dev workspace: dist/cli.js → ../assets/pets/<slug>          (packages/cli/assets)
 *   - npm install:   node_modules/mavis-pet/dist/cli.js → same    (assets is in `files`)
 */
function resolveBundledPet(slug: string): string | null {
  const dir = path.resolve(__dirname, '..', 'assets', 'pets', slug);
  const pet = path.join(dir, 'pet.json');
  const webp = path.join(dir, 'spritesheet.webp');
  const png = path.join(dir, 'spritesheet.png');
  if (fs.existsSync(pet) && (fs.existsSync(webp) || fs.existsSync(png))) {
    return dir;
  }
  return null;
}

function copyBundledPet(srcDir: string, slug: string) {
  const dest = path.join(PET_DIR, slug);
  ensureDir(dest);
  for (const name of ['pet.json', 'spritesheet.webp', 'spritesheet.png']) {
    const src = path.join(srcDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, name));
    }
  }
}

// ---- commands --------------------------------------------------------------

async function cmdInstall(slug: string) {
  if (!slug) throw new Error('usage: mavis-pet install <slug>');

  // v0.4.2: try bundled assets first (packages/cli/assets/pets/<slug>/).
  // mikoko ships in-tree so `mavis-pet install mikoko` always works, even
  // offline or when the petdex manifest hasn't been updated. Other pets
  // can be bundled the same way by dropping a directory into
  // packages/cli/assets/pets/.
  const bundled = resolveBundledPet(slug);
  if (bundled) {
    console.log(kleur.dim(`installing bundled '${slug}' from ${path.relative(HOME, bundled)}`));
    copyBundledPet(bundled, slug);
    const cfg = loadConfig();
    if (!cfg.active) {
      cfg.active = slug;
      saveConfig(cfg);
      console.log(kleur.green(`activated ${slug}`));
    }
    console.log(kleur.green(`installed ${slug}`));
    return;
  }

  // v0.6.2: petdex pet adapter — if the user has the petdex CLI installed
  // and has run `npx petdex install <slug>`, the pet sits in
  // ~/.petdex/pets/<slug>/ in petdex's own layout. We adapt it (copy
  // spritesheet + write a translated pet.json with the petdex grid's
  // state_rows mapping) instead of going to the petdex HTTP manifest.
  // This is the zero-network path for any pet the user already has via
  // the petdex CLI, and it keeps mavis-pet's installed pet directory
  // self-contained — the floater never reaches into ~/.petdex/.
  if (findPetdexPet(slug)) {
    console.log(kleur.dim(`adapting petdex pet '${slug}' from ~/.petdex/pets/${slug}`));
    const dest = adaptPetdexPet(slug);
    console.log(kleur.dim(`wrote ${path.relative(HOME, dest)}/{pet.json,spritesheet.webp}`));
    const cfg = loadConfig();
    if (!cfg.active) {
      cfg.active = slug;
      saveConfig(cfg);
      console.log(kleur.green(`activated ${slug}`));
    }
    console.log(kleur.green(`installed ${slug} (petdex)`));
    return;
  }

  console.log(kleur.dim(`fetching petdex manifest...`));
  const manifest = await fetchJson(PETDEX_MANIFEST);
  const list: any[] = manifest?.pets ?? manifest;
  const pet = list.find((p: any) => p?.slug === slug);
  if (!pet) throw new Error(`pet '${slug}' not found in petdex manifest`);

  // Petdex manifest typically exposes spritesheet and pet.json URLs.
  // Tolerate two common shapes: {sprite,meta} or {spritesheet,pet}.
  const spriteUrl: string | undefined = pet.spritesheet ?? pet.sprite ?? pet.spritesheet_url;
  const petJsonUrl: string | undefined = pet.pet_json ?? pet.meta ?? pet.pet;
  if (!spriteUrl) throw new Error(`manifest entry for '${slug}' has no spritesheet URL`);

  const dest = path.join(PET_DIR, slug);
  ensureDir(dest);
  const spriteExt = spriteUrl.endsWith('.png') ? 'png' : 'webp';
  console.log(kleur.dim(`downloading spritesheet -> ${dest}/spritesheet.${spriteExt}`));
  await downloadTo(spriteUrl, path.join(dest, `spritesheet.${spriteExt}`));

  if (petJsonUrl) {
    console.log(kleur.dim(`downloading pet.json`));
    await downloadTo(petJsonUrl, path.join(dest, 'pet.json'));
  } else {
    // Synthesize a minimal pet.json from the manifest entry.
    writeJson(path.join(dest, 'pet.json'), {
      slug, name: pet.name ?? slug,
      frame_w: pet.frame_w ?? 192, frame_h: pet.frame_h ?? 208,
      rows: pet.rows ?? 8, cols: pet.cols ?? 9,
      frame_duration_ms: pet.frame_duration_ms ?? 1100,
    });
  }

  // Auto-activate if no active pet yet.
  const cfg = loadConfig();
  if (!cfg.active) {
    cfg.active = slug;
    saveConfig(cfg);
    console.log(kleur.green(`activated ${slug}`));
  }
  console.log(kleur.green(`installed ${slug}`));
}

async function cmdList() {
  const cfg = loadConfig();
  const pets = listInstalledPets();
  if (pets.length === 0) {
    console.log(kleur.dim('no pets installed. try: mavis-pet install mikoko'));
    return;
  }
  for (const p of pets) {
    const tag = p.slug === cfg.active ? kleur.green('★ active') : '          ';
    let src: string;
    if (p.source === 'petdex' && p.dir.startsWith(path.join(HOME, '.petdex'))) {
      // Available via the petdex CLI but not yet adapted into ~/.mavis/pets.
      // Tell the user it's a one-step away.
      src = `${kleur.dim('~/.petdex/pets')} ${kleur.yellow('(switch to import)')}`;
    } else if (p.source === 'petdex') {
      src = `~/.mavis/pets ${kleur.cyan('(petdex)')}`;
    } else if (p.source === 'codex') {
      src = '~/.codex/pets';
    } else {
      src = '~/.mavis/pets';
    }
    console.log(`${tag}  ${p.slug.padEnd(20)}  ${kleur.dim(src)}`);
  }
}

async function cmdSwitch(slug: string) {
  if (!slug) throw new Error('usage: mavis-pet switch <slug>');
  let pets = listInstalledPets();
  let entry = pets.find((p) => p.slug === slug);
  // v0.6.2 — if the slug isn't in ~/.mavis/pets/ or ~/.codex/pets/ but the
  // user has it in ~/.petdex/pets/, auto-adapt it now so `switch` is a
  // single command. Without this users would have to run
  // `mavis-pet install <slug>` after every `petdex install <slug>`.
  if (!entry || entry.source === 'petdex') {
    if (findPetdexPet(slug)) {
      console.log(kleur.dim(`'${slug}' not yet adapted — importing from petdex…`));
      const dest = adaptPetdexPet(slug);
      console.log(kleur.dim(`wrote ${path.relative(HOME, dest)}/{pet.json,spritesheet.webp}`));
      pets = listInstalledPets();
      entry = pets.find((p) => p.slug === slug);
    }
  }
  if (!entry) {
    throw new Error(`pet '${slug}' is not installed (mavis-pet install ${slug})`);
  }
  const cfg = loadConfig();
  cfg.active = slug;
  saveConfig(cfg);
  console.log(kleur.green(`active pet -> ${slug}`));
  // Notify broker (best-effort) so floater can hot-reload.
  const r = await postJson(`${BROKER_URL}/switch`, { slug });
  if (r.ok) console.log(kleur.dim('broker notified'));
}

async function cmdStart() {
  ensureDir(STATE_DIR);

  // 1. Broker
  let brokerStarted = false;
  const status = await brokerStatus();
  if (!status.running) {
    const entry = resolveBrokerEntry();
    const child = spawn(process.execPath, [entry], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, PORT: String(BROKER_PORT) },
    });
    child.unref();
    fs.writeFileSync(BROKER_PID, String(child.pid));
    brokerStarted = true;
    console.log(kleur.green(`broker started (pid ${child.pid}, :${BROKER_PORT})`));
  } else {
    console.log(kleur.dim('broker already running'));
  }

  // 2. Floater
  const existingFloater = readPidFile(FLOATER_PID);
  if (existingFloater && pidAlive(existingFloater)) {
    console.log(kleur.dim(`floater already running (pid ${existingFloater})`));
  } else {
    const bin = resolveFloater();
    const child = spawn(bin, [], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(FLOATER_PID, String(child.pid));
    console.log(kleur.green(`floater started (pid ${child.pid})`));
  }

  if (brokerStarted) {
    console.log(kleur.dim('tip: install hooks once with: mavis-pet hook install'));
  }
}

async function cmdStop() {
  for (const [name, pidFile] of [['floater', FLOATER_PID], ['broker', BROKER_PID]] as const) {
    const pid = readPidFile(pidFile);
    if (pid && pidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); console.log(kleur.green(`${name} stopped (pid ${pid})`)); }
      catch (e) { console.log(kleur.red(`${name} kill failed: ${e}`)); }
    } else {
      console.log(kleur.dim(`${name} not running`));
    }
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  }
}

async function cmdStatus() {
  const cfg = loadConfig();
  const status = await brokerStatus();
  console.log(`active pet : ${cfg.active ? kleur.green(cfg.active) : kleur.dim('(none)')}`);
  console.log(`broker     : ${status.running ? kleur.green('running') : kleur.dim('not running')} ` +
              `${status.running ? kleur.dim(`(state: ${(status as any).state ?? '?'})`) : ''}`);
  const fpid = readPidFile(FLOATER_PID);
  console.log(`floater    : ${fpid && pidAlive(fpid) ? kleur.green(`running (pid ${fpid})`) : kleur.dim('not running')}`);
  const hooks = readJson<{ ids: string[] }>(HOOKS_LEDGER);
  console.log(`hooks      : ${hooks?.ids?.length ? kleur.green(`${hooks.ids.length} installed`) : kleur.dim('none installed')}`);
}

// ---- hook install/uninstall ----------------------------------------------

interface HookSpec {
  event: string;
  matcher?: string;
  bodyKind:
    | 'pretool'
    | 'posttool'
    | 'msgcomplete'
    | 'userprompt'
    | 'sessionstart'
    | 'sessionend';
}

const HOOK_SPECS: HookSpec[] = [
  { event: 'PreToolUse', bodyKind: 'pretool' },
  { event: 'PostToolUse', bodyKind: 'posttool' },
  { event: 'MessageComplete', bodyKind: 'msgcomplete' },
  { event: 'UserPromptSubmit', bodyKind: 'userprompt' },
  { event: 'SessionStart', bodyKind: 'sessionstart' },
  { event: 'SessionEnd', bodyKind: 'sessionend' },
];

function hookBody(spec: HookSpec): string {
  // mavis daemon protocol (verified against daemon source by mavis-debug agent
  // 2026-05-11): hook scripts receive payload via STDIN as JSON, NOT via env
  // vars. Schema is {input:{sessionId, agentName, toolName, toolCallId,
  // toolArgs, toolResult}, output:{}}.
  // - PreToolUse / PostToolUse: input.sessionId + input.toolName always set.
  // - PostToolUse: hookInput does NOT carry exitCode; we sniff toolResult
  //   for "error"/"failed" tokens to drive the failed flash.
  // - MessageComplete / UserPromptSubmit / SessionStart / SessionEnd:
  //   input.sessionId set; toolName empty.
  const post = (jsonPayload: string) =>
    `curl -sS -m 1 -X POST -H "content-type: application/json" ` +
    `-d "${jsonPayload}" ${BROKER_URL}/event >/dev/null 2>&1 || true`;

  const sessionOnly = (kind: string, comment: string) =>
    [
      '```bash',
      `# mavis-pet ${comment}`,
      'IN=$(cat)',
      'SID=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.sessionId // empty")',
      post(`{\\"sessionId\\":\\"$SID\\",\\"kind\\":\\"${kind}\\"}`),
      '```',
    ].join('\n');

  if (spec.bodyKind === 'pretool') {
    return [
      '```bash',
      '# mavis-pet PreToolUse — payload via stdin (mavis daemon protocol)',
      'IN=$(cat)',
      'SID=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.sessionId // empty")',
      'TOOL=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.toolName // empty")',
      post('{\\"sessionId\\":\\"$SID\\",\\"kind\\":\\"PreToolUse\\",\\"tool\\":\\"$TOOL\\"}'),
      '```',
    ].join('\n');
  }
  if (spec.bodyKind === 'posttool') {
    return [
      '```bash',
      '# mavis-pet PostToolUse — sniff toolResult for failure (no exitCode in hookInput)',
      'IN=$(cat)',
      'SID=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.sessionId // empty")',
      'TOOL=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.toolName // empty")',
      'RES=$(printf "%s" "$IN" | /usr/bin/jq -r ".input.toolResult // empty" | tr "[:upper:]" "[:lower:]")',
      'EXIT=0',
      'case "$RES" in *error*|*failed*|*exception*|*"non-zero"*) EXIT=1 ;; esac',
      post('{\\"sessionId\\":\\"$SID\\",\\"kind\\":\\"PostToolUse\\",\\"tool\\":\\"$TOOL\\",\\"exitCode\\":$EXIT}'),
      '```',
    ].join('\n');
  }
  if (spec.bodyKind === 'msgcomplete') {
    return sessionOnly('MessageComplete', 'MessageComplete — short wave at end of agent reply');
  }
  if (spec.bodyKind === 'userprompt') {
    return sessionOnly('UserPromptSubmit', 'UserPromptSubmit — happy hop when the user sends a new message');
  }
  if (spec.bodyKind === 'sessionstart') {
    return sessionOnly('SessionStart', 'SessionStart — boot greeting overlay');
  }
  // sessionend
  return sessionOnly('SessionEnd', 'SessionEnd — farewell overlay (session is then forgotten)');
}

async function cmdHookInstall() {
  ensureDir(STATE_DIR);
  const ledger = readJson<{ ids: string[] }>(HOOKS_LEDGER) ?? { ids: [] };
  // Idempotent: skip if already installed.
  if (ledger.ids.length === HOOK_SPECS.length) {
    console.log(kleur.dim(`hooks already installed (${ledger.ids.length}). uninstall first if you want to reinstall.`));
    return;
  }
  const newIds: string[] = [];
  for (const spec of HOOK_SPECS) {
    const tmp = path.join(os.tmpdir(), `mavis-pet-hook-${spec.event}-${Date.now()}.md`);
    fs.writeFileSync(tmp, hookBody(spec));
    const fileName = `mavis-pet-${spec.event.toLowerCase()}.md`;
    const args = ['hook', 'create', fileName, '-e', spec.event, '-t', 'script', '-f', tmp, '-p', '50'];
    const r = spawnSync('mavis', args, { stdio: 'pipe', encoding: 'utf8' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) {
      console.log(kleur.red(`failed to install ${spec.event}: ${r.stderr || r.stdout}`));
      continue;
    }
    // Try to parse hook id from stdout (e.g. "Hook created: <id>")
    const m = r.stdout.match(/(?:hook\s*(?:id|created)[^A-Za-z0-9_-]*)([A-Za-z0-9_:.-]+)/i)
              ?? r.stdout.match(/[`"']([A-Za-z0-9_:.-]{6,})[`"']/);
    const id = m?.[1] ?? fileName;
    newIds.push(id);
    console.log(kleur.green(`installed hook ${spec.event} -> ${id}`));
  }
  writeJson(HOOKS_LEDGER, { ids: [...ledger.ids, ...newIds] });
}

async function cmdHookUninstall() {
  const ledger = readJson<{ ids: string[] }>(HOOKS_LEDGER) ?? { ids: [] };
  if (ledger.ids.length === 0) {
    console.log(kleur.dim('no hooks recorded in ledger; nothing to uninstall'));
    return;
  }
  const remaining: string[] = [];
  for (const id of ledger.ids) {
    const r = spawnSync('mavis', ['hook', 'delete', id], { stdio: 'pipe', encoding: 'utf8' });
    if (r.status === 0) {
      console.log(kleur.green(`removed ${id}`));
    } else {
      console.log(kleur.yellow(`could not remove ${id}: ${(r.stderr || r.stdout).trim()}`));
      remaining.push(id);
    }
  }
  writeJson(HOOKS_LEDGER, { ids: remaining });
}

// ---- main ----------------------------------------------------------------

function usage() {
  console.log(`mavis-pet — desktop companion that reacts to your mavis sessions

  mavis-pet install <slug>      install a pet from the petdex gallery
  mavis-pet list                list installed pets, mark active
  mavis-pet switch <slug>       set active pet (broker hot-reload if running)
  mavis-pet start               start broker + floater
  mavis-pet stop                stop floater + broker
  mavis-pet status              show pet/broker/floater/hook status
  mavis-pet hook install        register the 6 mavis hooks (Pre/PostToolUse,
                                MessageComplete, UserPromptSubmit,
                                SessionStart, SessionEnd)
  mavis-pet hook uninstall      remove those hooks

Env:
  MAVIS_PET_BROKER_PORT (default 7857)
  MAVIS_PET_FLOATER     (override floater binary path)
  MAVIS_PET_MANIFEST    (override petdex manifest URL)
`);
}

async function main() {
  const [cmd, sub, arg] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'install': await cmdInstall(sub); break;
      case 'list':    await cmdList(); break;
      case 'switch':  await cmdSwitch(sub); break;
      case 'start':   await cmdStart(); break;
      case 'stop':    await cmdStop(); break;
      case 'status':  await cmdStatus(); break;
      case 'hook':
        if (sub === 'install')   await cmdHookInstall();
        else if (sub === 'uninstall') await cmdHookUninstall();
        else { usage(); process.exit(2); }
        break;
      case undefined:
      case '-h': case '--help': case 'help':
        usage(); break;
      default:
        console.log(kleur.red(`unknown command: ${cmd}`));
        usage(); process.exit(2);
    }
  } catch (e: any) {
    console.error(kleur.red(`error: ${e.message ?? e}`));
    process.exit(1);
  }
}

main();
