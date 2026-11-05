import type { Atom } from './pdb/mmcif.ts'

// How the panel names an atom's residue: its name, then its chain, number and insertion code, as in HEM A142
function residueText(atom: Atom) {
  return `${atom.residueName} ${atom.chain}${atom.residueNumber}${atom.insertion}`
}

// An atom by its residue and its own name, as in HEM A142 FE
export function atomText(atom: Atom) {
  return `${residueText(atom)} ${atom.atomName}`
}
