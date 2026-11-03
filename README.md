# PDBSplat

**TypeScript + React + three.js + React Three Fiber + Vite + WebGPU**

PDBSplat is a browser app, now being set up, for rendering proteins from the [Protein Data Bank](https://www.rcsb.org) as Gaussian splats. Each atom becomes a soft blob of colour at its place in the structure, so a protein reads as a cloud of matter rather than as balls and sticks. The splats are drawn by three.js's own WebGPU-based Gaussian splat rendering.

## Status

The project is scaffolded from Vite's React template, with its stack installed, but there's nothing of its own to run yet. The [setup plan](docs/setup-plan.md) lays out the steps, from tooling to the first protein on screen.

## Stack

| | |
| --- | --- |
| [TypeScript](https://www.typescriptlang.org) | Strict types across the whole app |
| [React](https://react.dev) | Components and state for the viewer and its panels |
| [three.js](https://threejs.org) | Rendering, including its built-in Gaussian splats |
| [React Three Fiber](https://r3f.docs.pmnd.rs) | The three.js scene, written as React components |
| [Vite](https://vite.dev) | The dev server and the production build |
| [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) | The GPU API three.js renders with, falling back to WebGL 2 in browsers without it |

Around them are drei's helpers, a leva control panel, zustand for app state, and Oxlint for linting.

## Ideas

- **The starting point**: splats generated from data rather than captured from photos, in the spirit of this [procedural splats example](https://sparkjs.dev/examples/#procedural-splats).
- **Beyond proteins**: [The Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html), and meshes turned into volumes, both rendered as splats.

## Workflow

- **Planned in phases.** The project is set up by following a [written plan](docs/setup-plan.md). Each phase is one focused thread, and the phases that change code end with lint and a type-checked production build passing.
- **Reviewed before it's committed.** Every batch of work goes through `/commit`, a [Claude Code skill](.claude/skills/commit/SKILL.md) that serves as the final code review. It's adapted from a shared [baseline](https://github.com/snovakow/Claude-Skills/tree/main/skills/commit), and it runs in a fresh thread, so the review starts without the author's assumptions. It reads every changed line for bugs, React Three Fiber and three.js pitfalls, type and lint escapes, new dependencies, leftovers and anything that shouldn't be public. Then it runs the checks, splits the work into focused commits with descriptive messages, and keeps this README accurate.
- **Versioned checkpoints.** Versions start at 0.0.0 and count up: each reviewed batch ends with a version commit, which marks where the next review starts.
- **Current dependencies.** Packages and tools track their latest releases, and each review reports anything that has fallen behind.
- **Branches and deploys.** Work lands on `development` and reaches `main` by merge. The live site will be a static build of `main`.

## Credits

- Protein structures come from the [RCSB Protein Data Bank](https://www.rcsb.org).
- [three.js](https://threejs.org), whose Gaussian splat rendering draws them.
