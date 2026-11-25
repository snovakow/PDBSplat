import { neighbourGrid } from '../pdb/neighbours.ts'
import {
  chainOf,
  firstConformationFlag,
  insertionOf,
  polymerFlag,
  waterFlag,
  type Structure,
} from '../pdb/structure.ts'
import type { Focus } from '../options.ts'

// Which atoms a Focus keeps, so the splat styles can fade the rest

// A residue with an atom this close to a ligand's, in ångströms, belongs to its binding site
const bindingDistance = 5

// The backbone's atoms by name: a protein's main chain, and a nucleic acid's sugar-phosphate chain. mmCIF writes the
// sugar's primes as ASCII apostrophes
const proteinBackbone = new Set(['N', 'CA', 'C', 'O', 'OXT'])
const nucleicBackbone = new Set([
  'P', 'OP1', 'OP2', 'OP3', "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "O2'", "C1'",
])

// The sugar atom that joins a nucleotide's base to its backbone, which no amino acid has
const nucleotideAtom = "C1'"

// The key a picked focus takes: the row of the picked atom's residue for the picked residue, or of its chain for the
// picked chain, which focusTest matches atoms to by name. It's null for the other choices and without a pick, so that
// a pick changes the splats only when a picked focus shows it
export function pickedKey(structure: Structure, focus: Focus, picked: number | null): number | null {
  if (picked === null) return null
  if (focus === 'residue') return structure.atoms.residue[picked]
  if (focus === 'chain') return chainOf(structure, picked)
  return null
}

// A test for whether an atom of the structure, by its row, is in focus, or null when every atom is. The backbone and
// the ligands are found within each atom's own model. A picked focus takes its key from pickedKey, and without one
// keeps every atom. The picked residue and chain are matched by name, which names no model, so that they stay in
// focus in every model shown
export function focusTest(structure: Structure, focus: Focus, picked: number | null): ((atom: number) => boolean) | null {
  const { atoms, residues, chains } = structure
  if (focus === 'backbone') {
    const nucleotides = nucleotideResidues(structure)
    const protein = structure.atomNames.map((name) => proteinBackbone.has(name))
    const nucleic = structure.atomNames.map((name) => nucleicBackbone.has(name))
    return (atom) => {
      const name = atoms.name[atom]
      return (
        (atoms.flags[atom] & polymerFlag) !== 0 &&
        (protein[name] || (nucleic[name] && nucleotides[atoms.residue[atom]] === 1))
      )
    }
  }
  if (focus === 'ligands') {
    // A model without ligands keeps all its atoms in focus, as an entry without any does
    const site = bindingSite(structure)
    return site && ((atom) => site[atoms.residue[atom]] === 1)
  }
  if (picked === null) return null
  if (focus === 'residue') {
    const name = chains.name[structure.runs.chain[residues.run[picked]]]
    const number = residues.number[picked]
    const insertion = insertionOf(structure, picked)
    const kept = new Uint8Array(residues.count)
    for (let residue = 0; residue < residues.count; residue++) {
      kept[residue] = Number(
        residues.number[residue] === number &&
          chains.name[structure.runs.chain[residues.run[residue]]] === name &&
          insertionOf(structure, residue) === insertion,
      )
    }
    return (atom) => kept[atoms.residue[atom]] === 1
  }
  if (focus === 'chain') {
    const name = chains.name[picked]
    const kept = chains.name.map((chain) => chain === name)
    return (atom) => kept[chainOf(structure, atom)]
  }
  return null
}

// Each entry's nucleotides, kept beside its tables, which are never changed
const nucleotideSets = new WeakMap<Structure, Uint8Array>()

// Whether each residue, by its row, is a polymer residue with the sugar atom a base joins in its first conformation, so
// that a phosphorylated amino acid's side-chain phosphorus isn't taken for a nucleic acid's backbone
function nucleotideResidues(structure: Structure) {
  let residues = nucleotideSets.get(structure)
  if (!residues) {
    const { atoms } = structure
    const sugar = structure.atomNames.indexOf(nucleotideAtom)
    residues = new Uint8Array(structure.residues.count)
    const polymer = polymerFlag | firstConformationFlag
    for (let atom = 0; atom < atoms.count; atom++) {
      if (atoms.name[atom] === sugar && (atoms.flags[atom] & polymer) === polymer) residues[atoms.residue[atom]] = 1
    }
    nucleotideSets.set(structure, residues)
  }
  return residues
}

// Whether an atom is a ligand's: of a residue outside the polymer chains, other than a water
function isLigand(flags: number) {
  return (flags & (polymerFlag | waterFlag)) === 0
}

// Whether an entry has ligands, in any of its models, for the ligands' Focus to keep. One without has no binding site
export function hasLigands(structure: Structure) {
  return structure.tallies.ligands > 0
}

// Each entry's binding sites, kept beside its tables, which are never changed
const bindingSites = new WeakMap<Structure, Uint8Array | null>()

// Whether each residue, by its row, is kept by the ligands' Focus: in a model with ligands, the ligands, its residues
// outside polymer chains other than waters, and every residue with an atom within the binding distance of one of
// theirs, all in their first conformations; and every residue of a model without ligands. Null for an entry without
// ligands
export function bindingSite(structure: Structure) {
  let site = bindingSites.get(structure)
  if (site === undefined) {
    const { atoms, residues, chains, models } = structure
    const { flags, positions } = atoms
    // Each model's atoms in their first conformations, which a residue's alternates share its focus with
    const modelAtoms: number[][] = models.map(() => [])
    const chainModels = chains.model.map((model) => models.indexOf(model))
    for (let atom = 0; atom < atoms.count; atom++) {
      if ((flags[atom] & firstConformationFlag) !== 0) modelAtoms[chainModels[chainOf(structure, atom)]].push(atom)
    }
    const kept = new Uint8Array(residues.count)
    const withLigands = modelAtoms.map((members) => {
      const ligands = members.filter((atom) => isLigand(flags[atom]))
      if (ligands.length === 0) return false
      const grid = neighbourGrid(positions, bindingDistance, members)
      for (const ligand of ligands) {
        grid.forEachWithin(positions[ligand * 3], positions[ligand * 3 + 1], positions[ligand * 3 + 2], (atom) => {
          kept[atoms.residue[atom]] = 1
        })
      }
      return true
    })
    if (withLigands.some(Boolean)) {
      for (let residue = 0; residue < residues.count; residue++) {
        if (!withLigands[chainModels[structure.runs.chain[residues.run[residue]]]]) kept[residue] = 1
      }
      site = kept
    } else {
      site = null
    }
    bindingSites.set(structure, site)
  }
  return site
}
