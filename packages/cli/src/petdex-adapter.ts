/**
 * petdex → mavis-pet adapter.
 *
 * Bridges the petdex pet gallery (~/.petdex/pets/<slug>/) into mavis-pet's
 * native pet directory (~/.mavis/pets/<slug>/) by:
 *
 *   1. Copying the petdex spritesheet.webp verbatim (we own a copy in
 *      ~/.mavis/pets/, never touch ~/.petdex/).
 *   2. Translating petdex's minimal pet.json
 *        { id, displayName, description, spritesheetPath }
 *      into a mavis-pet pet.json that the floater understands, including
 *      the petdex grid metadata (1536 × 1872 = 8 cols × 9 rows, 192×208
 *      per frame, 6 frames per state) AND a `state_rows` map that remaps
 *      petdex's row order to mavis-pet's PetState animation slots.
 *
 * Why the row mapping matters
 * ---------------------------
 * petdex spritesheets follow a fixed 9-row layout (verified against
 * ~/.petdex/runtime/webview/index.html):
 *
 *   row 0: idle             row 5: failed
 *   row 1: running-right    row 6: waiting
 *   row 2: running-left     row 7: running (generic)
 *   row 3: waving           row 8: review
 *   row 4: jumping
 *
 * mavis-pet's PetState set is { idle, wave, run, jump, review, failed,
 * extra1, extra2 } and the floater historically assumed
 * "STATES array index == row index". That works for mikoko (vino's own
 * 8-row sprite designed to match) but breaks for any petdex sprite where
 * "wave" lives on row 3 instead of row 1.
 *
 * The floater (lib.rs + dist/index.html, this branch) was extended to
 * accept an optional `state_rows` field in the pet payload that overrides
 * the implicit positional mapping. This adapter is the producer of that
 * field for petdex pets.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Resolved lazily inside the helpers so test fixtures can swap HOME via
// process.env.MAVIS_PET_TEST_HOME (Node's `os.homedir()` is a native call
// whose return value can't be patched via spyOn — it's a read-only ESM
// export). The env-based override has no effect in production: nothing
// sets MAVIS_PET_TEST_HOME outside of vitest fixtures.
function homedir(): string {
  return process.env.MAVIS_PET_TEST_HOME || os.homedir();
}
function petdexPetsDir(): string {
  return path.join(homedir(), '.petdex/pets');
}
function mavisPetsDir(): string {
  return path.join(homedir(), '.mavis/pets');
}

/**
 * petdex-grid-relative row index for each mavis-pet PetState.
 * Hardcoded against petdex's webview/index.html STATES table — this is the
 * source of truth for petdex's grid layout and is not exposed via any
 * petdex API or pet.json field. If petdex ever changes their grid layout
 * we'll need to update this constant (and the floater dist/index.html
 * defaults won't help — they assume mavis-pet's own ordering).
 *
 * Mapping rationale:
 *   - idle/wave/jump/review/failed map to their petdex semantic equivalent.
 *   - run uses petdex's "running" (row 7), the generic running animation.
 *     petdex also has running-left (row 2) and running-right (row 1) for
 *     drag-direction parity but we don't have a "left/right" distinction
 *     on the mavis-pet side.
 *   - extra1 (mavis SessionStart overlay) → "waiting" (row 6) since both
 *     are "expectant pose" semantics.
 *   - extra2 (mavis SessionEnd overlay) → "running-right" (row 1) as a
 *     visual mismatch but ensures the row exists. Most users never see
 *     extra2 long enough to notice (~2.5s at session end).
 */
export const PETDEX_STATE_ROWS: Record<string, number> = {
  idle: 0,
  wave: 3,
  run: 7,
  jump: 4,
  review: 8,
  failed: 5,
  extra1: 6,
  extra2: 1,
};

/** Petdex pet.json schema (only the fields we use). */
export interface PetdexPetMeta {
  id: string;
  displayName?: string;
  description?: string;
  spritesheetPath?: string;
}

