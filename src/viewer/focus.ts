import { residueKey, type Atom } from '../pdb/mmcif.ts'
import { neighbourGrid } from '../pdb/neighbours.ts'
import type { Focus } from '../store.ts'

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

// The key a picked focus compares atoms by: the picked atom's residue for the picked residue, or its chain for the
// picked chain. It's null for the other choices and without a pick, so that a pick changes the splats only when a
// picked focus shows it. It names no model, so the picked residue or chain stays in focus in every model shown
export function pickedKey(focus: Focus, picked: Atom | null): string | null {
  if (!picked) return null
  if (focus === 'residue') return residueKey(picked)
  if (focus === 'chain') return picked.chain
  return null
}

// A test for whether an atom of the entry is in focus, or null when every atom is. The backbone and the ligands are
// found within each atom's own model. A picked focus takes its key from pickedKey, and without one keeps every atom
export function focusTest(
  entry: readonly Atom[],
  focus: Focus,
  picked: string | null,
): ((atom: Atom) => boolean) | null {
  if (focus === 'backbone') {
    const nucleotides = nucleotideResidues(entry)
    return (atom) =>
      atom.polymer &&
      (proteinBackbone.has(atom.atomName) ||
        (nucleicBackbone.has(atom.atomName) && (nucleotides.get(atom.model)?.has(residueKey(atom)) ?? false)))
  }
  if (focus === 'ligands') {
    // A model without ligands keeps all its atoms in focus, as an entry without any does
    const site = bindingSite(entry)
    return (
      site &&
      ((atom) => {
        const residues = site.get(atom.model)
        return !residues || residues.has(residueKey(atom))
      })
    )
  }
  if (picked === null) return null
  if (focus === 'residue') return (atom) => residueKey(atom) === picked
  if (focus === 'chain') return (atom) => atom.chain === picked
  return null
}

// Each model's atoms in their first conformations, which a residue's alternates share its focus with
function firstConformations(entry: readonly Atom[]) {
  const models = new Map<number, Atom[]>()
  for (const atom of entry) {
    if (!atom.firstConformation) continue
    const model = models.get(atom.model)
    if (model) model.push(atom)
    else models.set(atom.model, [atom])
  }
  return models
}

// Each entry's nucleotides, kept beside its atoms, which are never changed
const nucleotideSets = new WeakMap<readonly Atom[], Map<number, Set<string>>>()

// For each model, the residue keys of its polymer residues that have the sugar atom a base joins, so that a
// phosphorylated amino acid's side-chain phosphorus isn't taken for a nucleic acid's backbone
function nucleotideResidues(entry: readonly Atom[]) {
  let models = nucleotideSets.get(entry)
  if (!models) {
    models = new Map()
    for (const [model, atoms] of firstConformations(entry)) {
      const residues = new Set<string>()
      for (const atom of atoms) if (atom.polymer && atom.atomName === nucleotideAtom) residues.add(residueKey(atom))
      models.set(model, residues)
    }
    nucleotideSets.set(entry, models)
  }
  return models
}

// Each entry's binding sites, kept beside its atoms, which are never changed
const bindingSites = new WeakMap<readonly Atom[], Map<number, Set<string>> | null>()

// For each model with ligands, the residue keys of its ligands, its residues outside polymer chains other than waters,
// and of every residue with an atom within the binding distance of one of theirs, all in their first conformations;
// or null for an entry without ligands
export function bindingSite(entry: readonly Atom[]) {
  let site = bindingSites.get(entry)
  if (site === undefined) {
    const models = new Map<number, Set<string>>()
    for (const [model, atoms] of firstConformations(entry)) {
      const ligands = atoms.filter((atom) => !atom.polymer && !atom.water)
      if (ligands.length === 0) continue
      const residues = atoms.map(residueKey)
      const keys = new Set<string>()
      const grid = neighbourGrid(atoms, bindingDistance)
      for (const ligand of ligands) {
        grid.forEachWithin(ligand.x, ligand.y, ligand.z, (index) => keys.add(residues[index]))
      }
      models.set(model, keys)
    }
    site = models.size > 0 ? models : null
    bindingSites.set(entry, site)
  }
  return site
}
