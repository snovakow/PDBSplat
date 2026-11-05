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
// picked focus shows it
export function pickedKey(focus: Focus, picked: Atom | null): string | null {
  if (!picked) return null
  if (focus === 'residue') return residueKey(picked)
  if (focus === 'chain') return picked.chain
  return null
}

// A test for whether an atom of the entry is in focus, or null when every atom is. A picked focus takes its key from
// pickedKey, and without one keeps every atom
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
        (nucleicBackbone.has(atom.atomName) && nucleotides.has(residueKey(atom))))
  }
  if (focus === 'ligands') {
    const site = bindingSite(entry)
    return site && ((atom) => site.has(residueKey(atom)))
  }
  if (picked === null) return null
  if (focus === 'residue') return (atom) => residueKey(atom) === picked
  if (focus === 'chain') return (atom) => atom.chain === picked
  return null
}

// Each entry's nucleotides, kept beside its atoms, which are never changed
const nucleotideSets = new WeakMap<readonly Atom[], Set<string>>()

// The residue keys of the entry's polymer residues that have the sugar atom a base joins, so that a phosphorylated
// amino acid's side-chain phosphorus isn't taken for a nucleic acid's backbone
function nucleotideResidues(entry: readonly Atom[]) {
  let residues = nucleotideSets.get(entry)
  if (!residues) {
    residues = new Set()
    for (const atom of entry) if (atom.polymer && atom.atomName === nucleotideAtom) residues.add(residueKey(atom))
    nucleotideSets.set(entry, residues)
  }
  return residues
}

// Each entry's binding site, kept beside its atoms, which are never changed
const bindingSites = new WeakMap<readonly Atom[], Set<string> | null>()

// The residue keys of the entry's ligands, its residues outside polymer chains other than waters, and of every residue
// with an atom within the binding distance of one of theirs, or null for an entry without ligands
export function bindingSite(entry: readonly Atom[]) {
  let site = bindingSites.get(entry)
  if (site === undefined) {
    const ligands = entry.filter((atom) => !atom.polymer && !atom.water)
    if (ligands.length === 0) site = null
    else {
      const residues = entry.map(residueKey)
      const keys = new Set<string>()
      const grid = neighbourGrid(entry, bindingDistance)
      for (const ligand of ligands) {
        grid.forEachWithin(ligand.x, ligand.y, ligand.z, (index) => keys.add(residues[index]))
      }
      site = keys
    }
    bindingSites.set(entry, site)
  }
  return site
}
