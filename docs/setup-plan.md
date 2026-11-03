# Setup plan: PDBSplat

This plan sets PDBSplat up from an empty repository as a Vite + React + TypeScript app built on React Three Fiber (R3F), rendering Protein Data Bank structures as Gaussian splats with three.js's built-in splat rendering on its WebGPU renderer. You run the terminal steps yourself. Each phase that changes code has a prompt to paste into a fresh Claude Code thread in this repository, and every phase ends with `/commit`.

The prompts send the agent back to this file, so it is the single source of truth: if you disagree with a default under **Decisions**, edit it here before running the phase that uses it.

Latest versions on 2026-10-30, when this was last checked: three.js r187 (`three@0.187.0`), `@react-three/fiber` 9.8, `@react-three/drei` 10.7, create-vite 9.3 with Vite 8.3, React 19.3, TypeScript 7.0, Oxlint 1.90, Node.js 24.22 LTS and npm 12.2. The same stack was checked in a scratch copy of the template: installed at those versions, a WebGPU scene in Appendix C's shape type-checks with TypeScript 7, passes Oxlint's type-aware rules with warnings failing, and builds with Vite.

## 1. Where it ends up

```
PDBSplat/
├── .claude/skills/commit/      the /commit skill, a copy of the Claude-Skills baseline (section 5)
├── docs/setup-plan.md          this plan, deleted in Phase 7
├── src/
│   ├── main.tsx                React root, in StrictMode
│   ├── App.tsx                 the <Canvas> and the DOM overlays
│   ├── index.css               full-window layout
│   ├── store.ts                zustand: the entry, its loading state, the atoms, the view options
│   ├── pdb/                    fetchEntry.ts, mmcif.ts (the _atom_site reader), elements.ts (colours, radii)
│   └── viewer/                 Viewer, renderer.ts (the WebGPU renderer guard), ProteinSplats
├── index.html                  title, analytics, #root
├── vite.config.ts              base: '' for relative asset paths
├── .oxlintrc.json              lint rules (D1)
├── tsconfig.json, tsconfig.app.json, tsconfig.node.json
├── package.json, package-lock.json   with one npm override, so every package shares the same three (D14)
├── PDBSplat.code-workspace
└── README.md                   for the public
```

Scripts: `dev`, `build` (`tsc -b && vite build`), `preview`, `lint`, `lint:fix`, `typecheck`.

## 2. Decisions

These are the defaults the prompts follow. Change a row before running the phase it affects.

| # | Topic | Default | Alternative |
| --- | --- | --- | --- |
| D1 | Linter (chosen in Phase 1, configured in Phase 2) | **Oxlint**, create-vite's default: its React and TypeScript rules plus type-aware rules, with warnings failing `npm run lint`. Its React rules include React Compiler-style checks, such as `react(immutability)`, which flag mutating what a hook returned; Appendix C's patterns satisfy them, so they stay on | **ESLint** (pick it at the prompt or pass `--eslint`), with `@react-three/eslint-plugin`'s two allocation-in-loop rules |
| D2 | React Compiler | Off (the plain "TypeScript" variant) | `react-compiler-ts`: little to gain in a frame-loop app, and slower builds |
| D3 | Control panel | **leva**. It shows numbers to two decimals at most, which is why Bounder's port dropped it for lil-gui; every value in this panel fits | lil-gui, created in an effect and destroyed on unmount |
| D4 | State | **zustand**: the entry, its loading state, the atoms and the view options, shared by the panel and the scene | React context |
| D5 | Splats | three's built-in **`GaussianSplat`** (r186's addons), built from atom data with its geometry helpers (Appendix A). No Spark | |
| D6 | Analytics | The gtag snippet your other Vite projects use, on every host | Load it only on snovakow.com |
| D7 | Structure data | **mmCIF** from the RCSB's file server, `https://files.rcsb.org/download/<ID>.cif`, which any site may fetch, read in the browser by a small reader of the `_atom_site` table | BinaryCIF, which is smaller but needs a decoder; or the legacy `.pdb` format, which the largest entries don't have |
| D8 | Atoms as splats | One round splat per atom at its coordinates, in ångströms, centred on the structure. Its size comes from the element's van der Waals radius times a panel scale, its colour from the element (the CPK colours Jmol uses), and its opacity from the panel | Colour by chain, residue or B-factor, as panel options |
| D9 | Which atoms | The first model (NMR entries carry many), the first alternate location, hydrogens shown and waters hidden, each with a panel toggle | |
| D10 | Entries to start with | **1CRN**, crambin: 327 atoms, small and fast. **4HHB**, human haemoglobin, as the larger test (4,384 atoms plus 395 hemes and waters). A panel field loads any PDB ID | |
| D11 | Build output | `dist/` with `base: ''`; deploy by copying `dist/` into a new `~/Sites/localhost/live/pdbsplat/`, served at snovakow.com/pdbsplat | Another path name |
| D12 | Version | There's no earlier version to continue, so versions start at `0.0.0`, the Vite template's. Only `/commit` changes them, each time with a version commit that becomes the next run's baseline (section 5). Phase 1's `/commit 0.0.1` makes the first; every run after it bumps the last number; Phase 7's `/commit 0.1.0` marks the first release, the one merged into `main` and deployed. Phase 0's run has no `package.json` to version, so it ends without one, and pushing closes it | Keep bumping the last number at the release too, as timspicks does |
| D13 | Renderer | three's **`WebGPURenderer`**, created by an async `gl` factory on the Canvas that awaits `renderer.init()`. `GaussianSplat` needs it: plain `WebGLRenderer` can't draw these splats. Where a browser lacks WebGPU, the renderer falls back to its WebGL 2 backend, and the splats still draw, sorted on the CPU instead of the GPU | |
| D14 | Versions | **Latest of everything** at install time, and again whenever `/commit` reports something behind (`npm outdated`). create-vite's template already pins TypeScript 7.0. One npm override, `"three": "$three"`, makes drei's `stats-gl` share the app's three instead of bundling its own. Deliberate holds: Node.js 24 LTS, because Node 26 won't start on this Mac's macOS 12.7 (it needs 13.5); `@types/node` 24 to match it; and React within R3F's peer range (19.0 to 19.3, which is also the latest today) | Keep the template's pins |
| D15 | Tests | None, as in your other projects | Vitest for the mmCIF reader, which has the most edge cases |
| D16 | This plan | Deleted in Phase 7, before the first merge to `main`; git history keeps it | Keep it under `docs/` |

