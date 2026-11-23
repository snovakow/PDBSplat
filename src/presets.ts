import { optionKeys, type EntryHolds, type ViewOptions } from './options.ts'
import { optionShows } from './shownOptions.ts'

// The panel's presets: looks set together, each chosen by eye on haemoglobin, the entry the page opens on, and checked
// on the antibody, crambin and the DNA. A preset sets every option of the look, so that it shows the same whatever was
// set before. It leaves as they are the options that choose which atoms are shown, as what's shown is the entry's to
// say, and Spin, which moves the view without changing how anything is drawn. The page opens on one of them, as the
// defaults are its options

export interface Preset {
  // Its name in the panel's Preset list
  name: string
  options: ViewOptions
}

// What each preset starts from: every effect off, with the settings that matter only while an effect is on, Bloom's
// radius and threshold and AO's radius, at those the opening look tuned. The options that choose the atoms shown, and
// Spin, are here only to make a whole set, as a preset never applies them
const plain: ViewOptions = {
  style: 'soft',
  resolution: 2,
  scale: 1,
  opacity: 0.9,
  backShell: false,
  hardness: 0,
  shading: 0.75,
  highlight: 0.35,
  shininess: 24,
  outline: 0,
  blend: 'normal',
  detail: 'auto',
  colorBy: 'element',
  burial: 0,
  hydrogens: true,
  waters: false,
  models: 'first',
  conformations: 'first',
  thermal: 0,
  ellipsoids: false,
  focus: 'all',
  fade: 0.15,
  spin: true,
  depthCue: 0,
  clip: 0,
  bloom: 0,
  bloomRadius: 0.25,
  bloomThreshold: 0.8,
  ao: 0,
  aoRadius: 4,
}

// In the panel's order: the opening look and the other solid ones, glass, the residues' blobs, then the beads and the
// lights. The looks drawn in small points set Detail to the atoms, since under auto a large entry, whose atoms are only
// a pixel or two across at its framing, would draw its residues' blobs in their place
export const presets: readonly Preset[] = [
  // The opening look: solid, glossy spheres in their chains' colours, their buried atoms and the far side in shadow,
  // ambient occlusion in their contacts, and a glow around their brightest highlights
  {
    name: 'glossy',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 1,
      highlight: 0.7,
      shininess: 40,
      colorBy: 'chain',
      burial: 0.5,
      depthCue: 0.85,
      bloom: 1,
      ao: 1,
    },
  },
  // Flat colours inked at the rim, as in an illustration, with the contacts and the far side in shadow
  {
    name: 'ink',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 1,
      shading: 0.25,
      highlight: 0,
      outline: 0.1,
      colorBy: 'chain',
      burial: 0.3,
      depthCue: 0.6,
      ao: 1,
    },
  },
  // The surface, softly lit, its grooves shaded by burial and a wide ambient occlusion
  {
    name: 'clay',
    options: {
      ...plain,
      style: 'surface',
      opacity: 1,
      colorBy: 'chain',
      burial: 0.5,
      depthCue: 0.7,
      ao: 1,
      aoRadius: 6,
    },
  },
  // Each atom coloured by its B-factor and swollen by it, so that the mobile loops bulge red around a still, blue core
  {
    name: 'heat',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 1,
      highlight: 0.5,
      shininess: 32,
      colorBy: 'bfactor',
      thermal: 1,
      depthCue: 0.7,
      ao: 1,
    },
  },
  // See-through spheres with their far side drawn under the near, two layers of glass, with bright, tight highlights
  {
    name: 'glass',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 0.3,
      backShell: true,
      highlight: 0.9,
      shininess: 56,
      colorBy: 'chain',
      depthCue: 0.5,
      bloom: 0.9,
      bloomRadius: 0.3,
      bloomThreshold: 0.72,
    },
  },
  // One glossy, solid blob per residue, each the merged shape of its atoms, with the contacts between them in shadow
  {
    name: 'jelly beans',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 1,
      highlight: 0.7,
      shininess: 40,
      detail: 'residues',
      colorBy: 'chain',
      burial: 0.4,
      depthCue: 0.7,
      bloom: 1,
      ao: 1,
    },
  },
  // Small glossy spheres, a cloud of beads that fades into the dark behind it
  {
    name: 'pearls',
    options: {
      ...plain,
      style: 'spheres',
      scale: 0.45,
      opacity: 1,
      highlight: 0.9,
      shininess: 64,
      detail: 'atoms',
      colorBy: 'chain',
      depthCue: 0.9,
      bloom: 1.2,
      bloomRadius: 0.3,
      bloomThreshold: 0.75,
      ao: 0.6,
      aoRadius: 3,
    },
  },
  // The backbone alone, the rest hidden, as glossy solid beads coloured along each chain, so that its helices and
  // strands show, with the contacts between them in shadow
  {
    name: 'necklace',
    options: {
      ...plain,
      style: 'spheres',
      opacity: 1,
      highlight: 0.7,
      shininess: 40,
      colorBy: 'rainbow',
      focus: 'backbone',
      fade: 0,
      depthCue: 0.7,
      bloom: 1,
      bloomThreshold: 0.75,
      ao: 1,
    },
  },
  // The backbone as small, glowing lights coloured along each chain
  {
    name: 'fairy lights',
    options: {
      ...plain,
      scale: 0.4,
      opacity: 0.7,
      blend: 'glow',
      detail: 'atoms',
      colorBy: 'rainbow',
      focus: 'backbone',
      fade: 0,
      depthCue: 0.7,
      bloom: 1.2,
      bloomRadius: 0.3,
      bloomThreshold: 0.6,
    },
  },
  // Every atom a point of light in its B-factor's colour: a blue core, with white and red stars towards its edges
  {
    name: 'galaxy',
    options: {
      ...plain,
      scale: 0.25,
      opacity: 1,
      blend: 'glow',
      detail: 'atoms',
      colorBy: 'bfactor',
      depthCue: 0.7,
      bloom: 2,
      bloomRadius: 0.4,
      bloomThreshold: 0.5,
    },
  },
]

// The options with a preset chosen: its look, with Hydrogens, Waters, Models, Alternates and Spin as they were, as the
// first four choose the atoms shown and Spin moves the view, rather than any of them setting how the atoms are drawn
export function withPreset(
  { hydrogens, waters, models, conformations, spin }: ViewOptions,
  preset: Preset,
): ViewOptions {
  return { ...preset.options, hydrogens, waters, models, conformations, spin }
}

// The preset whose look the options have, or undefined once a control of the look has moved from every preset's. A
// look is what its controls show for the entry, as the panel shows them: an option whose control the look hides
// changes nothing that's drawn, so it may hold anything. Which controls show can turn on the entry, as Alternates left
// on all makes a see-through layer only in an entry that has alternates
export function presetOf(options: ViewOptions, entry: EntryHolds) {
  return presets.find((preset) => {
    const look = withPreset(options, preset)
    return optionKeys.every((key) => look[key] === options[key] || !optionShows(key, look, entry))
  })
}

// What the Preset list reads once the options are no preset's
export const customLook = 'custom'

const presetNames = presets.map((preset) => preset.name)
const namesWithCustom = [...presetNames, customLook]

// The Preset list for a set of options and what the entry holds: what it reads, and what it lists, which is each
// preset by its name, and custom only while that's what it reads, as choosing custom would set nothing. Each of the
// two lists is the same array every time
export function presetList(options: ViewOptions, entry: EntryHolds) {
  const name = presetOf(options, entry)?.name
  return name === undefined ? { reads: customLook, names: namesWithCustom } : { reads: name, names: presetNames }
}
