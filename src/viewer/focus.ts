import { neighbourGrid } from '../pdb/neighbours.ts'
import {
  chainOf,
  firstConformationFlag,
  insertionOf,
  polymerFlag,
  waterFlag,
  type Arrival,
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

// Each entry's nucleotides, kept beside its tables, which are never changed, and those of the entry arriving, kept as
// its atoms come in a column with room to grow: how many atoms they're found among so far
const nucleotideSets = new WeakMap<Structure, Uint8Array>()
let arrivingNucleotides: { arrival: Arrival; atoms: number; residues: Uint8Array } | null = null

// How much room the nucleotides of an entry arriving grow by once their column is full
const nucleotideGrowth = 1.5

// Marks the nucleotides among the atoms from one row up to another
function markNucleotides(structure: Structure, residues: Uint8Array, from: number, to: number) {
  const { atoms } = structure
  const sugar = structure.atomNames.indexOf(nucleotideAtom)
  const polymer = polymerFlag | firstConformationFlag
  for (let atom = from; atom < to; atom++) {
    if (atoms.name[atom] === sugar && (atoms.flags[atom] & polymer) === polymer) residues[atoms.residue[atom]] = 1
  }
}

// Whether each residue, by its row, is a polymer residue with the sugar atom a base joins in its first conformation, so
// that a phosphorylated amino acid's side-chain phosphorus isn't taken for a nucleic acid's backbone. A residue's atoms
// arrive together, so an entry arriving has its later atoms' residues marked as they come
function nucleotideResidues(structure: Structure) {
  const { arrival } = structure
  if (!arrival) {
    let residues = nucleotideSets.get(structure)
    if (!residues) {
      residues = new Uint8Array(structure.residues.count)
      markNucleotides(structure, residues, 0, structure.atoms.count)
      nucleotideSets.set(structure, residues)
    }
    return residues
  }
  let arriving = arrivingNucleotides
  if (!arriving || arriving.arrival !== arrival || arriving.atoms > structure.atoms.count) {
    arriving = { arrival, atoms: 0, residues: new Uint8Array(0) }
  }
  const count = structure.residues.count
  if (arriving.residues.length < count) {
    const grown = new Uint8Array(Math.max(count, Math.ceil(arriving.residues.length * nucleotideGrowth)))
    grown.set(arriving.residues)
    arriving.residues = grown
  }
  markNucleotides(structure, arriving.residues, arriving.atoms, structure.atoms.count)
  arriving.atoms = structure.atoms.count
  arrivingNucleotides = arriving
  return arriving.residues.subarray(0, count)
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
// ligands, and for one still arriving, whose ligands may have neighbours yet to come, so that it keeps every atom
// until it's all there
export function bindingSite(structure: Structure) {
  if (!structure.whole) return null
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
