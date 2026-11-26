// A small mmCIF reader for what the app needs: the _atom_site table, its anisotropic displacements, the secondary
// structure's ranges and _struct.title, written into a structure's tables. It reads the file's bytes as they arrive,
// a chunk at a time, so that an entry is read as it downloads and its text is never held whole

import { CifTokenizer, decodeText, isPlainWhole, isUnknown, readNumber, type TokenSink } from './cifBytes.ts'
import {
  StructureBuilder,
  type AtomRecord,
  type SecondaryStructure,
  type Structure,
  type StructureBatch,
} from './structure.ts'

const waterNames = new Set(['HOH', 'WAT', 'H2O', 'DOD'])

const underscore = 95

// Whether a token's bytes start with a word, in either case
function startsWith(bytes: Uint8Array, start: number, end: number, word: string) {
  if (end - start < word.length) return false
  for (let k = 0; k < word.length; k++) {
    const code = bytes[start + k]
    // Letters are compared in lower case; the underscore is compared as it is
    const lower = code >= 65 && code <= 90 ? code + 32 : code
    if (lower !== word.charCodeAt(k)) return false
  }
  return true
}

function isLoop(bytes: Uint8Array, start: number, end: number) {
  return end - start === 5 && startsWith(bytes, start, end, 'loop_')
}

// Whether an unquoted token is one of the words that end a loop's values: loop_, stop_ and global_, or a data_ or
// save_ heading. Each has an underscore as its fifth or seventh byte, which almost every other token fails at once
function isReserved(bytes: Uint8Array, start: number, end: number) {
  const length = end - start
  if (length >= 5 && bytes[start + 4] === underscore) {
    if (length === 5 && (startsWith(bytes, start, end, 'loop_') || startsWith(bytes, start, end, 'stop_'))) return true
    return startsWith(bytes, start, end, 'data_') || startsWith(bytes, start, end, 'save_')
  }
  return length === 7 && bytes[start + 6] === underscore && startsWith(bytes, start, end, 'global_')
}

// One row of a table as read: each column's token, by the bytes it lies in, where it starts and ends, and whether it
// was quoted. A column the table doesn't have, found as -1, reads as empty
class Row {
  readonly bytes: Uint8Array[] = []
  readonly starts: number[] = []
  readonly ends: number[] = []
  // Each column's value, as a tag's value is given: empty where it's ? or . unquoted, or an empty quoted string
  readonly empty: boolean[] = []
  length = 0

  push(bytes: Uint8Array, start: number, end: number, isQuoted: boolean) {
    const i = this.length++
    this.bytes[i] = bytes
    this.starts[i] = start
    this.ends[i] = end
    this.empty[i] = end === start || isUnknown(bytes, start, end, isQuoted)
  }

  isEmpty(column: number) {
    return column < 0 || this.empty[column]
  }

  text(column: number) {
    return this.isEmpty(column) ? '' : decodeText(this.bytes[column], this.starts[column], this.ends[column])
  }

  // The number its text reads as, 0 for empty, as Number reads it
  number(column: number) {
    return column < 0 || this.empty[column] ? 0 : readNumber(this.bytes[column], this.starts[column], this.ends[column])
  }
}

// The tokens up to this long that a column repeats from the row before are matched by their bytes, and those up to
// this long are kept by a key that packs their bytes, so that a column's text is made once for each distinct value
const repeatedBytes = 8
const packedBytes = 6

// The text of the values a table's columns hold, as Row's text, made once for each distinct short value and kept, and
// for each column the last value's, since a column mostly repeats from one row to the next
class ColumnText {
  private readonly packed = new Map<number, string>()
  private readonly lastBytes: Uint8Array
  private readonly lastLength: Int32Array
  private readonly lastText: string[]

  constructor(columns: number) {
    this.lastBytes = new Uint8Array(columns * repeatedBytes)
    this.lastLength = new Int32Array(columns).fill(-1)
    this.lastText = new Array<string>(columns).fill('')
  }

