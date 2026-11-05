import type { Atom } from './pdb/mmcif.ts'

// How the panel names an atom's residue: its name, then its chain, number and insertion code, as in HEM A142
function residueText(atom: Atom) {
  return `${atom.residueName} ${atom.chain}${atom.residueNumber}${atom.insertion}`
}

// An atom by its residue and its own name, as in HEM A142 FE, then by its alternate ID if it has one, as in SER A22 OG
// alt B, and by its model when the entry has more than one, as in MET A1 N model 3
export function atomText(atom: Atom, manyModels: boolean) {
  const alternate = atom.altLoc ? ` alt ${atom.altLoc}` : ''
  const model = manyModels ? ` model ${atom.model}` : ''
  return `${residueText(atom)} ${atom.atomName}${alternate}${model}`
}
