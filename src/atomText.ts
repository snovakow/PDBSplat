import {
  altLocOf,
  atomNameOf,
  chainOf,
  insertionOf,
  modelOf,
  residueNameOf,
  type Structure,
} from './pdb/structure.ts'

// How the panel names an atom's residue: its name, then its chain, number and insertion code, as in HEM A142
function residueText(structure: Structure, atom: number) {
  const residue = structure.atoms.residue[atom]
  const chain = structure.chains.name[chainOf(structure, atom)]
  return `${residueNameOf(structure, atom)} ${chain}${structure.residues.number[residue]}${insertionOf(structure, residue)}`
}

// An atom of the structure, by its row, named by its residue and its own name, as in HEM A142 FE, then by its
// alternate ID if it has one, as in SER A22 OG alt B, and by its model when the entry has more than one, as in MET A1 N
// model 3
export function atomText(structure: Structure, atom: number, manyModels: boolean) {
  const altLoc = altLocOf(structure, atom)
  const alternate = altLoc ? ` alt ${altLoc}` : ''
  const model = manyModels ? ` model ${modelOf(structure, atom)}` : ''
  return `${residueText(structure, atom)} ${atomNameOf(structure, atom)}${alternate}${model}`
}