  of(row: Row, column: number): string {
    if (column < 0 || row.empty[column]) return ''
    const bytes = row.bytes[column]
    const start = row.starts[column]
    const end = row.ends[column]
    const length = end - start
    if (length > repeatedBytes) return decodeText(bytes, start, end)
    const at = column * repeatedBytes
    const last = this.lastBytes
    if (this.lastLength[column] === length) {
      let k = 0
      while (k < length && last[at + k] === bytes[start + k]) k++
      if (k === length) return this.lastText[column]
    }
    for (let k = 0; k < length; k++) last[at + k] = bytes[start + k]
    this.lastLength[column] = length
    let text: string
    if (length <= packedBytes) {
      // A leading 1 keeps the length in the key, so that no two lengths share one
      let key = 1
      for (let k = start; k < end; k++) key = key * 256 + bytes[k]
      text = this.packed.get(key) ?? decodeText(bytes, start, end)
      this.packed.set(key, text)
    } else text = decodeText(bytes, start, end)
    this.lastText[column] = text
    return text
  }
}

// What an atom's id is known by when the anisotropic tensors are joined to it: a whole number where its text plainly
// writes one, and otherwise its text, so that two ids match exactly when their texts do
type AtomId = number | string

function idOf(row: Row, column: number): AtomId {
  if (row.isEmpty(column)) return ''
  const bytes = row.bytes[column]
  const start = row.starts[column]
  const end = row.ends[column]
  return isPlainWhole(bytes, start, end) ? readNumber(bytes, start, end) : decodeText(bytes, start, end)
}

// Each atom's id, kept only once one isn't its row plus one, as almost every file's ids are
class AtomIds {
  private ids: AtomId[] | null = null

  add(atom: number, id: AtomId) {
    if (this.ids) this.ids.push(id)
    else if (id !== atom + 1) {
      this.ids = Array.from({ length: atom }, (_, row) => row + 1)
      this.ids.push(id)
    }
  }

  of(atom: number): AtomId {
    return this.ids ? this.ids[atom] : atom + 1
  }
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

// Told of each atom as it's added to the structure: the atom, its row, and the rows of its residue and its chain
export interface AtomVisitor {
  atom(atom: AtomRecord, row: number, residue: number, chain: number): void
}

export interface ReaderOptions {
  // How many atoms to make room for, asked when the atom table starts, so that a size learnt while the file's first
  // tables are read is used
  capacity?: () => number | undefined
  onAtom?: AtomVisitor
}

// A table's reader, which takes each row once it holds a value for every column
interface TableReader {
  read(row: Row): void
}

// What the reader is in the middle of: the file's top level, a loop's tags, a loop's values, and a tag outside a loop
// whose value is next
const topLevel = 0
const loopTags = 1
const loopValues = 2
const tagValue = 3

// Whether a token is a tag or a reserved word, either of which ends a loop's values and stands where a tag's value
// would otherwise be
function endsValues(bytes: Uint8Array, start: number, end: number, isQuoted: boolean) {
  return !isQuoted && (bytes[start] === underscore || isReserved(bytes, start, end))
}

// Reads an mmCIF file's bytes chunk by chunk, and gives its structure once the file ends
export class MmcifReader implements TokenSink {
  private readonly tokens: CifTokenizer
  private readonly onAtom: AtomVisitor | undefined
  private readonly capacity: () => number | undefined
  private mode = topLevel
  private titleText = ''
  private completed: AtomSite | null = null
  private table: AtomSite | null = null
  private readonly ranges: Range[] = []
  // The ranges read so far by their chains, made again only as more are read
  private rangesByChain = { count: 0, byChain: new Map<string, Range[]>() }
  // Each anisotropic tensor by its atom's id, which the atoms are joined to once the file is read, so either table may
  // come first
  private readonly tensors = new Map<AtomId, Float32Array>()
  // A table of one row may be written as a tag and value per column instead of a loop: each such table's tags and
  // values, in the file's order
  private readonly single = new Map<string, { columns: string[]; row: Row }>(
    singleCategories.map((category) => [category, { columns: [], row: new Row() }]),
  )
  // The loop being read: its tags, its reader, the atom table's where it's that one, and its row so far
  private columns: string[] = []
  private reader: TableReader | null = null
  private atoms: AtomSite | null = null
  private row = new Row()
  // The tag whose value is next
  private tag = ''

