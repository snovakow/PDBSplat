// A small mmCIF reader for what the app needs: the _atom_site table, its anisotropic displacements, the secondary
// structure's ranges and _struct.title, written into a structure's tables

import { StructureBuilder, type AtomRecord, type SecondaryStructure, type Structure } from './structure.ts'

const waterNames = new Set(['HOH', 'WAT', 'H2O', 'DOD'])

// Walks CIF's tokens: whitespace-separated values, quoted strings and semicolon text fields
class Tokenizer {
  private readonly text: string
  private pos = 0
  value = ''
  quoted = false

  constructor(text: string) {
    this.text = text
  }

  next(): boolean {
    const text = this.text
    const length = text.length
    let pos = this.pos
    for (;;) {
      while (pos < length && isSpace(text.charCodeAt(pos))) pos++
      if (pos >= length) {
        this.pos = pos
        return false
      }
      if (text[pos] !== '#') break
      while (pos < length && text[pos] !== '\n' && text[pos] !== '\r') pos++
    }

    const char = text[pos]
    if (char === ';' && (pos === 0 || text[pos - 1] === '\n' || text[pos - 1] === '\r')) {
      // A text field runs to the next line that starts with a semicolon
      let end = text.indexOf('\n;', pos + 1)
      if (end < 0) end = length
      this.value = text.slice(pos + 1, end).replace(/\r$/, '')
      this.quoted = true
      this.pos = end + 2
      return true
    }
    if (char === "'" || char === '"') {
      // A quote closes the string only when whitespace or the end follows it
      let end = pos + 1
      while (end < length && !(text[end] === char && (end + 1 >= length || isSpace(text.charCodeAt(end + 1))))) end++
      this.value = text.slice(pos + 1, end)
      this.quoted = true
      this.pos = end + 1
      return true
    }
    let end = pos + 1
    while (end < length && !isSpace(text.charCodeAt(end))) end++
    this.value = text.slice(pos, end)
    this.quoted = false
    this.pos = end
    return true
  }
}

function isSpace(code: number) {
  return code === 32 || code === 9 || code === 10 || code === 13
}

// Unquoted words that end a loop's values
function isReserved(word: string) {
  const lower = word.toLowerCase()
  return lower === 'loop_' || lower === 'stop_' || lower === 'global_' || lower.startsWith('data_') || lower.startsWith('save_')
}

// The tables read, by the prefix their columns' tags share
const atomCategory = '_atom_site.'
const helixCategory = '_struct_conf.'
const strandCategory = '_struct_sheet_range.'
const rangeCategories = [helixCategory, strandCategory]
const anisotropCategory = '_atom_site_anisotrop.'
// The tables that may be written as a tag and value per column when they have one row
const singleCategories = [...rangeCategories, anisotropCategory]

// A secondary structure's run of residues in one chain, by the chain's label and the residues' places in its sequence
interface Range {
  structure: SecondaryStructure
  chain: string
  first: number
  last: number
}

export function parseMmcif(text: string): Structure {
  const tokens = new Tokenizer(text)
  let title = ''
  let table: AtomSite | null = null
  const ranges: Range[] = []
  // Each anisotropic tensor by its atom's id, which the atoms are joined to once the file is read, so either table may
  // come first
  const tensors = new Map<string, Float32Array>()
  // A table of one row may be written as a tag and value per column instead of a loop: each such table's tags and
  // values, in the file's order
  const single = new Map<string, { columns: string[]; row: string[] }>(
    singleCategories.map((category) => [category, { columns: [], row: [] }]),
  )
  let pending = tokens.next()

  while (pending) {
    const word = tokens.value
    if (tokens.quoted) {
      pending = tokens.next()
    } else if (word.toLowerCase() === 'loop_') {
      const columns: string[] = []
      pending = tokens.next()
      while (pending && !tokens.quoted && tokens.value.startsWith('_')) {
        columns.push(tokens.value)
        pending = tokens.next()
      }
      // The atom table's test is exact, so that _atom_site_anisotrop's loop doesn't match it
      const atoms = columns[0]?.startsWith(atomCategory) ? atomReader(columns) : null
      const category = rangeCategories.find((prefix) => columns[0]?.startsWith(prefix))
      const reader =
        atoms ??
        (category ? rangeReader(columns, category, ranges) : null) ??
        (columns[0]?.startsWith(anisotropCategory) ? anisotropReader(columns, tensors) : null)
      const row: string[] = []
      while (pending && (tokens.quoted || !(tokens.value.startsWith('_') || isReserved(tokens.value)))) {
        if (reader) {
          row.push(tokens.quoted ? tokens.value : emptyIfUnknown(tokens.value))
          if (row.length === columns.length) {
            reader.read(row)
            row.length = 0
          }
        }
        pending = tokens.next()
      }
      if (atoms) table = atoms.table
    } else if (word.startsWith('_')) {
      // A tag outside a loop is followed by its value, unless the file leaves it out
      pending = tokens.next()
      if (pending && (tokens.quoted || !(tokens.value.startsWith('_') || isReserved(tokens.value)))) {
        const value = tokens.quoted ? tokens.value : emptyIfUnknown(tokens.value)
        if (word === '_struct.title') title = value
        const pairs = single.get(singleCategories.find((prefix) => word.startsWith(prefix)) ?? '')
        if (pairs) {
          pairs.columns.push(word)
          pairs.row.push(value)
        }
        pending = tokens.next()
      }
    } else {
      pending = tokens.next()
    }
  }

  if (!table) throw new Error('The file has no atom table')
  for (const [category, { columns, row }] of single) {
    if (columns.length === 0) continue
    if (category === anisotropCategory) anisotropReader(columns, tensors).read(row)
    else rangeReader(columns, category, ranges).read(row)
  }
  resolveStructures(table, ranges)
  joinTensors(table, tensors)
  return table.builder.finish(title.trim().replace(/\s+/g, ' '))
}

