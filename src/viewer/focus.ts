import { residueKey, type Atom } from '../pdb/mmcif.ts'
import { neighbourGrid } from '../pdb/neighbours.ts'
import type { Focus } from '../store.ts'

// Which atoms a Focus keeps, so the splat styles can fade the rest

// A residue with an atom this close to a ligand's, in ångströms, belongs to its binding site
const bindingDistance = 5

// The backbone's atoms by name: a protein's, then a nucleic acid's sugar-phosphate chain. mmCIF writes the sugar's
// primes as ASCII apostrophes
const backboneNames = new Set([
  'N', 'CA', 'C', 'O', 'OXT',
  'P', 'OP1', 'OP2', 'OP3', "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "O2'", "C1'",
])

// A test for whether an atom of the entry is in focus, or null when every atom is
export function focusTest(entry: readonly Atom[], focus: Focus): ((atom: Atom) => boolean) | null {
  if (focus === 'backbone') return (atom) => atom.polymer && backboneNames.has(atom.atomName)
  if (focus === 'ligands') {
    const site = bindingSite(entry)
    return site && ((atom) => site.has(residueKey(atom)))
  }
  return null
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