  constructor({ capacity, onAtom }: ReaderOptions = {}) {
    this.tokens = new CifTokenizer(this)
    this.capacity = capacity ?? (() => undefined)
    this.onAtom = onAtom
  }

  feed(bytes: Uint8Array) {
    this.tokens.feed(bytes)
  }

  // How many atoms have been read so far
  get atomCount() {
    return (this.atoms ?? this.table)?.builder.atomCount ?? 0
  }

  // Makes room for a count of atoms all told, once the atom table has started
  reserve(capacity: number) {
    ;(this.atoms ?? this.table)?.builder.reserve(capacity)
  }

  // Whether the atom table has started
  get atomsStarted() {
    return this.atoms !== null || this.table !== null
  }

  token(bytes: Uint8Array, start: number, end: number, isQuoted: boolean) {
    // A token that ends what came before it is read again at the top level
    for (;;) {
      // A loop's values are almost every token, so they're taken first
      if (this.mode === loopValues) {
        if (endsValues(bytes, start, end, isQuoted)) {
          this.closeLoop()
          continue
        }
        const { reader, row } = this
        if (reader) {
          row.push(bytes, start, end, isQuoted)
          if (row.length === this.columns.length) {
            reader.read(row)
            row.length = 0
          }
        }
        return
      }
      switch (this.mode) {
        case topLevel:
          if (isQuoted) return
          if (isLoop(bytes, start, end)) {
            this.mode = loopTags
            this.columns = []
          } else if (bytes[start] === underscore) {
            this.mode = tagValue
            this.tag = decodeText(bytes, start, end)
          }
          return
        case loopTags:
          if (!isQuoted && bytes[start] === underscore) {
            this.columns.push(decodeText(bytes, start, end))
            return
          }
          this.openLoop()
          continue
        case tagValue: {
          // A tag outside a loop is followed by its value, unless the file leaves it out
          this.mode = topLevel
          if (endsValues(bytes, start, end, isQuoted)) continue
          const { tag } = this
          if (tag === '_struct.title') this.titleText = isUnknown(bytes, start, end, isQuoted) ? '' : decodeText(bytes, start, end)
          const pairs = this.single.get(singleCategories.find((prefix) => tag.startsWith(prefix)) ?? '')
          if (pairs) {
            pairs.columns.push(tag)
            pairs.row.push(bytes, start, end, isQuoted)
          }
          return
        }
      }
    }
  }

  // The title as read so far, its spaces made single
  get title(): string {
    return this.titleText.trim().replace(/\s+/g, ' ')
  }

  // Has a handler called once, at the next residue's start in the atom table, where every atom read so far is in a
  // residue that has all its atoms. Before the atom table starts there's nothing to call it for
  callAtNextResidue(handler: () => void) {
    ;(this.atoms ?? this.table)?.builder.callAtNextResidue(handler)
  }

  // The structure read so far, its columns views of the atom table's own, or null before it starts
  places(): Structure | null {
    return (this.atoms ?? this.table)?.builder.snapshot() ?? null
  }

  // What's been read since the last batch, called at a residue's start, with the secondary structure of the residues
  // it holds as the ranges read so far give it
  takeBatch(): StructureBatch {
    const site = this.atoms ?? this.table
    if (!site) throw new Error('The file has no atom table')
    if (this.rangesByChain.count !== this.ranges.length) this.rangesByChain = { count: this.ranges.length, byChain: byChain(this.ranges) }
    resolveStructures(site, this.rangesByChain.byChain, site.builder.residuesTaken)
    return site.builder.takeBatch(this.title)
  }

  // The last batch, once the file has ended: what's been read since the batch before, with every residue's secondary
  // structure where the ranges read since changed any of an earlier batch's, and the tensors
  takeLastBatch(): StructureBatch {
    const table = this.complete()
    return table.builder.takeBatch(this.title, true)
  }

  // The structure, once the file has ended
  finish(): Structure {
    return this.complete().builder.finish(this.title)
  }