## 3. How to run a phase

1. Read the phase, and do its **You** steps: git steps in GitHub Desktop, and the rest in a terminal at the repository root.
2. Open a fresh Claude Code thread in this repository and paste the phase's **Prompt**. The agent reads this file, does that phase only, runs the checks, and summarises without committing.
3. Do the phase's **Check** yourself and ask for fixes in the same thread.
4. Open another fresh thread and run `/commit` with a note naming the phase, such as `/commit Phase 4 of docs/setup-plan.md`. It has to be the thread's first message: the skill stops otherwise, because a thread that wrote the code can't review it from the repository alone. The note lets it read the phase for intent. It fixes what it can in commits that aren't pushed yet, such as a vague message, and asks before committing over a failing check or anything else it can't settle.
5. Start the next phase in a new thread.

If a phase goes badly, GitHub Desktop's Changes tab shows what it touched. **Branch → Discard All Changes…** puts the changed files back and moves the new ones to the Trash. Check the list first: it also discards anything else that isn't committed. Then run the prompt again.

## 4. Phases

### Before Phase 0: bring the tools up to date

**You**

Node and npm are installed for the whole Mac, so Bounder's port already did steps 1 and 2: on 2026-11-02 this Mac had Node.js 24.22.2, the latest LTS, and npm 12.2.1, the latest. Run the check at the end of step 2, and repeat the steps only if it shows something older.

1. **Node.js 24.22.2**, the latest LTS. Install it with the macOS installer (the x64 `.pkg`) from nodejs.org, into `/usr/local/bin`. Node 26 is newer, but it fails to start on this Mac's macOS 12.7.6 (`dyld: Symbol not found` in `libc++`); its builds need macOS 13.5 or later. Node 24 stays supported until April 2028, and upgrading macOS is what would unlock Node 26.
2. **npm 12**, which needs Node 24.15 or later, so it comes after Node. The installer's global folder belongs to root, hence `sudo`:

   ```sh
   sudo npm install -g npm@latest
   node -v && npm -v
   ```

   Expect v24.22.2 or a later 24.x, and 12.x.

   `sudo npm` can leave root-owned files in your npm cache, and then later installs fail with `EACCES` under `~/.npm/_cacache`. Hand the cache back to yourself:

   ```sh
   sudo chown -R "$(id -un)":staff ~/.npm
   ```