// ? (unknown) and . (not applicable) both read as empty when unquoted
function emptyIfUnknown(value: string) {
  return value === '?' || value === '.' ? '' : value
}

// Finds a table's columns by name, since their order varies between entries: a reader of the first of the names the
// table has, or of empty values for a table with none of them
function columnFinder(columns: string[], category: string) {
  return (...names: string[]) => {
    for (const name of names) {
      const i = columns.indexOf(category + name)
      if (i >= 0) return (row: string[]) => row[i]
    }
    return () => ''
  }
}

// The atom table as read: the structure it's written into, and what resolving the secondary structure and joining the
// tensors need: each residue's chain label and place in its chain's sequence, NaN outside a polymer, and each atom's id,
// which the anisotropic tensors name it by
interface AtomSite {
  builder: StructureBuilder
  labelChains: string[]
  labelPlaces: number[]
  ids: string[]
}

// Reads every model's atoms in every conformation, marking each residue's first conformation within its model
function atomReader(columns: string[]) {
  const column = columnFinder(columns, atomCategory)
  for (const name of ['Cartn_x', 'Cartn_y', 'Cartn_z']) {
    if (!columns.includes(atomCategory + name)) throw new Error(`The atom table has no ${name} column`)
  }

  const group = column('group_PDB')
  const element = column('type_symbol')
  const atomName = column('label_atom_id', 'auth_atom_id')
  const altLoc = column('label_alt_id')
  const residueName = column('label_comp_id', 'auth_comp_id')
  // The author's chains and numbers are the ones papers use, and they keep a chain's hemes and waters in it
  const chain = column('auth_asym_id', 'label_asym_id')
  const authSeq = column('auth_seq_id')
  const labelChain = column('label_asym_id')
  const labelSeq = column('label_seq_id')
  const insertion = column('pdbx_PDB_ins_code')
  const x = column('Cartn_x')
  const y = column('Cartn_y')
  const z = column('Cartn_z')
  const occupancy = column('occupancy')
  const bFactor = column('B_iso_or_equiv')
  const model = column('pdbx_PDB_model_num')
  const id = column('id')
  // A polymer's residues each have a place in its sequence, and ligands, sugars and waters have none.
  // A file without the column falls back on the record type, which takes modified residues for ligands
  const sequenced = columns.includes(`${atomCategory}label_seq_id`)

  // Each residue's first alternate ID within each model: its atoms with that ID or none make its first conformation
  const residueAlts = new Map<string, string>()
  const table: AtomSite = { builder: new StructureBuilder(), labelChains: [], labelPlaces: [], ids: [] }
  const { builder, labelChains, labelPlaces, ids } = table
  // One record serves every row, which the builder copies from
  const atom: AtomRecord = {
    x: 0,
    y: 0,
    z: 0,
    element: '',
    atomName: '',
    altLoc: '',
    occupancy: 1,
    bFactor: 0,
    model: 1,
    chain: '',
    labelChain: '',
    residueName: '',
    residueNumber: 0,
    insertion: '',
    hydrogen: false,
    water: false,
    firstConformation: true,
    polymer: false,
  }

  const read = (row: string[]) => {
    const modelNumber = Number(model(row) || 1)
    const alt = altLoc(row)
    let firstConformation = true
    if (alt) {
      const residue = `${modelNumber} ${chain(row)} ${authSeq(row) || labelSeq(row)} ${insertion(row)}`
      const first = residueAlts.get(residue)
      if (first === undefined) residueAlts.set(residue, alt)
      else firstConformation = first === alt
    }
    const symbol = normaliseElement(element(row))
    const name = residueName(row)
    const place = labelSeq(row)
    atom.x = Number(x(row))
    atom.y = Number(y(row))
    atom.z = Number(z(row))
    atom.element = symbol
    atom.atomName = atomName(row)
    atom.altLoc = alt
    atom.occupancy = Number(occupancy(row) || 1)
    atom.bFactor = Number(bFactor(row) || 0)
    atom.model = modelNumber
    atom.chain = chain(row)
    atom.labelChain = labelChain(row)
    atom.residueName = name
    atom.residueNumber = Number(authSeq(row) || place || 0)
    atom.insertion = insertion(row)
    atom.hydrogen = symbol === 'H' || symbol === 'D'
    atom.water = waterNames.has(name)
    atom.firstConformation = firstConformation
    atom.polymer = sequenced ? place !== '' : group(row) === 'ATOM'
    builder.add(atom)
    // A residue's label chain and place are its first atom's
    if (builder.residueCount > labelPlaces.length) {
      labelChains.push(atom.labelChain)
      labelPlaces.push(place === '' ? NaN : Number(place))
    }
    ids.push(id(row))
  }
  return { table, read }
}