/** Mavis-pet pet.json schema (only the fields the floater reads). */
export interface MavisPetMeta {
  slug: string;
  name: string;
  description?: string;
  source: 'petdex';
  frame_w: number;
  frame_h: number;
  rows: number;
  cols: number;
  frame_count: number;
  frame_duration_ms: number;
  state_rows: Record<string, number>;
}

/**
 * Returns the absolute path of a petdex pet directory if it exists and
 * looks valid (has both pet.json and spritesheet.webp). Otherwise null.
 */
export function findPetdexPet(slug: string): string | null {
  if (!slug) return null;
  const dir = path.join(petdexPetsDir(), slug);
  const meta = path.join(dir, 'pet.json');
  const sprite = path.join(dir, 'spritesheet.webp');
  if (fs.existsSync(meta) && fs.existsSync(sprite)) return dir;
  return null;
}

/**
 * List every installed petdex pet by slug. Returns [] if the petdex pets
 * directory doesn't exist (petdex not installed) or no pets have been
 * downloaded yet.
 */
export function listPetdexPets(): { slug: string; dir: string; meta: PetdexPetMeta | null }[] {
  const root = petdexPetsDir();
  if (!fs.existsSync(root)) return [];
  const out: { slug: string; dir: string; meta: PetdexPetMeta | null }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const metaPath = path.join(dir, 'pet.json');
    const spritePath = path.join(dir, 'spritesheet.webp');
    if (!fs.existsSync(metaPath) || !fs.existsSync(spritePath)) continue;
    let meta: PetdexPetMeta | null = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PetdexPetMeta;
    } catch {
      meta = null;
    }
    out.push({ slug: entry.name, dir, meta });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Translate a petdex pet.json into a mavis-pet pet.json. Pure function;
 * does no IO. Useful for unit tests.
 */
export function translatePetdexMeta(slug: string, raw: PetdexPetMeta | null): MavisPetMeta {
  return {
    slug,
    name: raw?.displayName || slug,
    description: raw?.description,
    source: 'petdex',
    // Petdex grid (verified against ~/.petdex/runtime/webview/index.html
    // and `sips -g pixelWidth -g pixelHeight` on the actual sprites).
    frame_w: 192,
    frame_h: 208,
    rows: 9,
    cols: 8,
    frame_count: 6,
    frame_duration_ms: 1100,
    state_rows: { ...PETDEX_STATE_ROWS },
  };
}

/**
 * Install a petdex pet into ~/.mavis/pets/<slug>/. Idempotent — overwrites
 * the destination on every call so re-running picks up petdex updates.
 *
 * Returns the destination directory.
 *
 * Throws if the source petdex pet doesn't exist (caller should have used
 * findPetdexPet first to detect that).
 */
export function adaptPetdexPet(slug: string): string {
  const src = findPetdexPet(slug);
  if (!src) {
    throw new Error(`petdex pet '${slug}' not found in ${petdexPetsDir()}`);
  }
  const dest = path.join(mavisPetsDir(), slug);
  fs.mkdirSync(dest, { recursive: true });

  // 1. Copy spritesheet.webp verbatim (we don't decode/re-encode webp;
  //    Tauri's webview renders it natively via image/webp data URL).
  fs.copyFileSync(
    path.join(src, 'spritesheet.webp'),
    path.join(dest, 'spritesheet.webp'),
  );

  // 2. Generate mavis-pet pet.json from the petdex source.
  let petdexMeta: PetdexPetMeta | null = null;
  try {
    petdexMeta = JSON.parse(
      fs.readFileSync(path.join(src, 'pet.json'), 'utf8'),
    ) as PetdexPetMeta;
  } catch {
    // Fall through with null — translatePetdexMeta uses sensible defaults.
  }
  const mavisMeta = translatePetdexMeta(slug, petdexMeta);
  fs.writeFileSync(
    path.join(dest, 'pet.json'),
    JSON.stringify(mavisMeta, null, 2) + '\n',
  );

  return dest;
}