3. **git**, optionally. Apple's 2.37.1 is the newest its command-line tools offer on macOS 12, and the current release is 2.56. Homebrew supports macOS 12 only at its lowest tier, building from source, and MacPorts is the other route. The `/commit` skill works with 2.37 either way.

### Phase 0: start the development branch, commit this plan and the skill, and push

**You**

1. Work lands on `development` and reaches `main` by merge. Create it: in GitHub Desktop, choose **Current Branch → New Branch**, name it `development`, and base it on `main`. When Desktop asks what to do with your uncommitted changes, bring them to `development`.

2. In a fresh Claude Code thread here, run `/commit Plan and tooling for setting up PDBSplat`. Expect separate commits for the `/commit` skill, the public README, this plan and `PDBSplat.code-workspace`. There's no version commit yet, because there's no `package.json` until Phase 1 (D12).
3. Push `development`, which puts it on GitHub: click **Publish branch**.

   Until the first version commit, a run's baseline is the newest pushed commit, so pushing is what closes this run. Without the push, Phase 1's run would ask about these commits before reading them; answering that it should keep them all, as already reviewed, does the same.

### Phase 1: scaffold Vite in place and install the 3D stack

**You**

1. Scaffold into this folder:

   ```sh
   npm create vite@latest . -- --template react-ts
   ```

   Answer its prompts like this:
   - *Current directory is not empty*: **Ignore files and continue**. Not "Remove existing files", which deletes everything except `.git`, including `.claude/` and `docs/`. Since those are committed, **Discard All Changes** in GitHub Desktop would bring them back, but don't.
   - *Package name*: **pdbsplat**, the default it offers, since npm names can't have capitals.
   - *Which linter to use?*: **Oxlint** (D1).
   - *Install with npm and start now?*: **No**.

   It writes the template's files into the folder, overwriting `README.md`. Bring back the public README: in GitHub Desktop's Changes tab, right-click `README.md` and choose **Discard Changes…**.

2. Install everything at its latest version (D14): the template's own packages, which create-vite pins a little behind, and the 3D stack. Then add the override that makes every package share the app's three, and install once more to apply it:

   ```sh
   npm install
   npm install react@latest react-dom@latest three@latest @react-three/fiber@latest @react-three/drei@latest leva@latest zustand@latest
   npm install --save-dev vite@latest @vitejs/plugin-react@latest typescript@latest oxlint@latest @types/react@latest @types/react-dom@latest @types/three@latest @types/node@24
   npm pkg set 'overrides.three=$three'
   npm install
   ```

   Leave out `leva` or `zustand` if you changed D3 or D4. npm 12 runs no install scripts that haven't been approved, so it warns that `fsevents`' was skipped. That's harmless: it's an optional macOS file watcher, and the dev server, lint and build work without it.

3. Check that there is one three.js, with types from the same release, and that nothing is behind:

   ```sh
   npm ls three @types/three
   npm outdated
   ```

   Expect `three@0.187.x` (or newer) everywhere, deduped under fiber, drei, three-stdlib and stats-gl, and `@types/three` at the same minor version. `npm outdated` should list only `@types/node`, held at 24 to match Node (D14). If npm reports a React peer conflict, it's because R3F 9 accepts React 19.0 to 19.3, so a newer React has come out: run `npm install react@~19.3 react-dom@~19.3`, and hold it there until R3F catches up.

4. Check the untouched template: run `npm run dev` and open the URL it prints (stop it with Ctrl+C), then `npm run lint` and `npm run build`.
5. In a fresh thread, run `/commit 0.0.1 Phase 1 of docs/setup-plan.md`. Expect the scaffold with its dependencies, then `Version 0.0.1`, the first version commit (D12). From here on, every run ends with one.

### Phase 2: app shell and tooling

**Prompt**

```text
Read docs/setup-plan.md: sections 1 and 2, Phase 2, and Appendix C. Carry out Phase 2 only: turn the fresh create-vite scaffold into PDBSplat's app shell and tooling. If the plan turns out to be wrong or impossible somewhere, stop and tell me instead of improvising. Don't commit. Finish with npm run lint, npm run typecheck and npm run build passing, then summarise what changed and anything you couldn't do.
```

**The work**