// Reads _struct_conf's helices and turns, or _struct_sheet_range's strands, as ranges of label numbering. A range is
// named by its chain's label and its places in the sequence, which no insertion code or microheterogeneity confuses
function rangeReader(columns: string[], category: string, ranges: Range[]) {
  const column = columnFinder(columns, category)
  const type = column('conf_type_id')
  const firstChain = column('beg_label_asym_id')
  const firstPlace = column('beg_label_seq_id')
  const lastChain = column('end_label_asym_id')
  const lastPlace = column('end_label_seq_id')
  const read = (row: string[]) => {
    const structure = category === strandCategory ? 'strand' : confStructure(type(row))
    const chain = firstChain(row)
    const first = firstPlace(row) === '' ? NaN : Number(firstPlace(row))
    const last = lastPlace(row) === '' ? NaN : Number(lastPlace(row))
    if (structure !== 'none' && chain !== '' && chain === lastChain(row) && first <= last) {
      ranges.push({ structure, chain, first, last })
    }
  }
  return { read }
}

// The anisotropic table's columns usually run U11, U22, U33, U12, U13, U23, while a covariance here takes U11, U12,
// U13, U22, U23, U33: each of those six in turn, by the name of the column it's read from
const tensorColumns = ['[1][1]', '[1][2]', '[1][3]', '[2][2]', '[2][3]', '[3][3]']

// A B tensor is 8π² times its U, as a B-factor is
const bPerU = 8 * Math.PI * Math.PI

// Reads _atom_site_anisotrop's tensors by their atoms' ids, as U, or as B, which is converted to U. A row missing any of
// the six values is left out
function anisotropReader(columns: string[], tensors: Map<string, Float32Array>) {
  const column = columnFinder(columns, anisotropCategory)
  const id = column('id')
  const fromB = !columns.includes(`${anisotropCategory}U[1][1]`) && columns.includes(`${anisotropCategory}B[1][1]`)
  const scale = fromB ? 1 / bPerU : 1
  const values = tensorColumns.map((suffix) => column((fromB ? 'B' : 'U') + suffix))
  const read = (row: string[]) => {
    const u = new Float32Array(6)
    for (let k = 0; k < 6; k++) {
      const text = values[k](row)
      const value = text === '' ? NaN : Number(text) * scale
      if (!Number.isFinite(value)) return
      u[k] = value
    }
    tensors.set(id(row), u)
  }
  return { read }
}

// Gives each atom the tensor whose id is its own
function joinTensors({ builder, ids }: AtomSite, tensors: Map<string, Float32Array>) {
  if (tensors.size === 0) return
  ids.forEach((id, atom) => {
    const u = tensors.get(id)
    if (u) builder.addTensor(atom, u)
  })
}

// _struct_conf's types: HELX_P and the other helices, TURN_P and the other turns, and STRN for a strand
function confStructure(type: string): SecondaryStructure {
  if (type.startsWith('HELX')) return 'helix'
  if (type.startsWith('TURN')) return 'turn'
  if (type.startsWith('STRN')) return 'strand'
  return 'none'
}

// Where ranges overlap, a strand outranks a helix, and either a turn
const structureRank: Record<SecondaryStructure, number> = { none: 0, turn: 1, helix: 2, strand: 3 }

// Gives each residue that lies in a range that range's structure, matched by the chain's label and the residue's place
// in its sequence. Residues follow one another along their chains, so each run of residues at one place is searched once
function resolveStructures({ builder, labelChains, labelPlaces }: AtomSite, ranges: Range[]) {
  if (ranges.length === 0) return
  const chainRanges = new Map<string, Range[]>()
  for (const range of ranges) {
    const listed = chainRanges.get(range.chain)
    if (listed) listed.push(range)
    else chainRanges.set(range.chain, [range])
  }
  let chain: string | null = null
  let place = NaN
  let structure: SecondaryStructure = 'none'
  labelChains.forEach((label, residue) => {
    if (label !== chain || !Object.is(labelPlaces[residue], place)) {
      chain = label
      place = labelPlaces[residue]
      structure = 'none'
      for (const range of chainRanges.get(chain) ?? []) {
        if (place >= range.first && place <= range.last && structureRank[range.structure] > structureRank[structure]) {
          structure = range.structure
        }
      }
    }
    if (structure !== 'none') builder.setSecondaryStructure(residue, structure)
  })
}

// type_symbol is usually upper case, such as FE; elements read as Fe
function normaliseElement(symbol: string) {
  return symbol.charAt(0).toUpperCase() + symbol.slice(1).toLowerCase()
}
