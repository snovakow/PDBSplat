# PDBSplat

**TypeScript + React + three.js + React Three Fiber + Vite + WebGPU**

PDBSplat renders proteins from the [Protein Data Bank](https://www.rcsb.org) as Gaussian splats, in the browser. Each atom becomes a soft blob of colour at its place in the structure, so a protein reads as a cloud of matter rather than as balls and sticks. The splats are drawn by three.js's own WebGPU-based Gaussian splat rendering.

**Live demo: [snovakow.com/pdbsplat](https://snovakow.com/pdbsplat/)**

## What it shows

The page opens on 1CRN, crambin, a small plant protein of 327 atoms. The panel lists five more examples, from small to large: 1BNA, a short stretch of DNA; 1EJG, crambin again with its hydrogens, alternate conformations and the directions each atom moves in; 1D3Z, ubiquitin as solved by NMR, in several models; 4HHB, human haemoglobin; and 1IGT, an intact mouse antibody of almost 13,000 atoms, four protein chains in a Y. Any other entry loads by its four-character PDB ID. You can find more by searching [rcsb.org](https://www.rcsb.org).

Each atom is one round splat, sized by its element's van der Waals radius and coloured in its element's CPK colour: carbon grey, nitrogen blue, oxygen red, sulphur yellow, phosphorus and iron orange. Where an entry holds several models, as NMR structures do, PDBSplat starts on the first, and where residues have alternate conformations, on the first of each; **Models** and **Alternates** in the panel show the rest. Each entry is centred and framed to fit the window as it loads, on the atoms it starts with, so showing more of them never moves it.

## Controls

- **Drag** to orbit the structure, **scroll** or pinch to zoom, and **right-drag** or drag with two fingers to pan.
- **Point** at an atom, in any style, and a label beside the pointer names it: its atom name and element, and its alternate conformation if it has one; its residue, with any insertion code, its chain, and its model in an entry with several; its B-factor, and its occupancy when the atom is only partly there. The label hides while you drag.
- **Click** or tap an atom to pick it, and click empty space to let it go. Even a faint atom can be picked, but not one that Focus has faded far out.
- The **panel** at the top right. Its folders hide the controls the chosen style doesn't use:
  - **Example** loads one of the six examples, and **PDB ID** and **Load** fetch any other entry.
  - **Look:**
    - **Style** draws soft Gaussian splats, or hard-edged ones shaded as spheres, which at full size make a space-filling model, or a surface: a smooth molecular surface meshed by marching cubes.
    - **Resolution**, for the surface only, sets how finely it's meshed, in grid points per ångström: from 0.5 to 4, where higher shows more detail, and takes longer. Large entries are meshed more coarsely where needed, to keep within about ten million triangles.
    - **Size** scales every atom, and **Opacity** sets how much they let through, in every style. At full Opacity the spheres turn solid: each hides what's behind it, and spheres that meet cut into one another along curved creases, as in a space-filling model. They stay solid while every atom is drawn whole and round: in normal Blend, with Focus on all or Fade at full, Models and Alternates on first, and Ellipsoids off.
    - **Hardness**, for the soft splats, firms their edges, from a soft Gaussian falloff to a flat disc.
    - **Shading**, **Highlight**, **Shininess** and **Outline**, for the spheres, set how far each darkens towards its rim, how bright and how tight its highlight is, and the width of an inked rim that outlines it.
    - **Blend**, for the soft splats and the spheres, lays each splat over what's behind it, or, in glow, adds its light to it, so dense parts glow like an X-ray, with **Opacity** setting how brightly.
  - **Colour:**
    - **Colour by** colours each atom by one of five things, in every style:
      - its **element**, as described above
      - its **chain**, which gives every chain its own hue
      - its **B-factor**, which says how far the atom moves about its place: blue for the entry's stillest atoms, through white, to red for its most mobile, so a protein's ordered core reads blue and its loose loops red
      - a **rainbow** along each chain, from blue at its start to red at its end, while ligands and waters keep their element colours
      - its secondary **structure**, in Jmol's colours: helices pink, strands yellow and turns blue, DNA purple and RNA red outside those, and the rest of a chain white, while ligands and waters keep their element colours
    - **Burial** darkens each atom by how deeply the atoms around it bury it, in every style, so a protein's core falls into shadow while its surface stays bright.
  - **Atoms:**
    - **Hydrogens** and **Waters** show or hide those atoms. Hydrogens start shown and waters hidden.
    - **Models**, in every style, shows an entry's first model, or all its models at once, or plays them in turn as an animation. An NMR entry has several, and most other entries one. With all of them shown, the soft splats and the spheres draw each model fainter, so that where the models disagree reads as a cloud, while the surface meshes them together into one.
    - **Alternates**, in every style, shows only the first conformation of each residue the structure records in more than one position, or every one of them. The soft splats and the spheres draw each alternate atom as faint as its occupancy, the share of the time it spends there, while the surface meshes them all together.
    - **Thermal**, for the soft splats and the spheres, blurs or swells each atom by how far its B-factor says it moves, so mobile loops spread out while the core stays crisp.
    - **Ellipsoids**, for the soft splats and the spheres, draws each atom as its thermal ellipsoid in place of its van der Waals size: the region it spends half its time in. Where the entry records how far each atom moves in each direction, as very high-resolution crystal structures do, the ellipsoid stretches along the way the atom moves most; elsewhere it's a round one, sized by the B-factor. **Size** scales the ellipsoids, and **Thermal** steps aside while they're shown.
    - **Focus**, for the soft splats and the spheres, keeps every atom in focus, or only the ligands and the residues that hold them, or only the backbone: a protein's main chain, or a nucleic acid's sugars and phosphates, or only the picked atom's residue or its whole chain. **Fade** sets how faintly the atoms out of focus are drawn.
  - **Scene:**
    - **Depth cue** darkens the far side of the structure, in every style, so its depth reads at a glance. It stays tied to the structure as you orbit, zoom or pan.
    - **Clip** cuts away the near part of the structure, in every style, to show its inside: halfway along, the front half is gone. The cut faces you whichever way you orbit. The splat styles lose whole atoms, while the surface shows where it's cut.
    - **Bloom** spreads a soft glow around the bright parts of the scene, in every style. While it's on, **Radius** and **Threshold** below it set how far the glow spreads and how bright a part must be to give off any.
    - **AO**, for the spheres and the surface, adds ambient occlusion: it shades the contacts between atoms and the grooves of the surface, where light from all around is partly blocked. It reads the depth of what's in view, so it works only while everything drawn is opaque: the solid spheres, or the surface at full Opacity. Below that it stops. While it's on, **AO radius** below it sets how far around each point it looks for what shades it, in ångströms.
  - **Info:** **Use WebGL 2** switches to the WebGL 2 fallback described below, and **Renderer** says which one is drawing. **Entry**, **Atoms shown**, **Picked** and **Status** report the entry's ID and title, how many atoms are drawn, the picked atom, and whether it's loading or why a load failed.
- Every slider but **Size**, **Resolution**, **Thermal**, **Fade** and **Burial** takes effect at once, as it doesn't rebuild the atoms. **Opacity** rebuilds the spheres only as it reaches full or leaves it.
- The counter at the top left shows the frame rate.

PDBSplat renders with WebGPU where the browser offers it. Elsewhere, and on GPUs known to fail with it, it uses three.js's WebGL 2 fallback, which sorts the splats on the CPU and so runs slower on large entries. **Use WebGL 2** in the panel forces the fallback, and adding `?webgl` to the page's address starts with it on.

## Running it locally

You'll need [Node.js](https://nodejs.org) 22.12 or later, which Vite 8 and drei's camera controls require. Then, from the repository's folder:

```sh
npm install
npm run dev
```

and open the address it prints.

To build it, run `npm run build`. It makes a static site in `dist/` that works from any folder on any web server, and `npm run preview` serves it locally.

## Status

PDBSplat loads and draws any entry in the Protein Data Bank, with the controls above, which colour it by B-factor, along each chain and by secondary structure, and play an NMR entry's models as an animation. The ideas below are where it may go next.

## Stack

| | |
| --- | --- |
| [TypeScript](https://www.typescriptlang.org) | Strict types across the whole app |
| [React](https://react.dev) | Components and state for the viewer and its panels |
| [three.js](https://threejs.org) | Rendering, including its built-in Gaussian splats |
| [React Three Fiber](https://r3f.docs.pmnd.rs) | The three.js scene, written as React components |
| [Vite](https://vite.dev) | The dev server and the production build |
| [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) | The GPU API three.js renders with, falling back to WebGL 2 in browsers without it or on GPUs where it fails |

Around them are drei's helpers, a leva control panel, zustand for app state, and Oxlint for linting.

## Ideas

- **The starting point**: splats generated from data rather than captured from photos, in the spirit of this [procedural splats example](https://sparkjs.dev/examples/#procedural-splats).
- **Beyond proteins**: [The Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html), and meshes turned into volumes, both rendered as splats.

## Workflow

- **Planned in phases.** The project was set up by following a written plan. Each phase was one focused thread, and the phases that changed code ended with lint and a type-checked production build passing.
- **Reviewed before it's committed.** Every batch of work goes through `/commit`, a [Claude Code skill](.claude/skills/commit/SKILL.md) that serves as the final code review. It's adapted from a shared [baseline](https://github.com/snovakow/Claude-Skills/tree/main/skills/commit), and it runs in a fresh thread, so the review starts without the author's assumptions. It reads every changed line for bugs, React Three Fiber and three.js pitfalls, type and lint escapes, new dependencies, leftovers and anything that shouldn't be public. Then it runs the checks, splits the work into focused commits with descriptive messages, and keeps this README accurate.
- **Versioned checkpoints.** Versions start at 0.0.0 and count up: each reviewed batch ends with a version commit, which marks where the next review starts.
- **Current dependencies.** Packages and tools track their latest releases, and each review reports anything that has fallen behind.
- **Branches and deploys.** Work lands on `development` and reaches `main` by merge. The live site is a static build of `main`.

## Credits

- Protein structures come from the [RCSB Protein Data Bank](https://www.rcsb.org).
- [three.js](https://threejs.org), whose Gaussian splat rendering draws them, and whose copy of Paul Bourke's marching-cubes tables meshes the surface.
- The element colours are [Jmol's](https://jmol.sourceforge.net/jscolors/) CPK palette, and the van der Waals radii are mostly A. Bondi's (J. Phys. Chem., 1964).
