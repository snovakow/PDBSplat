# PDBSplat

**TypeScript + React + three.js + React Three Fiber + Vite + WebGPU**

PDBSplat renders proteins from the [Protein Data Bank](https://www.rcsb.org) as Gaussian splats, in the browser. Each atom becomes a soft blob of colour at its place in the structure, so a protein reads as a cloud of matter rather than as balls and sticks. The splats are drawn by three.js's own WebGPU-based Gaussian splat rendering.

**Live demo: [snovakow.com/pdbsplat](https://snovakow.com/pdbsplat/)**

## What it shows

The page opens on 1CRN, crambin, a small plant protein of 327 atoms. The panel lists five more examples, from small to large: 1BNA, a short stretch of DNA; 1EJG, crambin again with its hydrogens; 1D3Z, ubiquitin as solved by NMR; 4HHB, human haemoglobin; and 1IGT, an intact mouse antibody of almost 13,000 atoms, four protein chains in a Y. Any other entry loads by its four-character PDB ID. You can find more by searching [rcsb.org](https://www.rcsb.org).

Each atom is one round splat, sized by its element's van der Waals radius and coloured in its element's CPK colour: carbon grey, nitrogen blue, oxygen red, sulphur yellow, phosphorus and iron orange. Where an entry holds several models, as NMR structures do, PDBSplat shows the first, and where an atom has alternate positions, it shows the first of them. Each entry is centred and framed to fit the window as it loads.

## Controls

- **Drag** to orbit the structure, **scroll** or pinch to zoom, and **right-drag** or drag with two fingers to pan.
- The **panel** at the top right:
  - **Example** loads one of the six examples.
  - **PDB ID** and **Load** fetch any other entry.
  - **Colour by** switches between each atom's element and its chain, which gives every chain its own hue.
  - **Style** draws soft Gaussian splats, or hard-edged ones shaded as spheres, which at full size make a space-filling model, or a surface: a smooth molecular surface meshed by marching cubes.
  - **Resolution**, for the surface only, sets how finely it's meshed, in grid points per ångström: from 0.5 to 4, where higher shows more detail, and takes longer. Large entries are meshed more coarsely where needed, to keep within about ten million triangles.
  - **Size** scales every atom, and **Opacity** sets how much they let through, in every style.
  - **Hydrogens** and **Waters** show or hide those atoms. Hydrogens start shown and waters hidden.
  - **Use WebGL 2** switches to the WebGL 2 fallback described below, and **Renderer** says which one is drawing.
  - **Entry**, **Atoms shown** and **Status** report the entry's ID and title, how many atoms are drawn, and whether it's loading or why a load failed.
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

PDBSplat loads and draws any entry in the Protein Data Bank, with the controls above. The ideas below are where it may go next, along with more colourings, naming the atom under the pointer, and playing an NMR entry's models as an animation.

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