1. Remove the template's demo: `src/App.css`, `src/assets/`, `public/icons.svg`, and `public/favicon.svg` with its `<link>`. `src/App.tsx` renders a full-window `<Canvas>` with nothing in it yet.
2. `index.html`: `lang="en"`, the title "PDBSplat", a one-line meta description, and Google's standard gtag snippet (D6): the async `gtag.js` script and the `dataLayer` setup, with measurement ID G-DV1KLMY93N, at the top of `<head>` as your other sites have it. Keep `#root` and the module script.
3. `src/index.css`: only what the app needs. `html`, `body` and `#root` fill the window, with no margin, no scrollbars and a black background, which splats read best against.
4. `vite.config.ts`: `base: ''` (D11), with a one-line comment saying why. The WebGPU build of three makes one chunk of about 2 MB, so raise `build.chunkSizeWarningLimit` to cover it rather than splitting chunks.
5. `package.json`: add `"typecheck": "tsc -b"` and `"lint:fix": "oxlint --fix"` to the template's scripts. Leave the version alone; only `/commit` changes it (D12).
6. `.oxlintrc.json` (D1): keep the template's plugins and rules, and:
   - ignore `.claude/**`, whose `/commit` scan script stays word for word the Claude-Skills baseline (section 5) and fails type-aware `require-array-sort-compare` on two sorts
   - make the `correctness` category errors, and add `suspicious` as warnings
   - turn off `react/react-in-jsx-scope`, which `suspicious` brings in and React's automatic JSX runtime makes obsolete; with warnings failing, it would fail every `.tsx` file
   - make warnings fail the run (`options.denyWarnings`)
   - turn on type-aware rules: `npm install --save-dev oxlint-tsgolint@latest`, then `options.typeAware`. This was checked with TypeScript 7; if it fails anyway, stop and say why.
   - leave the React Compiler-style rules, such as `react(immutability)`, on, and write code that satisfies them (Appendix C, item 9)
