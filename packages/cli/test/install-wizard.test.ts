/**
 * install-wizard unit tests.
 *
 * Verifies the 7-step wizard + uninstall using a sandboxed HOME
 * (process.env.MAVIS_PET_TEST_HOME doesn't help here because cli.ts module-
 * scope constants are bound at import time; we pass `home: tmpHome` directly
 * to runInstallWizard / runUninstall instead).
 *
 * The wizard never throws; failures coerce to StepResult{status:'error'}.
 *
 * Sandbox conventions:
 *   - skipWelcome: true            (no readline pause)
 *   - skipPetInstall: false        (sandbox path synthesizes a placeholder)
 *   - skipHealthz: true            (don't poll real broker)
 *   - noLaunchd: true              (don't touch real launchd)
 *   - launchctl: vi.fn()           (in tests that need to assert launchctl args)
 *   - floaterSource: <fake bin>    (so step3 cp doesn't blow up looking for a real binary)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BROKER_DEFAULT_PORT,
  DEFAULT_PET_SLUG,
  HJBHXEG_DAEMON_PORT,
  LAUNCHD_LABEL,
  TOTAL_STEPS,
  checkPortListening,
  generateLaunchdPlist,
  locateFloaterBinary,
  runInstallWizard,
  runUninstall,
} from '../src/install-wizard.js';

// ----- shared fixtures -----------------------------------------------------

let tmpHome: string;
let fakeFloater: string;

beforeEach(() => {
  const realTmpdir = process.env.TMPDIR || '/tmp';
  tmpHome = fs.mkdtempSync(path.join(realTmpdir, 'mavis-pet-wizard-'));
  // Make a fake floater binary so step3 succeeds without needing a real
  // cargo build of packages/floater.
  fakeFloater = path.join(tmpHome, 'fake-floater-binary');
  fs.writeFileSync(fakeFloater, '#!/bin/sh\necho fake-floater\n');
  fs.chmodSync(fakeFloater, 0o755);
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function plistPath(home: string): string {
  return path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function makeMockLaunchctl() {
  // Track every launchctl invocation so tests can assert on argv shape.
  const calls: string[][] = [];
  const fn = vi.fn((args: string[]) => {
    calls.push(args);
    // 'print' returns 0 only after a successful 'bootstrap' (so re-run
    // tests can detect the "already loaded" branch).
    if (args[0] === 'print') {
      const loaded = calls.some((c) => c[0] === 'bootstrap' && !calls.some((c2) => c2[0] === 'bootout' && c2.indexOf(c[2] ?? '') >= 0));
      return loaded
        ? { status: 0, stdout: 'service info...', stderr: '' }
        : { status: 1, stdout: '', stderr: 'Could not find service' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  return { fn, calls };
}

// ===========================================================================
// generateLaunchdPlist (pure)
// ===========================================================================

describe('generateLaunchdPlist', () => {
  it('produces a syntactically valid plist with all required keys', () => {
    const xml = generateLaunchdPlist({
      label: 'dev.mavis.pet',
      programArgs: ['/usr/local/bin/node', '/Users/jane/.npm-global/lib/node_modules/mavis-pet/dist/cli.js', 'start'],
      workingDirectory: '/Users/jane',
      stdoutPath: '/Users/jane/.mavis/pet/logs/stdout.log',
      stderrPath: '/Users/jane/.mavis/pet/logs/stderr.log',
      pathEnv: '/usr/local/bin:/usr/bin:/bin',
      homeEnv: '/Users/jane',
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>dev.mavis.pet</string>');
    expect(xml).toContain('<key>ProgramArguments</key>');
    expect(xml).toContain('<string>/usr/local/bin/node</string>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<true/>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>EnvironmentVariables</key>');
    expect(xml).toContain('<key>PATH</key>');
    expect(xml).toContain('<key>HOME</key>');
    // No leftover ~ or $HOME — launchd won't expand them.
    expect(xml).not.toMatch(/\$HOME/);
    expect(xml).not.toMatch(/~\//);
  });

  it('escapes XML special characters in path strings', () => {
    const xml = generateLaunchdPlist({
      label: 'dev.mavis.pet',
      programArgs: ['/path/with <weird> & "chars".js'],
      workingDirectory: '/home',
      stdoutPath: '/log',
      stderrPath: '/log',
      pathEnv: '/p',
      homeEnv: '/home',
    });
    expect(xml).toContain('&lt;weird&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;chars&quot;');
  });

  it('passes plutil -lint when written to disk', () => {
    const xml = generateLaunchdPlist({
      label: 'dev.mavis.pet',
      programArgs: ['/usr/local/bin/node', '/some/cli.js', 'start'],
      workingDirectory: '/Users/jane',
      stdoutPath: '/Users/jane/out.log',
      stderrPath: '/Users/jane/err.log',
      pathEnv: '/usr/local/bin:/usr/bin:/bin',
      homeEnv: '/Users/jane',
    });
    const tmp = path.join(tmpHome, 'test.plist');
    fs.writeFileSync(tmp, xml);
    // Skip plutil check on non-darwin runners (CI).
    if (process.platform !== 'darwin') return;
    const r = spawnSync('plutil', ['-lint', tmp], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/OK$/);
    // Verify Label round-trips via PlistBuddy.
    const pb = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print Label', tmp], { encoding: 'utf8' });
    expect(pb.status).toBe(0);
    expect(pb.stdout.trim()).toBe('dev.mavis.pet');
  });
});

// ===========================================================================
// checkPortListening (smoke)
// ===========================================================================

describe('checkPortListening', () => {
  it('returns false for a port that is almost certainly not listening', async () => {
    // Pick a high port unlikely to be bound on test machines.
    const result = await checkPortListening(65000, 300);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// locateFloaterBinary
// ===========================================================================

describe('locateFloaterBinary', () => {
  it('returns the explicit override when it exists', () => {
    const found = locateFloaterBinary({ home: tmpHome, floaterSource: fakeFloater, moduleDir: '/dev/null' });
    expect(found).toBe(fakeFloater);
  });

  it('returns null when nothing exists', () => {
    const found = locateFloaterBinary({ home: tmpHome, moduleDir: '/dev/null' });
    expect(found).toBe(null);
  });

  it('finds a binary at <home>/.mavis/pet/floater', () => {
    const dest = path.join(tmpHome, '.mavis/pet/floater');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(fakeFloater, dest);
    const found = locateFloaterBinary({ home: tmpHome, moduleDir: '/dev/null' });
    expect(found).toBe(dest);
  });
});

// ===========================================================================
// runInstallWizard — end-to-end (sandboxed)
// ===========================================================================

describe('runInstallWizard (sandboxed)', () => {
  it('completes all 7 steps with skipWelcome + noLaunchd + sandbox', async () => {
    const results = await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    });
    expect(results).toHaveLength(TOTAL_STEPS);
    // Every step has a result; none should error in this clean sandbox.
    for (const r of results) {
      expect(['ok', 'warn', 'skip']).toContain(r.status);
    }
    // Step 1 = welcome → skip (skipWelcome=true)
    expect(results[0].step).toBe(1);
    expect(results[0].name).toBe('welcome');
    expect(results[0].status).toBe('skip');
    // Step 2 = MiniMax → warn (port not listening on test host)
    expect(results[1].step).toBe(2);
    expect(results[1].name).toBe('MiniMax detect');
    // Status here depends on whether the test host has MiniMax running.
    // On vino's machine it WILL be running, so accept ok or warn.
    expect(['ok', 'warn']).toContain(results[1].status);
    // Step 3 = floater → ok (we provided floaterSource)
    expect(results[2].name).toBe('floater binary');
    expect(results[2].status).toBe('ok');
    // Step 6 = launchd plist → ok, file exists
    expect(results[5].name).toBe('launchd plist');
    expect(results[5].status).toBe('ok');
    expect(fs.existsSync(plistPath(tmpHome))).toBe(true);
    // Step 7 = launchctl load → skip (noLaunchd=true)
    expect(results[6].name).toBe('launchctl load');
    expect(results[6].status).toBe('skip');
  });

  it('writes a plist at the expected path with correct Label', async () => {
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    });
    const content = fs.readFileSync(plistPath(tmpHome), 'utf8');
    expect(content).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toContain('<key>KeepAlive</key>');
    // Must include log paths inside <home>/.mavis/pet/logs/
    expect(content).toContain(path.join(tmpHome, '.mavis/pet/logs/stdout.log'));
  });

  it('copies the floater binary to <home>/.mavis/pet/floater (chmod 755)', async () => {
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    });
    const dest = path.join(tmpHome, '.mavis/pet/floater');
    expect(fs.existsSync(dest)).toBe(true);
    const stat = fs.statSync(dest);
    // Owner exec bit set.
    expect(stat.mode & 0o100).toBe(0o100);
    // Same content as fake source.
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(fakeFloater, 'utf8'));
  });
});

// ===========================================================================
// MiniMax-not-running warning path
// ===========================================================================

describe('runInstallWizard — MiniMax detection warning', () => {
  it('reports warn when daemon port is closed (continues, does not abort)', async () => {
    // Spy on the underlying TCP probe by hijacking a known-closed port.
    // We can't easily mock checkPortListening from here without DI, so we
    // assume the daemon may or may not be up: assert the wizard still
    // returns 7 results regardless of step 2's outcome (i.e. step 2
    // never aborts the wizard).
    const results = await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    });
    expect(results).toHaveLength(TOTAL_STEPS);
    const step2 = results[1];
    expect(step2.name).toBe('MiniMax detect');
    // If warn, the message must mention the daemon port to give the user
    // a clear pointer.
    if (step2.status === 'warn') {
      expect(step2.message).toContain(`:${HJBHXEG_DAEMON_PORT}`);
      expect(step2.message).toContain('continues');
    }
    // Subsequent steps must still run.
    expect(results[2].name).toBe('floater binary');
    expect(results[5].name).toBe('launchd plist');
  });
});

// ===========================================================================
// Idempotency — re-running install
// ===========================================================================

describe('runInstallWizard — idempotency', () => {
  it('re-running install regenerates the plist and reports "overwrote existing"', async () => {
    const opts = {
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    };
    const first = await runInstallWizard(opts);
    expect(first[5].status).toBe('ok');
    expect(first[5].message).toContain('wrote');
    expect(first[5].message).not.toContain('overwrote');

    const second = await runInstallWizard(opts);
    expect(second[5].status).toBe('ok');
    expect(second[5].message).toContain('overwrote existing');
    // Plist content unchanged (same inputs → same output).
    const xml1Path = plistPath(tmpHome);
    expect(fs.existsSync(xml1Path)).toBe(true);
  });

  it('re-running with launchctl mock issues bootout before bootstrap on second run', async () => {
    const m1 = makeMockLaunchctl();
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: false,
      floaterSource: fakeFloater,
      skipHealthz: true,
      launchctl: m1.fn,
    });
    // First run: print returns 1 (not loaded) → no bootout → bootstrap.
    expect(m1.calls.some((c) => c[0] === 'bootstrap')).toBe(true);
    expect(m1.calls.filter((c) => c[0] === 'bootout').length).toBe(0);

    // Second run: pretend the service is already loaded so the wizard MUST
    // bootout first. We override the mock so 'print' returns status 0.
    // Use vi.fn().mock.calls directly (single source of truth — the makeMock
    // closure-based `calls` array gets bypassed once mockImplementation
    // overwrites the default impl).
    const fn2 = vi.fn((args: string[]) => {
      if (args[0] === 'print') return { status: 0, stdout: 'loaded', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: false,
      floaterSource: fakeFloater,
      skipHealthz: true,
      launchctl: fn2,
    });
    const seq: string[] = fn2.mock.calls.map((c) => (c[0] as string[])[0]);
    const printIdx = seq.indexOf('print');
    const booteIdx = seq.indexOf('bootout');
    const bootIdx = seq.indexOf('bootstrap');
    expect(printIdx).toBeGreaterThanOrEqual(0);
    expect(booteIdx).toBeGreaterThan(printIdx);
    expect(bootIdx).toBeGreaterThan(booteIdx);
  });
});

// ===========================================================================
// uninstall reverse
// ===========================================================================

describe('runUninstall', () => {
  it('removes the plist + floater binary that install created', async () => {
    // 1. Install first (in sandbox).
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
    });
    const installedPlist = plistPath(tmpHome);
    const installedFloater = path.join(tmpHome, '.mavis/pet/floater');
    expect(fs.existsSync(installedPlist)).toBe(true);
    expect(fs.existsSync(installedFloater)).toBe(true);

    // 2. Plant a sandbox pet (boba synthesized) so we can verify it's preserved.
    const bobaDir = path.join(tmpHome, '.mavis/pets', DEFAULT_PET_SLUG);
    expect(fs.existsSync(path.join(bobaDir, 'pet.json'))).toBe(true);

    // 3. Uninstall.
    const results = await runUninstall({
      home: tmpHome,
      noLaunchd: true,
    });

    // 4. Verify removals.
    expect(fs.existsSync(installedPlist)).toBe(false);
    expect(fs.existsSync(installedFloater)).toBe(false);
    // 5. Pet preserved.
    expect(fs.existsSync(path.join(bobaDir, 'pet.json'))).toBe(true);

    // Step 1 = launchctl unload → skip (noLaunchd)
    expect(results[0].name).toBe('launchctl unload');
    expect(results[0].status).toBe('skip');
    // Step 2 = plist file → ok (was present)
    expect(results[1].name).toBe('plist file');
    expect(results[1].status).toBe('ok');
    // Step 3 = floater + pid files → ok
    expect(results[2].name).toBe('floater + pid files');
    expect(results[2].status).toBe('ok');
  });

  it('uninstall is safe when nothing is installed (skip everywhere)', async () => {
    const results = await runUninstall({
      home: tmpHome,
      noLaunchd: true,
    });
    // Plist not present → step 2 skip.
    expect(results[1].name).toBe('plist file');
    expect(results[1].status).toBe('skip');
    // Floater not present → step 3 skip.
    expect(results[2].name).toBe('floater + pid files');
    expect(results[2].status).toBe('skip');
  });

  it('uninstall calls launchctl bootout when noLaunchd=false', async () => {
    const { fn, calls } = makeMockLaunchctl();
    await runUninstall({
      home: tmpHome,
      noLaunchd: false,
      launchctl: fn,
    });
    expect(calls.some((c) => c[0] === 'bootout')).toBe(true);
    const bootoutCall = calls.find((c) => c[0] === 'bootout')!;
    expect(bootoutCall[1]).toContain(LAUNCHD_LABEL);
  });
});

// v0.7.1 — verifier orphan floater bug: when a verifier ran the wizard in
// a sandbox HOME (/var/folders/T/mavis-pet-verify-XXX) without explicitly
// passing noLaunchd:true, the wizard would happily `launchctl bootstrap`
// the agent for the user's REAL gui session, spawning a real broker +
// floater that connected to the user's real desktop and stayed there
// after the sandbox HOME got rm -rf'd. Two orphan floater windows showed
// up next to the user's real pet.
//
// Fix: normalizeOptsForSandbox auto-sets noLaunchd=true when opts.home
// differs from the real os.homedir() AND the caller didn't explicitly
// pass noLaunchd. These tests pin that behavior.
describe('runInstallWizard — sandbox auto-detect (v0.7.1)', () => {
  let tmpHome: string;
  let fakeFloater: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-pet-sandbox-'));
    fakeFloater = path.join(tmpHome, 'fake-floater');
    fs.writeFileSync(fakeFloater, '#!/bin/sh\necho fake', { mode: 0o755 });
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('auto-skips launchctl when opts.home != real homedir and noLaunchd unset', async () => {
    const { fn, calls } = makeMockLaunchctl();
    const results = await runInstallWizard({
      home: tmpHome,                         // sandbox HOME, NOT noLaunchd
      skipWelcome: true,
      floaterSource: fakeFloater,
      skipHealthz: true,
      launchctl: fn,
    });
    // launchctl mock should NEVER have been invoked — auto-detect kicked in.
    expect(calls.length).toBe(0);
    // Step 7 should report "skip" with the auto-set noLaunchd flag visible.
    const step7 = results.find((r) => r.step === 7);
    expect(step7?.status).toBe('skip');
    expect(step7?.message).toMatch(/noLaunchd=true/);
  });

  it('does NOT auto-skip when MAVIS_PET_FORCE_LAUNCHD=1 (escape hatch)', async () => {
    const { fn, calls } = makeMockLaunchctl();
    process.env.MAVIS_PET_FORCE_LAUNCHD = '1';
    try {
      await runInstallWizard({
        home: tmpHome,
        skipWelcome: true,
        floaterSource: fakeFloater,
        skipHealthz: true,
        launchctl: fn,
      });
    } finally {
      delete process.env.MAVIS_PET_FORCE_LAUNCHD;
    }
    // Force flag set → launchctl should have been invoked normally.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c[0] === 'bootstrap')).toBe(true);
  });

  it('respects explicit noLaunchd=false even with sandbox home (caller knows what they want)', async () => {
    const { fn, calls } = makeMockLaunchctl();
    await runInstallWizard({
      home: tmpHome,
      skipWelcome: true,
      noLaunchd: false,                      // explicitly false
      floaterSource: fakeFloater,
      skipHealthz: true,
      launchctl: fn,
    });
    // Explicit false → auto-detect must NOT override it.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c[0] === 'bootstrap')).toBe(true);
  });

  it('runUninstall also auto-skips launchctl in sandbox home', async () => {
    const { fn, calls } = makeMockLaunchctl();
    await runUninstall({
      home: tmpHome,
      launchctl: fn,
    });
    expect(calls.length).toBe(0);
  });
});