  // Ends the file, once: the last loop closed, the tables written a tag and value per column read, and the secondary
  // structure and the tensors given to the atoms
  private complete(): AtomSite {
    if (this.completed) return this.completed
    this.tokens.end()
    if (this.mode === loopTags) this.openLoop()
    if (this.mode === loopValues) this.closeLoop()
    const { table, tensors, ranges } = this
    if (!table) throw new Error('The file has no atom table')
    for (const [category, { columns, row }] of this.single) {
      if (columns.length === 0) continue
      if (category === anisotropCategory) anisotropReader(columns, tensors).read(row)
      else rangeReader(columns, category, ranges).read(row)
    }
    resolveStructures(table, byChain(ranges), 0)
    joinTensors(table, tensors)
    this.completed = table
    return table
  }

  // Starts reading a loop's values by its tags, with a reader for the tables read and none for the rest
  private openLoop() {
    const { columns } = this
    // The atom table's test is exact, so that _atom_site_anisotrop's loop doesn't match it
    this.atoms = columns[0]?.startsWith(atomCategory) ? atomReader(columns, this.capacity(), this.onAtom) : null
    const category = rangeCategories.find((prefix) => columns[0]?.startsWith(prefix))
    this.reader =
      this.atoms ??
      (category ? rangeReader(columns, category, this.ranges) : null) ??
      (columns[0]?.startsWith(anisotropCategory) ? anisotropReader(columns, this.tensors) : null)
    this.row = new Row()
    this.mode = loopValues
  }

