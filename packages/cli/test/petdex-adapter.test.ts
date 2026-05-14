/**
 * petdex-adapter unit tests.
 *
 * Verifies:
 *   - translatePetdexMeta produces the right mavis-pet shape with the
 *     petdex grid + state_rows mapping
 *   - listPetdexPets / findPetdexPet handle missing dirs gracefully
 *   - adaptPetdexPet copies sprite + writes translated pet.json into a
 *     temp HOME (we redirect via vi.spyOn(os, 'homedir'))
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PETDEX_STATE_ROWS,
  translatePetdexMeta,
} from '../src/petdex-adapter.js';

describe('translatePetdexMeta', () => {
  it('maps a full petdex pet.json into mavis-pet shape', () => {
    const out = translatePetdexMeta('boba', {
      id: 'boba',
      displayName: 'Boba',
      description: 'A tiny otter sipping bubble tea.',
      spritesheetPath: 'spritesheet.webp',
    });
    expect(out).toEqual({
      slug: 'boba',
      name: 'Boba',
      description: 'A tiny otter sipping bubble tea.',
      source: 'petdex',
      frame_w: 192,
      frame_h: 208,
      rows: 9,
      cols: 8,
      frame_count: 6,
      frame_duration_ms: 1100,
      state_rows: PETDEX_STATE_ROWS,
    });
  });

  it('falls back to slug when displayName is missing', () => {
    const out = translatePetdexMeta('mystery-pet', {
      id: 'mystery-pet',
      spritesheetPath: 'spritesheet.webp',
    });
    expect(out.name).toBe('mystery-pet');
    expect(out.description).toBeUndefined();
  });

  it('survives a null/missing pet.json (uses defaults)', () => {
    const out = translatePetdexMeta('no-meta', null);
    expect(out.slug).toBe('no-meta');
    expect(out.name).toBe('no-meta');
    expect(out.frame_w).toBe(192);
    expect(out.state_rows).toEqual(PETDEX_STATE_ROWS);
  });

  it('returns a fresh state_rows copy (no shared mutation)', () => {
    const a = translatePetdexMeta('a', null);
    a.state_rows.idle = 999;
    const b = translatePetdexMeta('b', null);
    expect(b.state_rows.idle).toBe(0);
  });
});

describe('PETDEX_STATE_ROWS', () => {
  it('covers all 8 mavis-pet PetStates', () => {
    const expected = [
      'idle', 'wave', 'run', 'jump',
      'review', 'failed', 'extra1', 'extra2',
    ];
    for (const s of expected) {
      expect(PETDEX_STATE_ROWS).toHaveProperty(s);
    }
  });

  it('matches the petdex grid (9 rows, 0..8)', () => {
    for (const v of Object.values(PETDEX_STATE_ROWS)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(9);
    }
  });

  it('maps idle/wave/run/failed to petdex semantic equivalents', () => {
    expect(PETDEX_STATE_ROWS.idle).toBe(0);     // petdex idle
    expect(PETDEX_STATE_ROWS.wave).toBe(3);     // petdex waving
    expect(PETDEX_STATE_ROWS.run).toBe(7);      // petdex running
    expect(PETDEX_STATE_ROWS.jump).toBe(4);     // petdex jumping
    expect(PETDEX_STATE_ROWS.review).toBe(8);   // petdex review
    expect(PETDEX_STATE_ROWS.failed).toBe(5);   // petdex failed
  });
});

describe('petdex-adapter IO (temp HOME)', () => {
  let tmpHome: string;
  let realTmpdir: string;

  beforeEach(() => {
    realTmpdir = process.env.TMPDIR || '/tmp';
    tmpHome = fs.mkdtempSync(path.join(realTmpdir, 'mavis-pet-adapter-'));
    // The adapter checks MAVIS_PET_TEST_HOME first inside its lazy
    // homedir() helper so we don't have to monkey-patch the read-only
    // node:os module (vi.spyOn fails on it; setting $HOME has no effect
    // because Node caches the resolved homedir natively).
    process.env.MAVIS_PET_TEST_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.MAVIS_PET_TEST_HOME;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function makePetdexFixture(slug: string, displayName: string) {
    const dir = path.join(tmpHome, '.petdex/pets', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pet.json'),
      JSON.stringify({
        id: slug,
        displayName,
        description: `${displayName} description`,
        spritesheetPath: 'spritesheet.webp',
      }),
    );
    // Minimal valid webp header bytes (RIFF...WEBP) so file existence checks pass.
    fs.writeFileSync(
      path.join(dir, 'spritesheet.webp'),
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    );
    return dir;
  }

  it('findPetdexPet returns null when nothing installed', async () => {
    const mod = await import('../src/petdex-adapter.js');
    expect(mod.findPetdexPet('nope')).toBe(null);
  });

  it('listPetdexPets returns [] when ~/.petdex/pets/ missing', async () => {
    const mod = await import('../src/petdex-adapter.js');
    expect(mod.listPetdexPets()).toEqual([]);
  });

  it('listPetdexPets enumerates installed petdex pets in sorted order', async () => {
    makePetdexFixture('zoe', 'Zoe');
    makePetdexFixture('alpha', 'Alpha');
    makePetdexFixture('mid', 'Mid');
    const mod = await import('../src/petdex-adapter.js');
    const pets = mod.listPetdexPets();
    expect(pets.map((p: { slug: string }) => p.slug)).toEqual(['alpha', 'mid', 'zoe']);
    for (const p of pets) {
      expect(p.meta).not.toBeNull();
    }
  });

  it('listPetdexPets skips dirs missing pet.json or spritesheet.webp', async () => {
    fs.mkdirSync(path.join(tmpHome, '.petdex/pets/incomplete'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.petdex/pets/incomplete/pet.json'), '{}');
    // Missing spritesheet.webp on purpose.
    makePetdexFixture('valid', 'Valid');
    const mod = await import('../src/petdex-adapter.js');
    const pets = mod.listPetdexPets();
    expect(pets.map((p: { slug: string }) => p.slug)).toEqual(['valid']);
  });

  it('adaptPetdexPet copies sprite + writes translated pet.json', async () => {
    makePetdexFixture('super-goku', 'Super Goku');
    const mod = await import('../src/petdex-adapter.js');
    const dest = mod.adaptPetdexPet('super-goku');
    expect(dest).toBe(path.join(tmpHome, '.mavis/pets/super-goku'));

    // Sprite copied verbatim.
    const copied = fs.readFileSync(path.join(dest, 'spritesheet.webp'));
    expect(copied[0]).toBe(0x52); // 'R' (RIFF)
    expect(copied[8]).toBe(0x57); // 'W' (WEBP)

    // pet.json translated.
    const meta = JSON.parse(fs.readFileSync(path.join(dest, 'pet.json'), 'utf8'));
    expect(meta.slug).toBe('super-goku');
    expect(meta.name).toBe('Super Goku');
    expect(meta.source).toBe('petdex');
    expect(meta.rows).toBe(9);
    expect(meta.cols).toBe(8);
    expect(meta.state_rows.idle).toBe(0);
    expect(meta.state_rows.review).toBe(8);
  });

  it('adaptPetdexPet throws when source missing', async () => {
    const mod = await import('../src/petdex-adapter.js');
    expect(() => mod.adaptPetdexPet('does-not-exist')).toThrow(/not found/);
  });

  it('adaptPetdexPet is idempotent — re-running overwrites cleanly', async () => {
    makePetdexFixture('boba', 'Boba');
    const mod = await import('../src/petdex-adapter.js');
    const first = mod.adaptPetdexPet('boba');
    const firstMeta = fs.readFileSync(path.join(first, 'pet.json'), 'utf8');
    // Tweak the destination so we can detect it was overwritten.
    fs.writeFileSync(path.join(first, 'pet.json'), '{"manually-modified": true}');
    const second = mod.adaptPetdexPet('boba');
    const secondMeta = fs.readFileSync(path.join(second, 'pet.json'), 'utf8');
    expect(secondMeta).toBe(firstMeta);
    expect(secondMeta).not.toContain('manually-modified');
  });
});
