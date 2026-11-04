// A small mmCIF reader for what the app needs: the _atom_site table and _struct.title

export interface Atom {
  element: string
  x: number
  y: number
  z: number
  chain: string
  residueName: string
  residueNumber: number
  // The residue's insertion code, such as the A of 52A, or empty
  insertion: string
  atomName: string
  altLoc: string
  occupancy: number
  bFactor: number
  model: number
  hetero: boolean
  // In a polymer chain, as a modified residue such as selenomethionine is though it's a HETATM record;
  // ligands, sugars and waters aren't
  polymer: boolean
  hydrogen: boolean
  water: boolean
}

export interface Structure {
  title: string
  atoms: Atom[]
}

const waterNames = new Set(['HOH', 'WAT', 'H2O', 'DOD'])

// Names an atom's residue by chain, number and insertion code, so that an inserted residue such as 52A stays apart from 52
export function residueKey(atom: Atom) {
  return `${atom.chain} ${atom.residueNumber} ${atom.insertion}`
}

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

export function parseMmcif(text: string): Structure {
  const tokens = new Tokenizer(text)
  let title = ''
  let atoms: Atom[] | null = null
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
      const reader = columns[0]?.startsWith('_atom_site.') ? atomReader(columns) : null
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
      if (reader) atoms = reader.atoms
    } else if (word === '_struct.title') {
      pending = tokens.next()
      if (pending) title = tokens.quoted ? tokens.value : emptyIfUnknown(tokens.value)
    } else {
      pending = tokens.next()
    }
  }

  if (!atoms) throw new Error('The file has no atom table')
  return { title: title.trim().replace(/\s+/g, ' '), atoms }
}

// ? (unknown) and . (not applicable) both read as empty when unquoted
function emptyIfUnknown(value: string) {
  return value === '?' || value === '.' ? '' : value
}

// Finds columns by name, since their order varies between entries, then keeps the first model in one conformation
function atomReader(columns: string[]) {
  const index = (name: string) => columns.indexOf(`_atom_site.${name}`)
  const column = (...names: string[]) => {
    for (const name of names) {
      const i = index(name)
      if (i >= 0) return (row: string[]) => row[i]
    }
    return () => ''
  }
  for (const name of ['Cartn_x', 'Cartn_y', 'Cartn_z']) {
    if (index(name) < 0) throw new Error(`The atom table has no ${name} column`)
  }

  const group = column('group_PDB')
  const element = column('type_symbol')
  const atomName = column('label_atom_id', 'auth_atom_id')
  const altLoc = column('label_alt_id')
  const residueName = column('label_comp_id', 'auth_comp_id')
  // The author's chains and numbers are the ones papers use, and they keep a chain's hemes and waters in it
  const chain = column('auth_asym_id', 'label_asym_id')
  const authSeq = column('auth_seq_id')
  const labelSeq = column('label_seq_id')
  const insertion = column('pdbx_PDB_ins_code')
  const x = column('Cartn_x')
  const y = column('Cartn_y')
  const z = column('Cartn_z')
  const occupancy = column('occupancy')
  const bFactor = column('B_iso_or_equiv')
  const model = column('pdbx_PDB_model_num')
  // A polymer's residues each have a place in its sequence, and ligands, sugars and waters have none.
  // A file without the column falls back on the record type, which takes modified residues for ligands
  const sequenced = index('label_seq_id') >= 0

  let firstModel: string | null = null
  // Each residue keeps the first alternate location it lists, so its atoms come from one conformation
  const residueAlts = new Map<string, string>()
  const atoms: Atom[] = []

  const read = (row: string[]) => {
    firstModel ??= model(row)
    if (model(row) !== firstModel) return
    const alt = altLoc(row)
    if (alt) {
      const residue = `${chain(row)} ${authSeq(row) || labelSeq(row)} ${insertion(row)}`
      const first = residueAlts.get(residue)
      if (first === undefined) residueAlts.set(residue, alt)
      else if (first !== alt) return
    }
    const symbol = normaliseElement(element(row))
    const name = residueName(row)
    atoms.push({
      element: symbol,
      x: Number(x(row)),
      y: Number(y(row)),
      z: Number(z(row)),
      chain: chain(row),
      residueName: name,
      residueNumber: Number(authSeq(row) || labelSeq(row) || 0),
      insertion: insertion(row),
      atomName: atomName(row),
      altLoc: alt,
      occupancy: Number(occupancy(row) || 1),
      bFactor: Number(bFactor(row) || 0),
      model: Number(model(row) || 1),
      hetero: group(row) === 'HETATM',
      polymer: sequenced ? labelSeq(row) !== '' : group(row) === 'ATOM',
      hydrogen: symbol === 'H' || symbol === 'D',
      water: waterNames.has(name),
    })
  }
  return { atoms, read }
}

// type_symbol is usually upper case, such as FE; elements read as Fe
function normaliseElement(symbol: string) {
  return symbol.charAt(0).toUpperCase() + symbol.slice(1).toLowerCase()
}
