# Publishing guide — mavis-pet v0.1.0

Everything is ready to publish. Below is the **copy-paste sequence** that gets
mavis-pet on npm + GitHub Release in ~10 minutes.

---

## 0. Pre-flight (one-time)

You need:
- A GitHub account / org you can create a repo under
- An npm account that can publish to the `mavis-pet` name and the
  `@mavis-pet` scope (run `npm login` if you haven't)

---

## 1. Set the repo URL (one find/replace)

The 3 package.json + README + install.sh all reference `vinozhong33/mavis-pet`.
Replace it with your real GitHub `<org>/<repo>` (e.g. `vino/mavis-pet`):

```bash
cd ~/mavis-pet
ORG="vino"          # ← change this
NEW="$ORG/mavis-pet"
grep -rl 'vinozhong33/mavis-pet' . --exclude-dir=node_modules --exclude-dir=target --exclude-dir=release \
  | xargs sed -i '' "s|vinozhong33/mavis-pet|$NEW|g"
```

Verify:
```bash
grep -rn "$NEW" --include="package.json" --include="*.md" --include="*.sh" .
```

---

## 2. First commit + push to GitHub

Create the empty repo on GitHub (UI), then:

```bash
cd ~/mavis-pet
git add -A
git commit -m "v0.1.0: initial release

mavis-pet — desktop animated pet floater that reacts to mavis hook events.
Sprite-format-compatible with petdex.

- packages/broker  Node + TS event hub, 33/33 tests
- packages/floater Tauri (Rust) transparent always-on-top sprite window
- packages/cli     mavis-pet CLI (install/start/stop/status/hook ...)
"
git remote add origin git@github.com:$ORG/mavis-pet.git
git push -u origin main
```

---

## 3. npm publish (broker first, then cli)

```bash
# broker — must publish before cli (cli depends on it)
cd ~/mavis-pet/packages/broker
npm publish --access public

# cli
cd ~/mavis-pet/packages/cli
npm publish --access public
```

Test from a fresh shell:
```bash
npm i -g mavis-pet
mavis-pet --help
```

---

## 4. Build floater binary (already done) + GitHub Release

The floater zip is already in `release/`:
```
release/mavis-pet-floater-v0.1.0-darwin-arm64.zip   (1.3 MB)
```

Use [`gh`](https://cli.github.com/) to create the release:

```bash
cd ~/mavis-pet
gh release create v0.1.0 \
  release/mavis-pet-floater-v0.1.0-darwin-arm64.zip \
  --title "mavis-pet v0.1.0 — desktop pet for mavis" \
  --notes "First public release.

## What's in the box

- Node broker + Tauri floater + mavis-pet CLI
- Petdex sprite-format compatible (\`npx petdex install\` interop)
- 4 animation states (idle / run / wave / failed) driven by mavis hook events
- macOS Apple Silicon binary (Intel / Linux / Windows: TBD)

## Install

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/$ORG/mavis-pet/main/install.sh | sh
\`\`\`

Or manually:
\`\`\`bash
npm i -g mavis-pet @mavis-pet/broker
# then download the floater binary from this release into ~/.mavis/pet/
\`\`\`

## Known gaps vs codex pet (intentional v0 scope, see roadmap-mavis-pet.md)

- No speech bubbles (R3-style extra)
- No /pet slash command
- No hatch-pet creator skill
- 4 of 8 sprite states wired (jump/review/extra1/extra2 deferred)

See README.md for full architecture.
"
```

---

## 5. End-to-end smoke test on the published artifacts

Open a **fresh terminal**, ideally on a clean machine or VM:

```bash
curl -fsSL https://raw.githubusercontent.com/$ORG/mavis-pet/main/install.sh | sh
mavis-pet install boba
mavis-pet hook install
mavis-pet start
# trigger something — bash command in mavis or curl POST /event
```

If the pet shows up and reacts, ship it 🚀

---

## 6. (Optional) Bump-version-and-republish loop

```bash
# in any package
npm version patch    # 0.1.0 -> 0.1.1
git push --follow-tags
npm publish
```

---

## 7. Long-term: where to go from here

1. **mavis main-repo PR** (you have permissions): turn mavis-pet into a
   proper mavis plugin / first-class subcommand. See `roadmap-mavis-pet.md`
   for the design.
2. **Cross-platform builds**: GitHub Actions matrix on
   {macos-latest, ubuntu-latest, windows-latest} running
   `scripts/build-floater.sh` and uploading per-platform zips.
3. **Speech bubbles + more states**: roadmap R1-R10.