  private closeLoop() {
    if (this.atoms) this.table = this.atoms
    this.atoms = null
    this.reader = null
    this.mode = topLevel
  }
}

// Reads a whole mmCIF file's text, by the same path as its bytes
export function parseMmcif(text: string): Structure {
  const reader = new MmcifReader()
  reader.feed(new TextEncoder().encode(text))
  return reader.finish()
}

// Finds a table's columns by name, since their order varies between entries: the place of the first of the names the
// table has, or -1, which reads as empty, for a table with none of them
function columnFinder(columns: string[], category: string) {
  return (...names: string[]) => {
    for (const name of names) {
      const i = columns.indexOf(category + name)
      if (i >= 0) return i
    }
    return -1
  }
}

// The atom table as read: the structure it's written into, and what resolving the secondary structure and joining the
// tensors need: each residue's chain label and place in its chain's sequence, NaN outside a polymer, and each atom's id,
// which the anisotropic tensors name it by
interface AtomSite extends TableReader {
  builder: StructureBuilder
  labelChains: string[]
  labelPlaces: number[]
  ids: AtomIds
}

// Reads every model's atoms in every conformation, marking each residue's first conformation within its model
function atomReader(columns: string[], capacity: number | undefined, onAtom: AtomVisitor | undefined): AtomSite {
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
  const builder = new StructureBuilder(capacity)
  const labelChains: string[] = []
  const labelPlaces: number[] = []
  const ids = new AtomIds()
  const text = new ColumnText(columns.length)
  // Each element symbol as written and as an element reads
  const symbols = new Map<string, string>()
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

  const read = (row: Row) => {
    const modelNumber = row.isEmpty(model) ? 1 : row.number(model)
    const alt = text.of(row, altLoc)
    const chainName = text.of(row, chain)
    const authNumber = text.of(row, authSeq)
    const place = text.of(row, labelSeq)
    const insertionCode = text.of(row, insertion)
    let firstConformation = true
    if (alt) {
      const residue = `${modelNumber} ${chainName} ${authNumber || place} ${insertionCode}`
      const first = residueAlts.get(residue)
      if (first === undefined) residueAlts.set(residue, alt)
      else firstConformation = first === alt
    }
    const written = text.of(row, element)
    let symbol = symbols.get(written)
    if (symbol === undefined) {
      symbol = normaliseElement(written)
      symbols.set(written, symbol)
    }
    const name = text.of(row, residueName)
    atom.x = row.number(x)
    atom.y = row.number(y)
    atom.z = row.number(z)
    atom.element = symbol
    atom.atomName = text.of(row, atomName)
    atom.altLoc = alt
    atom.occupancy = row.isEmpty(occupancy) ? 1 : row.number(occupancy)
    atom.bFactor = row.isEmpty(bFactor) ? 0 : row.number(bFactor)
    atom.model = modelNumber
    atom.chain = chainName
    atom.labelChain = text.of(row, labelChain)
    atom.residueName = name
    atom.residueNumber = authNumber ? row.number(authSeq) : place ? row.number(labelSeq) : 0
    atom.insertion = insertionCode
    atom.hydrogen = symbol === 'H' || symbol === 'D'
    atom.water = waterNames.has(name)
    atom.firstConformation = firstConformation
    atom.polymer = sequenced ? place !== '' : text.of(row, group) === 'ATOM'
    const added = builder.add(atom)
    // A residue's label chain and place are its first atom's
    if (builder.residueCount > labelPlaces.length) {
      labelChains.push(atom.labelChain)
      labelPlaces.push(place === '' ? NaN : row.number(labelSeq))
    }
    ids.add(added, idOf(row, id))
    onAtom?.atom(atom, added, builder.residueCount - 1, builder.chainRow)
  }
  return { builder, labelChains, labelPlaces, ids, read }
}

// Reads _struct_conf's helices and turns, or _struct_sheet_range's strands, as ranges of label numbering. A range is
// named by its chain's label and its places in the sequence, which no insertion code or microheterogeneity confuses
function rangeReader(columns: string[], category: string, ranges: Range[]): TableReader {
  const column = columnFinder(columns, category)
  const type = column('conf_type_id')
  const firstChain = column('beg_label_asym_id')
  const firstPlace = column('beg_label_seq_id')
  const lastChain = column('end_label_asym_id')
  const lastPlace = column('end_label_seq_id')
  const read = (row: Row) => {
    const structure = category === strandCategory ? 'strand' : confStructure(row.text(type))
    const chain = row.text(firstChain)
    const first = row.isEmpty(firstPlace) ? NaN : row.number(firstPlace)
    const last = row.isEmpty(lastPlace) ? NaN : row.number(lastPlace)
    if (structure !== 'none' && chain !== '' && chain === row.text(lastChain) && first <= last) {
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
function anisotropReader(columns: string[], tensors: Map<AtomId, Float32Array>): TableReader {
  const column = columnFinder(columns, anisotropCategory)
  const id = column('id')
  const fromB = !columns.includes(`${anisotropCategory}U[1][1]`) && columns.includes(`${anisotropCategory}B[1][1]`)
  const scale = fromB ? 1 / bPerU : 1
  const values = tensorColumns.map((suffix) => column((fromB ? 'B' : 'U') + suffix))
  const read = (row: Row) => {
    const u = new Float32Array(6)
    for (let k = 0; k < 6; k++) {
      const value = row.isEmpty(values[k]) ? NaN : row.number(values[k]) * scale
      if (!Number.isFinite(value)) return
      u[k] = value
    }
    tensors.set(idOf(row, id), u)
  }
  return { read }
}

// Gives each atom the tensor whose id is its own
function joinTensors({ builder, ids }: AtomSite, tensors: Map<AtomId, Float32Array>) {
  if (tensors.size === 0) return
  for (let atom = 0; atom < builder.atomCount; atom++) {
    const u = tensors.get(ids.of(atom))
    if (u) builder.addTensor(atom, u)
  }
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

// The ranges by their chains' labels
function byChain(ranges: Range[]) {
  const chainRanges = new Map<string, Range[]>()
  for (const range of ranges) {
    const listed = chainRanges.get(range.chain)
    if (listed) listed.push(range)
    else chainRanges.set(range.chain, [range])
  }
  return chainRanges
}

// Gives each residue that lies in a range that range's structure, matched by the chain's label and the residue's place
// in its sequence. Residues follow one another along their chains, so each run of residues at one place is searched once
function resolveStructures({ builder, labelChains, labelPlaces }: AtomSite, chainRanges: Map<string, Range[]>, from: number) {
  if (chainRanges.size === 0) return
  let chain: string | null = null
  let place = NaN
  let structure: SecondaryStructure = 'none'
  for (let residue = from; residue < labelChains.length; residue++) {
    const label = labelChains[residue]
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
  }
}

// type_symbol is usually upper case, such as FE; elements read as Fe
function normaliseElement(symbol: string) {
  return symbol.charAt(0).toUpperCase() + symbol.slice(1).toLowerCase()
}