7. `README.md`: add "Running it locally" (Node.js 22.12 or later, which Vite 8 and drei's camera-controls need, `npm install`, `npm run dev`) after "Status", and change "Status" to say the app shell runs but shows no protein yet. Keep its public voice.

**Check** `npm run dev` shows an empty black page with no console errors, and the elements panel shows a `<canvas>` filling the window, two `<div>`s down (`#root > div > div > canvas`), where R3F nests it. Expect one console warning, `THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.` It's R3F's: R3F 9 still makes a `THREE.Clock`, which three deprecated in r183. It needs nothing, and it goes once a stable R3F 10 replaces the clock.

### Phase 3: the viewer and a first splat cloud

**Prompt**

```text
Read docs/setup-plan.md: section 2, Phase 3 and Appendices A and C. Carry out Phase 3 only: set up the WebGPU canvas, the camera and controls, and a test cloud of procedural splats that proves three's GaussianSplat pipeline before any protein data. If the plan turns out to be wrong or impossible somewhere, stop and tell me instead of improvising. Don't commit. Finish with npm run lint and npm run build passing, then summarise, including what I should look at in the browser.
```

**The work**

- `App.tsx`: the `<Canvas>`, with static props (Appendix C, items 1 to 4):
  - `gl`: an async factory that creates three's `WebGPURenderer` with antialiasing, forcing its WebGL 2 fallback when the page URL has `?webgl`, and awaits its `init()` (D13); then logs once with `console.info` whether it got WebGPU or the fallback
  - camera: fov 50, near 0.1, far 5000, since structures are measured in ångströms and span tens to hundreds of them
  - `flat`, so the splats' colours show as given, with no tone mapping
- `src/viewer/renderer.ts`: `asWebGPU()`, the guard that hands components the `WebGPURenderer` that R3F types as a `WebGLRenderer` (item 2).
- `src/viewer/Viewer.tsx`: drei's `<OrbitControls makeDefault />` and `<Stats />`.
- `TestCloud`, temporary: a few thousand splats placed procedurally, such as on a sphere with varied sizes and colours, built with `createGaussianSplatGeometry` and `writeCovariance` and drawn by a `GaussianSplat` (D5; Appendix A; items 5 and 6). Phase 5 replaces it with the protein.

**Check** The console says whether WebGPU or its WebGL 2 fallback is rendering, and `?webgl` forces the fallback. The cloud draws as soft blobs that blend in the right order as you orbit, with either backend.

### Phase 4: loading a structure

**Prompt**

```text
Read docs/setup-plan.md: section 2 (especially D7, D9 and D10), Phase 4 and Appendices A and C. Carry out Phase 4 only: fetch an entry's mmCIF file from the RCSB and read its atoms into the store. If the plan turns out to be wrong or impossible somewhere, stop and tell me instead of improvising. Don't commit. Finish with npm run lint and npm run build passing, then summarise, including what I should try in the browser.
```

**The work**

- `src/pdb/fetchEntry.ts`: check the ID's shape before fetching (four characters, starting with a digit), then fetch `https://files.rcsb.org/download/<ID>.cif`. A new request aborts the one before it, a missing entry (404) reads as "no such entry", a network failure reads as such, and loaded entries are cached by ID (item 8).
- `src/pdb/mmcif.ts`: a small reader for what the app needs, the `_atom_site` table and `_struct.title`. It handles CIF's whitespace-separated values, single- and double-quoted strings, semicolon text fields, and `?` and `.` as empty, and finds columns by name rather than position, since their order varies between entries (Appendix A). Each atom keeps its element, coordinates, chain, residue name and number, atom name, alternate location, occupancy, B-factor, model number and whether it's a heteroatom. It then applies D9: the first model and the first alternate location, keeping hydrogens and waters marked so the panel can toggle them.
- `src/store.ts` (zustand, D4): the entry's ID, its status (idle, loading, ready or failed), the error, the title and the atoms, with a `load(id)` action that starts on 1CRN (D10).

**Check** With the dev tools open: loading 1CRN reports 327 atoms and its title, and 4HHB reports 4,779 atoms, 221 of them waters; neither has hydrogens or alternate locations. An ID like `ABCD` is refused before any request, and an ID with no entry shows an error without a crash. A full reload shows 1CRN again.

### Phase 5: atoms as splats, and the panel

**Prompt**

```text
Read docs/setup-plan.md: section 2 (especially D8 and D9), Phase 5 and Appendices A and C. Carry out Phase 5 only: draw the loaded atoms as Gaussian splats, frame the camera on them, and add the panel. If the plan turns out to be wrong or impossible somewhere, stop and tell me instead of improvising. Don't commit. Finish with npm run lint and npm run build passing, then summarise, including what I should look at in the browser.
```

**The work**

- `src/pdb/elements.ts`: CPK colours (the palette Jmol uses) and van der Waals radii for the elements proteins carry (at least H, C, N, O, S, P, Se, Fe, Zn, Mg, Ca, Na, K and Cl), each with its source in a comment, and a fallback colour and radius for the rest.
- `ProteinSplats`, replacing `TestCloud`: one splat per shown atom (D8), centred on the structure's centroid. Each atom's covariance is a round one from `writeCovariance`, sized so the splat's visible edge sits near the atom's van der Waals radius times the panel's scale; its colour is the element's, with the panel's opacity. Rebuild the geometry only when the atoms or the options change, and free the previous `GaussianSplat` and its geometry when you do (item 6).
- Framing: when an entry loads, fit its bounding sphere in view and put the orbit target on the centroid (item 7).
- The panel, in leva (D3): the PDB ID with a Load button; colour by element or chain; size scale (0.25 to 2, default 1); opacity (0 to 1, default 0.9); hydrogens (on) and waters (off); and, read-only, the title and the number of atoms shown. A failed load shows its message.

**Check** 1CRN appears as a soft cloud of 327 splats: carbon grey, nitrogen blue, oxygen red, sulphur yellow. 4HHB loads framed, showing 4,558 atoms with its waters hidden, its four chains distinct when coloured by chain, and its hemes' iron visible. Showing the waters adds them, the size and opacity sliders act at once, the splats keep blending correctly as you orbit, and Stats shows the frame rate holding. Loading one entry after another doesn't slow the page down.

### Phase 6: review and README

**Prompt**

```text
Read docs/setup-plan.md in full. Carry out Phase 6 only: review the app against the decisions and Appendices A and C, fix what doesn't match, remove leftovers, and bring README.md up to date for the public. Don't commit. Finish with npm run lint, npm run typecheck and npm run build passing; then serve the build with npm run preview and confirm that the page and every asset it references load with HTTP 200 (curl is fine). Summarise what you fixed and anything still open, and give me a checklist to walk through in the browser.
```

**The work**

- Check the code against D5 to D10 and Appendix C, and fix what doesn't match.
- Remove leftovers: template files or text (the Vite and React logos, "Vite + React", `App.css`), `TestCloud` if any of it is left, dependencies nothing imports (compare `npm ls --depth=0` with the imports), `any` or lint suppressions without a stated reason, and `console.log`.
- README.md, for a public reader. Keep the stack line, the Stack table, "Ideas" and the Workflow section, and bring the rest up to date: what PDBSplat shows, the live demo at snovakow.com/pdbsplat, as a present fact, since Phase 7 merges and deploys straight after this phase, the controls and the panel, running and building it (`npm run build` makes a static site in `dist/` that works from any folder), its status, and credits, which include the RCSB PDB for the data. No file paths or internal values; keep the existing voice. Keep the link to this plan for now; Phase 7 removes it.

**You** Walk the agent's checklist in `npm run dev` and again in `npm run preview`. Then, in a fresh thread, run `/commit Phase 6 of docs/setup-plan.md`.

### Phase 7: merge and first deploy

**You**

1. Delete this plan. Read the rest of this phase first; afterwards it is only in git history.

   ```sh
   rm docs/setup-plan.md
   rmdir docs
   ```

   Then, in a fresh thread, run `/commit 0.1.0 Remove the setup plan now that setup is done`. The scan lists the plan among the deleted files, and the run drops the README's link to it in the same batch. Its last commit is `Version 0.1.0`, the first release (D12). Ask it to also bring the `/commit` skill's Version commits setting up to date: it still says the template's `package.json` is to come and that `/commit 0.0.1` makes the first version commit.
2. Merge and push, in GitHub Desktop:
   1. With `development` checked out, choose **Branch → Merge into Current Branch…** and pick `main`. It should say `development` is already up to date with it, meaning `main` has no commits that `development` lacks; close the dialog. If it finds commits instead, merge them, run `/commit` if the merge needs fixes, and start this step again.
   2. Switch **Current Branch** to `main`, choose **Branch → Merge into Current Branch…**, and merge `development`. Since `main` has nothing of its own, this fast-forwards, with no merge commit.
   3. Click **Push origin**, then switch back to `development` and click **Push origin** there too, so GitHub's `development` matches `main`.

3. Build and deploy:

   ```sh
   npm ci
   npm run build
   mkdir -p ~/Sites/localhost/live/pdbsplat
   cp -R dist/ ~/Sites/localhost/live/pdbsplat/
   ```

   Then publish `live/` to snovakow.com the way you do for the other sites.
4. Open https://snovakow.com/pdbsplat/ and check that it loads 1CRN, that another entry loads too (so requests to the RCSB work from the site), that there are no 404s, and that the Network panel shows gtag.
5. Once it's up, add the live demo to the README and run `/commit` in a fresh thread; its version commit is `0.1.1`. Link PDBSplat from your homepage if you want visitors to find it.

## 5. The /commit skill

`.claude/skills/commit/` holds `/commit`, the final review before work enters the repository's history. It's a project copy of the generic skill in [Claude-Skills](https://github.com/snovakow/Claude-Skills/tree/main/skills/commit). Its steps, and its scan below the scan's settings, are the baseline's word for word, and its frontmatter adds only a grant for `npm outdated`. What's PDBSplat's own is the two settings blocks, one at the top of `SKILL.md` and its twin at the top of `scripts/scan.mjs`, and a short "Rules of this repository" section. `metadata.baseline` in the frontmatter dates the baseline it came from, and "Keeping a copy current" in the baseline's README has the diffs that compare a copy with it and the way to bring one up to date.

It runs only when you type it, on Opus at max effort, and only as the first message of a fresh thread. `/commit [x.y.z] [notes]`:

- **Surveys** with `git fetch` and a read-only scan, and stops to ask about:
  - a merge, rebase or similar in progress, or a detached HEAD
  - being on `main`, or behind the upstream
  - a version changed by hand
  - credentials or session data in added lines
  - a file that looks like it shouldn't be tracked, or a large one. Among these are `node_modules`, `dist`, `.env` files, personal Claude settings, keys, and structure files downloaded while testing.
  - before the first version commit, commits above the newest pushed commit, which it asks about before reading any
- **Reviews** every commit since the baseline, the working-tree diff and every untracked file, in full. It checks messages against diffs, comments against code, references a public reader can't follow, and leftovers. PDBSplat's rules add a code review: correctness, a slower request overwriting a newer entry, React and R3F lifecycle, splats and other GPU resources freed when rebuilt, what `WebGPURenderer` can't run, type and lint escapes, and new dependencies.
- **Runs the checks**, `npm run lint`, `npm run typecheck` and `npm run build`, and asks before committing over a failure. Then it runs `npm outdated` and lists what has fallen behind, apart from D14's holds. It never installs or upgrades anything.
- **Fixes what it can** in unpushed commits after the baseline, such as a vague or file-name subject. It amends the tip, or folds `fixup!` and `amend!` commits in with one autosquash rebase and checks that the fold changed no files. Pushed commits are reported, never rewritten.
- **Commits** the batch, planned first: one concern per commit, the file as the unit, explicit paths, and an order in which each commit stands on its own. Subjects are imperative and at most 72 characters. Bodies say why and what was verified, and end with the thread's co-author trailer.
- **Keeps README.md true** for the public. This plan is yours: it commits the plan but never edits it, and says when a change makes it inaccurate.
- **Ends with a version commit** once they've started (D12). Its message is `Version X.Y.Z` alone, by snovakow, with no trailer, and it touches only `package.json` and `package-lock.json`. It's the next run's baseline, and since it's in the history it holds in every clone. Before the first one, a run ends without a version commit, and pushing is what closes it.
- **Reports** what it flagged, each commit, what it left out and why, the checks and their results, and whether the live site needs a rebuild after the merge. It also gives the undo point, `git reset --soft <start>`. It never pushes, never changes branches, and never discards your work.

After the report, more work in the same thread is ordinary development. Once a run has ended with a version commit, that work can be committed as usual, and the next run reviews it. Before then it stays uncommitted, because nothing would tell it apart from the run's own commits.

## Appendix A: reference

Facts the phases rely on, checked on 2026-10-16.

**three r186's Gaussian splats**

- `import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'`, with its helpers in `three/addons/utils/GaussianSplatUtils.js`. `@types/three` 0.186 types both.
- `GaussianSplat` works only with `WebGPURenderer`. Its WebGL 2 fallback is supported, and plain `WebGLRenderer` isn't. It needs `three/webgpu` and `three/tsl` to resolve, which the npm package's exports do.
- `new GaussianSplat(geometry, { autoSort: true })` is a `Mesh`. With `autoSort`, it sorts its splats back to front before rendering whenever the view direction has changed: on the GPU with a compute pass under WebGPU, and on the CPU under the WebGL 2 fallback. It also implements `raycast`.
- `createGaussianSplatGeometry(centers, covariances, colors)` builds the geometry from packed arrays: centres, three floats per splat (`position`); covariances, the six unique entries of each 3 × 3 matrix (xx, xy, xz, yy, yz, zz; `covariance`); and colours, four bytes per splat, RGBA, read as normalised (`color`). It computes the bounding box and sphere. Optional spherical-harmonics bands add view-dependent colour, which atoms don't need.
- `writeCovariance(target, offset, sx, sy, sz, qx, qy, qz, qw)` writes a splat's covariance from its scale and rotation (Σ = R·S·Sᵀ·Rᵀ). A round splat has equal scales and the identity rotation. `writeColorBytes` and the other helpers are in the same file; read their source for the ranges they expect.
- For later (Appendix B): loaders for captured splats, `GaussianSplatPLYLoader`, `SPLATLoader`, `KSPLATLoader`, and a glTF extension.

**The RCSB's files**

- `https://files.rcsb.org/download/<ID>.cif` returns the entry as mmCIF, `chemical/x-cif`, with `Access-Control-Allow-Origin: *`, so the browser can fetch it from any site.
- The `_atom_site` table's columns, as 1CRN has them: `group_PDB` (`ATOM` or `HETATM`), `id`, `type_symbol` (the element), `label_atom_id`, `label_alt_id`, `label_comp_id`, `label_asym_id`, `label_entity_id`, `label_seq_id`, `pdbx_PDB_ins_code`, `Cartn_x`, `Cartn_y`, `Cartn_z` (in ångströms), `occupancy`, `B_iso_or_equiv`, `pdbx_formal_charge`, `auth_seq_id`, `auth_comp_id`, `auth_asym_id`, `auth_atom_id` and `pdbx_PDB_model_num`. Read columns by name; other entries order or omit some.
- `_struct.title` holds the entry's title as a quoted string.
- Test entries: **1CRN**, crambin, 327 atoms, one model, no heteroatoms, titled "WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION…"; **4HHB**, human deoxyhaemoglobin, 4,384 atoms plus 395 heteroatoms (its hemes, and 221 waters), one model. Neither has hydrogens or alternate locations.

## Appendix B: ideas after the setup

From the README and the data:

- The Visible Human Project, and meshes turned into volumes, rendered as splats; three's splat loaders read captured splat files.
- More colourings: by residue, by secondary structure, by B-factor (how much each atom moves).
- Atom picking: `GaussianSplat` implements `raycast`, so hovering could name the atom under the pointer.
- NMR entries' other models, played as an animation.
- BinaryCIF, and parsing in a Web Worker, for the largest entries.

## Appendix C: notes on R3F, WebGPU and three r186 for this project

Checked against the source of `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9 and three 0.186.1, and in a scratch copy of the template built with the latest toolchain. drei, three-stdlib and R3F import nothing that three 0.186.1 lacks. Rechecked on 2026-10-30 against three 0.187.0, with a scene using item 1's factory, `asWebGPU()`, a hand-built `SkyMesh` cube, leva and a `GaussianSplat` built in an effect, type-checked, linted with the Phase 3 config and built; only item 1's backend check needed changing.

1. **Creating the WebGPU renderer.** R3F 9 accepts an async `gl` factory. Narrow the `canvas` it passes, which R3F types more widely than the DOM does, with `if (!(canvas instanceof HTMLCanvasElement)) throw new Error(…)`; TypeScript 7 rejects it unnarrowed. Then construct `new WebGPURenderer({ canvas, antialias: true, forceWebGL })` and `await renderer.init()` before returning it, after which `render()` works each frame (`renderAsync` is deprecated). `'isWebGPUBackend' in renderer.backend` says whether WebGPU or the WebGL 2 fallback is rendering. `@types/three` 0.187 types `backend` as the base `Backend`, which lacks the flag, so `renderer.backend.isWebGPUBackend` doesn't type-check.
2. **R3F types the renderer as a WebGLRenderer.** `useThree((s) => s.gl)` is typed `WebGLRenderer` even though it holds a `WebGPURenderer`. Go through `asWebGPU()` in `src/viewer/renderer.ts`: an `instanceof WebGPURenderer` guard that takes an `object` and narrows it, so no cast is needed.
3. **The Canvas defaults.** With a factory there are no `gl` props, so R3F would set ACES tone mapping once the renderer exists; pass `flat` to keep it off, so the splats' colours show as given. R3F caps the pixel ratio at 2 by default, which suits a dense cloud of splats.
4. **Keep the Canvas props static.** R3F re-applies `shadows`, `flat` and `linear` only when those props change (by shallow comparison). Anything changed at runtime is set on the renderer from inside the Canvas.
5. **Only node materials run under WebGPU.** GLSL `ShaderMaterial`, `RawShaderMaterial` and `onBeforeCompile` don't run; custom shading is TSL (`three/tsl`) or node materials. `GaussianSplat` is built on TSL, so it fits. drei helpers built on GLSL or on WebGL render targets don't work; `OrbitControls` and `Stats` don't depend on the renderer.
6. **The splats' lifecycle.** Build each structure's geometry and its `GaussianSplat` in the effect that owns them, as item 9 says, and dispose of the geometry and the material in that effect's cleanup, which runs when the atoms or the options change and on unmount. They hold GPU buffers and the sort's buffers, so a leak grows with every entry loaded. Never build them during render. Under the WebGL 2 fallback, sorting is CPU work that grows with the atom count, so watch the frame rate on large entries.
7. **Ångströms and framing.** Coordinates arrive in ångströms, far from the origin. Subtract the centroid when filling the centres, then fit the camera to the bounding sphere: back off by `radius / sin(fov / 2)` with a margin, and keep near and far comfortably around it.
8. **Fetching.** Give each load an `AbortController`, aborting the previous one, so a slow response can't overwrite a newer entry. The RCSB serves the files to any origin. Keep parsed entries in a small in-memory cache, by ID.
9. **Satisfying the React Compiler-style lint rules.** Oxlint's `react(immutability)` flags mutating anything a hook returned, `useMemo` and `useThree` results included, even inside an effect. These patterns pass, as checked in the scratch build:
   - Create imperative three objects (the splat geometry, the `GaussianSplat`) inside the effect that owns them, keep them in a ref for later effects, and dispose of them in that effect's cleanup.
   - Read the renderer, scene, camera and controls through `const get = useThree((s) => s.get)`, calling `get()` inside effects and handlers.
   - Mutate per-frame state through refs inside `useFrame`.
10. **Nothing allocates per frame.** Inside `useFrame`, reuse vectors and other objects through refs or module scope.
11. **Versions.** Everything installs at its latest (D14). `npm ls three` should show one three: fiber, drei and three-stdlib take it as a peer, and the `$three` override folds in the copy drei's `stats-gl` would otherwise bring. `@types/three` comes from the same release. TypeScript 7 builds the template's tsconfig unchanged, and Oxlint's type-aware rules run on it. React has to stay within R3F 9's peer range (19.0 to 19.3), and `@types/node` follows the Node in use (24). After that, `npm outdated` should list only `@types/node`.
