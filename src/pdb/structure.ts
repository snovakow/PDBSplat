// An entry's structure as tables of typed arrays: its atoms, its residues, the runs of residues the file writes in one
// stretch, and its chains, one row per item in each, so that an atom's identity is its row. A StructureBuilder writes
// them atom by atom in the file's order, for the parser and for anything else that makes a structure

// The secondary structure a polymer residue lies in, or none for one in no range and every residue outside a polymer
export type SecondaryStructure = 'helix' | 'strand' | 'turn' | 'none'

// The secondary structures by the index a residue holds
export const secondaryStructures: readonly SecondaryStructure[] = ['none', 'helix', 'strand', 'turn']

// An atom's flags, one bit each: a hydrogen or a deuterium; a water's; in its residue's first conformation within its
// model, without an alternate ID or with the first one the residue lists there; and in a polymer chain, as a modified
// residue such as selenomethionine is though it's a HETATM record, where ligands, sugars and waters aren't
export const hydrogenFlag = 1
export const waterFlag = 2
export const firstConformationFlag = 4
export const polymerFlag = 8

// Every model's atoms in every conformation, in the file's order
export interface Atoms {
  count: number
  // Each atom's x, y and z, in ångströms. Single precision keeps a file's thousandths of an ångström to within a
  // thirtieth of one inside 1,000 Å of the origin, and to within half of one out to 10,000 Å
  positions: Float32Array
  // Each atom's element, by its place in the structure's symbol table
  element: Uint8Array
  bFactor: Float32Array
  occupancy: Float32Array
  flags: Uint8Array
  // Each atom's alternate ID, by its place in the table of them, whose first is none
  altLoc: Uint8Array
  // Each atom's name, by its place in the table of them
  name: Uint16Array
  // The row of the residue it's in
  residue: Uint32Array
}

// A residue is a stretch of atoms of one model, one chain and one label chain with one number and insertion code
export interface Residues {
  count: number
  // The row of the run it's in
  run: Uint32Array
  // The author's number, or the place in the sequence where there's none
  number: Int32Array
  // Its insertion code, such as the A of 52A, by its place in the table of them, whose first is none
  insertion: Uint8Array
  // Its name, as its first atom gives it, by its place in the table of them
  name: Uint16Array
  // Its secondary structure, by its place in secondaryStructures
  structure: Uint8Array
  // Each residue's first atom's row, and after the last one the atom count, so that a residue's atoms run from its own
  // start to the next one's
  firstAtom: Uint32Array
}

// A run is a stretch of residues of one model, one chain and one label chain: the parts of a chain the file writes
// apart, as a chain's polymer comes before its ligands and its waters, which follow every chain's polymer
export interface Runs {
  count: number
  // The row of the chain it's in
  chain: Uint32Array
  // The file's own name for its label chain, which the assembly lists name
  label: string[]
  // Each run's first residue's row and first atom's row, and after the last one the residue and atom counts
  firstResidue: Uint32Array
  firstAtom: Uint32Array
}

// A chain is the runs of one model that share an author's chain name, numbered in the order they first appear, so a
// chain keeps its hemes and waters
export interface Chains {
  count: number
  name: string[]
  model: Int32Array
  // The rows of the runs, chain by chain and each chain's in the file's order, and where each chain's start among
  // them, with the run count after the last
  runs: Uint32Array
  firstRun: Uint32Array
}

// The anisotropic mean square displacements U the entry records, in square ångströms, each as the six values of its
// symmetric tensor in the order the ellipsoids' covariances take: U11, U12, U13, U22, U23 and U33. They're in the same
// Cartesian frame as the coordinates, as the PDB's format guide says of the ANISOU records the table carries
export interface Tensors {
  // The rows of the atoms that have one, ascending
  atoms: Uint32Array
  // Six values for each of them, in the same order
  values: Float32Array
}

// The atoms whose residue's name isn't their own, as in a residue recorded in more than one chemical form, such as
// crambin's proline or serine 22: each such atom's row, ascending, and its own residue name's place in the table
export interface Forms {
  atoms: Uint32Array
  names: Uint16Array
}

// What the builder counted as the atoms came: across the entry, the atoms with an alternate ID, the waters, the
// hydrogens, the ligands' atoms in their first conformations and the atoms in later conformations; and among the atoms
// Models and Alternates show at their defaults, those of the first model in their first conformations, how many, and
// how many of them are waters, hydrogens or have an alternate ID
export interface Tallies {
  alternates: number
  waters: number
  hydrogens: number
  ligands: number
  later: number
  defaults: { atoms: number; waters: number; hydrogens: number; alternates: number }
}

// A structure read in batches, as the page sees it while it arrives: a snapshot after each batch, each holding every
// row the one before it held, unchanged, and more after them, until the last, which is whole and may also give the
// residues their secondary structure afresh and the atoms their tensors. Every snapshot of one structure names the
// same arrival, which also says how many atoms the whole is expected to hold, for what's sized by it as it grows
export interface Arrival {
  expectedAtoms: number
}

export interface Structure {
  title: string
  // The models' numbers, in the file's order
  models: number[]
  atoms: Atoms
  residues: Residues
  runs: Runs
  chains: Chains
  // Null where the entry records none
  tensors: Tensors | null
  // Null where every atom's residue name is its own
  forms: Forms | null
  // The tables the atoms' and residues' indices name
  elements: string[]
  atomNames: string[]
  residueNames: string[]
  insertions: string[]
  altLocs: string[]
  tallies: Tallies
  // The arrival it's a snapshot of, or null for a structure built whole
  arrival: Arrival | null
  // Whether all of it has arrived, as a structure built whole has
  whole: boolean
}

// What a builder holds that's new since its last batch, in the rows the whole structure gives it: the atoms, residues,
// runs and chains added, each column a copy of its new rows, each residue's first atom without the count after the
// last; the atoms among them of another chemical form; the names each table gained; and the title, the models and the
// tallies so far. The last batch alone has an end: every residue's secondary structure where the end of the file
// changed a residue an earlier batch gave, and the tensors, which are joined to the atoms once the file is read
export interface StructureBatch {
  title: string
  models: number[]
  atoms: Atoms
  residues: Residues
  runs: Runs
  chains: Pick<Chains, 'count' | 'name' | 'model'>
  forms: Forms
  elements: string[]
  atomNames: string[]
  residueNames: string[]
  insertions: string[]
  altLocs: string[]
  tallies: Tallies
  end: { structure: Uint8Array | null; tensors: Tensors | null } | null
}

// One atom as the builder takes it, with what its residue, run and chain are known by
export interface AtomRecord {
  x: number
  y: number
  z: number
  element: string
  atomName: string
  altLoc: string
  occupancy: number
  bFactor: number
  model: number
  // The author's chain, which a chain is named by, and the label chain, which the run is
  chain: string
  labelChain: string
  residueName: string
  residueNumber: number
  insertion: string
  hydrogen: boolean
  water: boolean
  firstConformation: boolean
  polymer: boolean
}

// The atoms a builder makes room for when it's given no count, and how much each column grows by as it fills: by half
// again, so that the copies a column is grown through add up to less than three times its final length
const startingCapacity = 1024
const growth = 1.5

// How much room past what's expected of the whole a column that has to grow makes, as the expectation is an estimate
const expectedMargin = 1.05

// The room a column that's short grows to: a margin past what the whole is expected to hold, where that's more than it
// needs, and otherwise half again as much as it had, at least what it needs, so that it grows once where the whole's
// size is known and by few steps where it isn't
export function roomToGrow(needed: number, expected: number, had: number) {
  if (expected > needed) return Math.ceil(expected * expectedMargin)
  return Math.max(needed, Math.ceil(had * growth))
}

// A residue has about eight atoms in a protein, and one in a water
const atomsPerResidue = 8

// The most distinct values each index type holds
const byteLimit = 1 << 8
const shortLimit = 1 << 16

type Column = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array

// A column copied into a longer one of the same type
function resized<T extends Column>(column: T, length: number, make: (length: number) => T): T {
  const next = make(length)
  next.set(column)
  return next
}

// Strings by their places in a table of them, up to a limit their index type sets
class Names {
  readonly table: string[] = []
  private readonly places = new Map<string, number>()
  private readonly limit: number
  private readonly what: string

  constructor(what: string, limit: number, first?: string) {
    this.what = what
    this.limit = limit
    if (first !== undefined) this.place(first)
  }

  place(name: string): number {
    let place = this.places.get(name)
    if (place === undefined) {
      place = this.table.length
      if (place >= this.limit) throw new Error(`The file has more than ${this.limit} ${this.what}`)
      this.table.push(name)
      this.places.set(name, place)
    }
    return place
  }

  // Places names another table gained after the ones this one has, in their order
  placeAll(names: readonly string[]) {
    for (const name of names) this.place(name)
  }
}

// Writes a structure's tables, in the file's order, either atom by atom or a batch at a time. Atom by atom, it opens a
// residue where the model, the chain, the label chain, the residue's number or its insertion code changes, and a run
// where the model, the chain or the label chain does, and files each run under the chain of its model and name; what
// it holds can be taken from it in batches, each at a residue's start, and appended to another builder, which gives a
// snapshot of what it holds after each. Its columns grow as they fill and are trimmed to their lengths when it
// finishes
export class StructureBuilder {
  private atomCapacity: number
  private atomRows = 0
  private positions: Float32Array
  private element: Uint8Array
  private bFactor: Float32Array
  private occupancy: Float32Array
  private flags: Uint8Array
  private altLoc: Uint8Array
  private atomName: Uint16Array
  private atomResidue: Uint32Array

  private residueCapacity: number
  private residueRows = 0
  private residueRun: Uint32Array
  private residueNumber: Int32Array
  private residueInsertion: Uint8Array
  private residueName: Uint16Array
  private residueStructure: Uint8Array
  private residueFirstAtom: Uint32Array

  private readonly runChain: number[] = []
  private readonly runLabel: string[] = []
  private readonly runFirstResidue: number[] = []
  private readonly runFirstAtom: number[] = []

  private readonly chainName: string[] = []
  private readonly chainModel: number[] = []
  private readonly chainRows = new Map<string, number>()

  private tensors: Tensors | null = null
  private readonly tensorAtoms: number[] = []
  private readonly tensorValues: number[] = []
  private readonly formAtoms: number[] = []
  private readonly formNames: number[] = []

  private readonly models: number[] = []
  private readonly elements = new Names('distinct elements', byteLimit)
  private readonly atomNames = new Names('distinct atom names', shortLimit)
  private readonly residueNames = new Names('distinct residue names', shortLimit)
  private readonly insertions = new Names('distinct insertion codes', byteLimit, '')
  private readonly altLocs = new Names('distinct alternate IDs', byteLimit, '')

  private readonly tallies: Tallies = {
    alternates: 0,
    waters: 0,
    hydrogens: 0,
    ligands: 0,
    later: 0,
    defaults: { atoms: 0, waters: 0, hydrogens: 0, alternates: 0 },
  }

  // What the open residue and run are known by
  private openModel = NaN
  private openChain = ''
  private openLabel = ''
  private openNumber = NaN
  private openInsertion = ''
  private openName = ''
  private finished = false

  // How far the batches taken so far reach in each table, what's asked of the next residue's start, and whether the
  // end of the file changed the secondary structure of a residue a batch already gave
  private readonly taken = { atoms: 0, residues: 0, runs: 0, chains: 0, forms: 0, names: [0, 0, 0, 1, 1] }
  private atResidue: (() => void) | null = null
  private retold = false

  // Appended to batch by batch: the arrival its snapshots share, the title so far, and whether the last has come
  private arrival: Arrival | null = null
  private title = ''
  private whole = false

  // Room for a count of atoms, which it grows beyond as it must
  constructor(capacity = startingCapacity) {
    this.atomCapacity = Math.max(capacity, 1)
    this.positions = new Float32Array(this.atomCapacity * 3)
    this.element = new Uint8Array(this.atomCapacity)
    this.bFactor = new Float32Array(this.atomCapacity)
    this.occupancy = new Float32Array(this.atomCapacity)
    this.flags = new Uint8Array(this.atomCapacity)
    this.altLoc = new Uint8Array(this.atomCapacity)
    this.atomName = new Uint16Array(this.atomCapacity)
    this.atomResidue = new Uint32Array(this.atomCapacity)
    this.residueCapacity = Math.max(Math.ceil(this.atomCapacity / atomsPerResidue), 1)
    this.residueRun = new Uint32Array(this.residueCapacity)
    this.residueNumber = new Int32Array(this.residueCapacity)
    this.residueInsertion = new Uint8Array(this.residueCapacity)
    this.residueName = new Uint16Array(this.residueCapacity)
    this.residueStructure = new Uint8Array(this.residueCapacity)
    this.residueFirstAtom = new Uint32Array(this.residueCapacity + 1)
  }

  // How many atoms and residues it holds so far, the last residue the one the last atom went into
  get atomCount() {
    return this.atomRows
  }

  get residueCount() {
    return this.residueRows
  }

  // The row of the chain the last atom went into
  get chainRow() {
    return this.runChain.at(-1) ?? -1
  }

  // How many residues the batches taken so far hold, every one of which has all its atoms
  get residuesTaken() {
    return this.taken.residues
  }

  // Makes room for a count of atoms all told, where it has less, so that a structure whose size is learnt as it's read
  // grows once rather than by steps. A finished builder, whose columns are the structure's, takes no more
  reserve(capacity: number) {
    if (this.finished) return
    if (capacity > this.atomCapacity) this.growAtoms(capacity)
    const residues = Math.ceil(capacity / atomsPerResidue)
    if (residues > this.residueCapacity) this.growResidues(residues)
  }

  // Has a handler called once, at the next residue's start, before its first atom goes in, where every atom added is
  // in a residue that has all its atoms
  callAtNextResidue(handler: () => void) {
    this.atResidue = handler
  }

  // Adds an atom after the last, and gives its row
  add(atom: AtomRecord): number {
    if (this.finished) throw new Error('The structure is already finished')
    const row = this.atomRows
    const { model, chain, labelChain, residueNumber, insertion, residueName } = atom
    const run = row === 0 || model !== this.openModel || chain !== this.openChain || labelChain !== this.openLabel
    const residue = run || !Object.is(residueNumber, this.openNumber) || insertion !== this.openInsertion
    if (residue && this.atResidue) {
      const handler = this.atResidue
      this.atResidue = null
      handler()
    }
    if (row === this.atomCapacity) this.growAtoms(Math.ceil(this.atomCapacity * growth))

    if (this.models.at(-1) !== model && !this.models.includes(model)) this.models.push(model)
    if (run) this.openRun(model, chain, labelChain, row)
    if (residue) this.openResidue(residueNumber, insertion, residueName, row)
    else if (residueName !== this.openName) {
      this.formAtoms.push(row)
      this.formNames.push(this.residueNames.place(residueName))
    }

    this.positions[row * 3] = atom.x
    this.positions[row * 3 + 1] = atom.y
    this.positions[row * 3 + 2] = atom.z
    this.element[row] = this.elements.place(atom.element)
    this.bFactor[row] = atom.bFactor
    this.occupancy[row] = atom.occupancy
    this.flags[row] =
      (atom.hydrogen ? hydrogenFlag : 0) |
      (atom.water ? waterFlag : 0) |
      (atom.firstConformation ? firstConformationFlag : 0) |
      (atom.polymer ? polymerFlag : 0)
    this.altLoc[row] = atom.altLoc === '' ? 0 : this.altLocs.place(atom.altLoc)
    this.atomName[row] = this.atomNames.place(atom.atomName)
    this.atomResidue[row] = this.residueRows - 1
    this.atomRows = row + 1
    this.tally(atom)
    return row
  }

  // Sets a residue's secondary structure, which a residue starts without
  setSecondaryStructure(residue: number, structure: SecondaryStructure) {
    const index = secondaryStructures.indexOf(structure)
    if (residue < this.taken.residues && this.residueStructure[residue] !== index) this.retold = true
    this.residueStructure[residue] = index
  }

  // Gives an atom its anisotropic tensor, six values in the order Tensors keeps. Atoms are given theirs in the order of
  // their rows
  addTensor(atom: number, u: ArrayLike<number>) {
    const last = this.tensorAtoms.at(-1)
    if (atom >= this.atomRows || (last !== undefined && atom <= last)) {
      throw new Error('Tensors are given to atoms already added, in the order of their rows')
    }
    this.tensorAtoms.push(atom)
    for (let k = 0; k < 6; k++) this.tensorValues.push(u[k])
  }

  // What's been added since the last batch, at a residue's start or once every atom is added. The last batch, taken
  // once the file is read and its tensors joined, carries the end
  takeBatch(title: string, last = false): StructureBatch {
    const { taken } = this
    const atoms = this.atomRows
    const residues = this.residueRows
    const runs = this.runChain.length
    const chains = this.chainName.length
    const from = taken.atoms
    const fromResidue = taken.residues
    const formFrom = taken.forms
    const tables = [this.elements, this.atomNames, this.residueNames, this.insertions, this.altLocs]
    const gained = tables.map((table, i) => table.table.slice(taken.names[i]))
    const batch: StructureBatch = {
      title,
      models: [...this.models],
      atoms: {
        count: atoms - from,
        positions: this.positions.slice(from * 3, atoms * 3),
        element: this.element.slice(from, atoms),
        bFactor: this.bFactor.slice(from, atoms),
        occupancy: this.occupancy.slice(from, atoms),
        flags: this.flags.slice(from, atoms),
        altLoc: this.altLoc.slice(from, atoms),
        name: this.atomName.slice(from, atoms),
        residue: this.atomResidue.slice(from, atoms),
      },
      residues: {
        count: residues - fromResidue,
        run: this.residueRun.slice(fromResidue, residues),
        number: this.residueNumber.slice(fromResidue, residues),
        insertion: this.residueInsertion.slice(fromResidue, residues),
        name: this.residueName.slice(fromResidue, residues),
        structure: this.residueStructure.slice(fromResidue, residues),
        firstAtom: this.residueFirstAtom.slice(fromResidue, residues),
      },
      runs: {
        count: runs - taken.runs,
        chain: Uint32Array.from(this.runChain.slice(taken.runs)),
        label: this.runLabel.slice(taken.runs),
        firstResidue: Uint32Array.from(this.runFirstResidue.slice(taken.runs)),
        firstAtom: Uint32Array.from(this.runFirstAtom.slice(taken.runs)),
      },
      chains: {
        count: chains - taken.chains,
        name: this.chainName.slice(taken.chains),
        model: Int32Array.from(this.chainModel.slice(taken.chains)),
      },
      forms: {
        atoms: Uint32Array.from(this.formAtoms.slice(formFrom)),
        names: Uint16Array.from(this.formNames.slice(formFrom)),
      },
      elements: gained[0],
      atomNames: gained[1],
      residueNames: gained[2],
      insertions: gained[3],
      altLocs: gained[4],
      tallies: copyTallies(this.tallies),
      end: last
        ? { structure: this.retold ? this.residueStructure.slice(0, residues) : null, tensors: this.tensorsHeld() }
        : null,
    }
    taken.atoms = atoms
    taken.residues = residues
    taken.runs = runs
    taken.chains = chains
    taken.forms = this.formAtoms.length
    taken.names = tables.map((table) => table.table.length)
    return batch
  }

  // Appends a batch taken from another builder, which takes the rows after this one's, growing the columns where
  // they're short: to the atoms the whole is expected to hold where that's known, and otherwise by half again
  append(batch: StructureBatch, expectedAtoms = 0) {
    if (this.finished || this.whole) throw new Error('The structure is already whole')
    this.arrival ??= { expectedAtoms }
    this.arrival.expectedAtoms = Math.max(expectedAtoms, this.atomRows + batch.atoms.count)
    const { atoms, residues, runs, chains, forms } = batch
    const atomEnd = this.atomRows + atoms.count
    if (atomEnd > this.atomCapacity) this.growAtoms(roomToGrow(atomEnd, expectedAtoms, this.atomCapacity))
    const residueEnd = this.residueRows + residues.count
    if (residueEnd > this.residueCapacity) {
      const expectedResidues = Math.ceil((residueEnd * Math.max(expectedAtoms, atomEnd)) / Math.max(atomEnd, 1))
      this.growResidues(roomToGrow(residueEnd, expectedResidues, this.residueCapacity))
    }
    const at = this.atomRows
    this.positions.set(atoms.positions, at * 3)
    this.element.set(atoms.element, at)
    this.bFactor.set(atoms.bFactor, at)
    this.occupancy.set(atoms.occupancy, at)
    this.flags.set(atoms.flags, at)
    this.altLoc.set(atoms.altLoc, at)
    this.atomName.set(atoms.name, at)
    this.atomResidue.set(atoms.residue, at)
    const residueAt = this.residueRows
    this.residueRun.set(residues.run, residueAt)
    this.residueNumber.set(residues.number, residueAt)
    this.residueInsertion.set(residues.insertion, residueAt)
    this.residueName.set(residues.name, residueAt)
    this.residueStructure.set(residues.structure, residueAt)
    this.residueFirstAtom.set(residues.firstAtom, residueAt)
    for (let run = 0; run < runs.count; run++) {
      this.runChain.push(runs.chain[run])
      this.runLabel.push(runs.label[run])
      this.runFirstResidue.push(runs.firstResidue[run])
      this.runFirstAtom.push(runs.firstAtom[run])
    }
    for (let chain = 0; chain < chains.count; chain++) {
      this.chainRows.set(`${chains.model[chain]} ${chains.name[chain]}`, this.chainName.length)
      this.chainName.push(chains.name[chain])
      this.chainModel.push(chains.model[chain])
    }
    for (let k = 0; k < forms.atoms.length; k++) {
      this.formAtoms.push(forms.atoms[k])
      this.formNames.push(forms.names[k])
    }
    this.elements.placeAll(batch.elements)
    this.atomNames.placeAll(batch.atomNames)
    this.residueNames.placeAll(batch.residueNames)
    this.insertions.placeAll(batch.insertions)
    this.altLocs.placeAll(batch.altLocs)
    this.models.splice(0, this.models.length, ...batch.models)
    Object.assign(this.tallies, copyTallies(batch.tallies))
    this.title = batch.title
    this.atomRows = atomEnd
    this.residueRows = residueEnd
    if (batch.end) {
      if (batch.end.structure) this.residueStructure = batch.end.structure
      this.tensors = batch.end.tensors
      this.whole = true
    }
  }

  // The structure as it stands after the batches appended so far, its columns views of the builder's own, which
  // later batches add rows after but never change within them, so that each snapshot stays as it was given
  snapshot(): Structure {
    const atoms = this.atomRows
    const residues = this.residueRows
    // The count after the last residue is the next one's first atom, which a later batch writes to the same place
    this.residueFirstAtom[residues] = atoms
    return {
      ...this.tables(this.title),
      atoms: {
        count: atoms,
        positions: this.positions.subarray(0, atoms * 3),
        element: this.element.subarray(0, atoms),
        bFactor: this.bFactor.subarray(0, atoms),
        occupancy: this.occupancy.subarray(0, atoms),
        flags: this.flags.subarray(0, atoms),
        altLoc: this.altLoc.subarray(0, atoms),
        name: this.atomName.subarray(0, atoms),
        residue: this.atomResidue.subarray(0, atoms),
      },
      residues: {
        count: residues,
        run: this.residueRun.subarray(0, residues),
        number: this.residueNumber.subarray(0, residues),
        insertion: this.residueInsertion.subarray(0, residues),
        name: this.residueName.subarray(0, residues),
        structure: this.residueStructure.subarray(0, residues),
        firstAtom: this.residueFirstAtom.subarray(0, residues + 1),
      },
      arrival: this.arrival,
      whole: this.whole || this.arrival === null,
    }
  }

  // The structure, with every column trimmed to its length, one at a time, so that a large structure is held twice
  // over only a column at a time. The builder takes no more atoms after it
  finish(title = ''): Structure {
    this.finished = true
    const atoms = this.atomRows
    const residues = this.residueRows
    this.residueFirstAtom[residues] = atoms

    this.positions = this.positions.slice(0, atoms * 3)
    this.element = this.element.slice(0, atoms)
    this.bFactor = this.bFactor.slice(0, atoms)
    this.occupancy = this.occupancy.slice(0, atoms)
    this.flags = this.flags.slice(0, atoms)
    this.altLoc = this.altLoc.slice(0, atoms)
    this.atomName = this.atomName.slice(0, atoms)
    this.atomResidue = this.atomResidue.slice(0, atoms)
    this.residueRun = this.residueRun.slice(0, residues)
    this.residueNumber = this.residueNumber.slice(0, residues)
    this.residueInsertion = this.residueInsertion.slice(0, residues)
    this.residueName = this.residueName.slice(0, residues)
    this.residueStructure = this.residueStructure.slice(0, residues)
    this.residueFirstAtom = this.residueFirstAtom.slice(0, residues + 1)

    return {
      ...this.tables(title),
      atoms: {
        count: atoms,
        positions: this.positions,
        element: this.element,
        bFactor: this.bFactor,
        occupancy: this.occupancy,
        flags: this.flags,
        altLoc: this.altLoc,
        name: this.atomName,
        residue: this.atomResidue,
      },
      residues: {
        count: residues,
        run: this.residueRun,
        number: this.residueNumber,
        insertion: this.residueInsertion,
        name: this.residueName,
        structure: this.residueStructure,
        firstAtom: this.residueFirstAtom,
      },
      arrival: null,
      whole: true,
    }
  }

  // Everything but the atoms' and the residues' columns, made afresh: the runs, each chain's runs gathered in the
  // file's order, the tensors, the forms, the names and the tallies
  private tables(title: string): Omit<Structure, 'atoms' | 'residues' | 'arrival' | 'whole'> {
    const atoms = this.atomRows
    const residues = this.residueRows
    const runs = this.runChain.length
    const chains = this.chainName.length
    const firstRun = new Uint32Array(chains + 1)
    for (const chain of this.runChain) firstRun[chain + 1]++
    for (let chain = 0; chain < chains; chain++) firstRun[chain + 1] += firstRun[chain]
    const filled = firstRun.slice(0, chains)
    const chainRuns = new Uint32Array(runs)
    this.runChain.forEach((chain, run) => {
      chainRuns[filled[chain]++] = run
    })
    return {
      title,
      models: [...this.models],
      runs: {
        count: runs,
        chain: Uint32Array.from(this.runChain),
        label: [...this.runLabel],
        firstResidue: Uint32Array.from([...this.runFirstResidue, residues]),
        firstAtom: Uint32Array.from([...this.runFirstAtom, atoms]),
      },
      chains: {
        count: chains,
        name: [...this.chainName],
        model: Int32Array.from(this.chainModel),
        runs: chainRuns,
        firstRun,
      },
      tensors: this.tensorsHeld(),
      forms:
        this.formAtoms.length > 0 ? { atoms: Uint32Array.from(this.formAtoms), names: Uint16Array.from(this.formNames) } : null,
      elements: [...this.elements.table],
      atomNames: [...this.atomNames.table],
      residueNames: [...this.residueNames.table],
      insertions: [...this.insertions.table],
      altLocs: [...this.altLocs.table],
      tallies: copyTallies(this.tallies),
    }
  }

  // The tensors given atom by atom, or appended with the last batch
  private tensorsHeld(): Tensors | null {
    if (this.tensorAtoms.length > 0) {
      return { atoms: Uint32Array.from(this.tensorAtoms), values: Float32Array.from(this.tensorValues) }
    }
    return this.tensors
  }

  private openRun(model: number, chain: string, labelChain: string, row: number) {
    const key = `${model} ${chain}`
    let chainRow = this.chainRows.get(key)
    if (chainRow === undefined) {
      chainRow = this.chainName.length
      this.chainRows.set(key, chainRow)
      this.chainName.push(chain)
      this.chainModel.push(model)
    }
    this.runChain.push(chainRow)
    this.runLabel.push(labelChain)
    this.runFirstResidue.push(this.residueRows)
    this.runFirstAtom.push(row)
    this.openModel = model
    this.openChain = chain
    this.openLabel = labelChain
  }

  private openResidue(number: number, insertion: string, name: string, row: number) {
    const residue = this.residueRows
    if (residue === this.residueCapacity) this.growResidues(Math.ceil(this.residueCapacity * growth))
    this.residueRun[residue] = this.runChain.length - 1
    this.residueNumber[residue] = number
    this.residueInsertion[residue] = this.insertions.place(insertion)
    this.residueName[residue] = this.residueNames.place(name)
    this.residueFirstAtom[residue] = row
    this.residueRows = residue + 1
    this.openNumber = number
    this.openInsertion = insertion
    this.openName = name
  }

  private tally({ altLoc, water, hydrogen, firstConformation, polymer, model }: AtomRecord) {
    const { tallies } = this
    if (altLoc !== '') tallies.alternates++
    if (water) tallies.waters++
    if (hydrogen) tallies.hydrogens++
    if (firstConformation && !polymer && !water) tallies.ligands++
    if (!firstConformation) tallies.later++
    // The atoms are in the file's order, so the first atom's model is the first model
    if (firstConformation && model === this.models[0]) {
      const { defaults } = tallies
      defaults.atoms++
      if (water) defaults.waters++
      if (hydrogen) defaults.hydrogens++
      if (altLoc !== '') defaults.alternates++
    }
  }

  private growAtoms(capacity: number) {
    this.positions = resized(this.positions, capacity * 3, (length) => new Float32Array(length))
    this.element = resized(this.element, capacity, (length) => new Uint8Array(length))
    this.bFactor = resized(this.bFactor, capacity, (length) => new Float32Array(length))
    this.occupancy = resized(this.occupancy, capacity, (length) => new Float32Array(length))
    this.flags = resized(this.flags, capacity, (length) => new Uint8Array(length))
    this.altLoc = resized(this.altLoc, capacity, (length) => new Uint8Array(length))
    this.atomName = resized(this.atomName, capacity, (length) => new Uint16Array(length))
    this.atomResidue = resized(this.atomResidue, capacity, (length) => new Uint32Array(length))
    this.atomCapacity = capacity
  }

  private growResidues(capacity: number) {
    this.residueRun = resized(this.residueRun, capacity, (length) => new Uint32Array(length))
    this.residueNumber = resized(this.residueNumber, capacity, (length) => new Int32Array(length))
    this.residueInsertion = resized(this.residueInsertion, capacity, (length) => new Uint8Array(length))
    this.residueName = resized(this.residueName, capacity, (length) => new Uint16Array(length))
    this.residueStructure = resized(this.residueStructure, capacity, (length) => new Uint8Array(length))
    this.residueFirstAtom = resized(this.residueFirstAtom, capacity + 1, (length) => new Uint32Array(length))
    this.residueCapacity = capacity
  }
}

// A copy of tallies, which a batch and a snapshot each keep apart from the builder's own
function copyTallies(tallies: Tallies): Tallies {
  return { ...tallies, defaults: { ...tallies.defaults } }
}

// A structure with no atoms, which the page holds before an entry loads
export const emptyStructure: Structure = new StructureBuilder(1).finish()

// The columns of a structure that say where its atoms are, what they are and what holds them, without their names:
// what merging the levels and working out burial read
export interface AtomPlaces {
  models: number[]
  elements: string[]
  atoms: Pick<Atoms, 'count' | 'positions' | 'element' | 'flags' | 'residue'>
  residues: Pick<Residues, 'run'>
  runs: Pick<Runs, 'chain'>
  chains: Pick<Chains, 'model'>
}

// A copy of those columns, which outlives the structure's own being handed on
export function copyPlaces({ models, elements, atoms, residues, runs, chains }: AtomPlaces): AtomPlaces {
  return {
    models: [...models],
    elements: [...elements],
    atoms: {
      count: atoms.count,
      positions: atoms.positions.slice(),
      element: atoms.element.slice(),
      flags: atoms.flags.slice(),
      residue: atoms.residue.slice(),
    },
    residues: { run: residues.run.slice() },
    runs: { chain: runs.chain.slice() },
    chains: { model: chains.model.slice() },
  }
}

// The row of an atom's chain
export function chainOf({ atoms, residues, runs }: Pick<AtomPlaces, 'atoms' | 'residues' | 'runs'>, atom: number) {
  return runs.chain[residues.run[atoms.residue[atom]]]
}

// The number of an atom's model
export function modelOf(structure: Pick<AtomPlaces, 'atoms' | 'residues' | 'runs' | 'chains'>, atom: number) {
  return structure.chains.model[chainOf(structure, atom)]
}

// Which atoms are shown: with or without the hydrogens and the waters, each residue's first conformation or every one,
// and one model, by its number, or every model, for null
export interface ShownChoice {
  hydrogens: boolean
  waters: boolean
  conformations: 'first' | 'all'
  model: number | null
}

// Whether an atom, by its flags and its model's number, is shown under a choice
export function shownBy(flags: number, model: number, choice: ShownChoice) {
  return (
    (choice.hydrogens || (flags & hydrogenFlag) === 0) &&
    (choice.waters || (flags & waterFlag) === 0) &&
    (choice.conformations === 'all' || (flags & firstConformationFlag) !== 0) &&
    (choice.model === null || model === choice.model)
  )
}

export function sameChoice(a: ShownChoice, b: ShownChoice) {
  return a.hydrogens === b.hydrogens && a.waters === b.waters && a.conformations === b.conformations && a.model === b.model
}

export function elementOf({ atoms, elements }: Structure, atom: number) {
  return elements[atoms.element[atom]]
}

export function atomNameOf({ atoms, atomNames }: Structure, atom: number) {
  return atomNames[atoms.name[atom]]
}

// An atom's alternate ID, or empty
export function altLocOf({ atoms, altLocs }: Structure, atom: number) {
  return altLocs[atoms.altLoc[atom]]
}

// A residue's insertion code, or empty
export function insertionOf({ residues, insertions }: Structure, residue: number) {
  return insertions[residues.insertion[residue]]
}

// The name of the residue an atom is in, as that atom gives it
export function residueNameOf({ atoms, residues, residueNames, forms }: Structure, atom: number) {
  const form = forms ? search(forms.atoms, atom) : -1
  return residueNames[forms && form >= 0 ? forms.names[form] : residues.name[atoms.residue[atom]]]
}

// Where an atom's tensor starts among the tensors' values, or -1 for an atom without one
export function tensorOf({ tensors }: Structure, atom: number) {
  const place = tensors ? search(tensors.atoms, atom) : -1
  return place < 0 ? -1 : place * 6
}

// A value's place in an ascending list, or -1 where it isn't there
function search(sorted: Uint32Array, value: number) {
  let low = 0
  let high = sorted.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const found = sorted[middle]
    if (found === value) return middle
    if (found < value) low = middle + 1
    else high = middle - 1
  }
  return -1
}

// Names a residue by its chain, number and insertion code, but not its model, so that an inserted residue such as 52A
// stays apart from 52, and a residue of one model meets the same residue in another
export function residueKey(structure: Structure, residue: number) {
  const { residues, runs, chains } = structure
  return `${chains.name[runs.chain[residues.run[residue]]]} ${residues.number[residue]} ${insertionOf(structure, residue)}`
}

// Atoms of a structure chosen by a test: whether each is chosen, by row, and the chosen rows in order, with how many
export interface ShownAtoms {
  mask: Uint8Array
  rows: Uint32Array
  count: number
}

export function selectAtoms(structure: { atoms: { count: number } }, keep: (atom: number) => boolean): ShownAtoms {
  const { count } = structure.atoms
  const mask = new Uint8Array(count)
  let kept = 0
  for (let atom = 0; atom < count; atom++) {
    if (!keep(atom)) continue
    mask[atom] = 1
    kept++
  }
  const rows = new Uint32Array(kept)
  for (let atom = 0, i = 0; i < kept; atom++) if (mask[atom]) rows[i++] = atom
  return { mask, rows, count: kept }
}

// Each structure's atoms at the defaults, kept beside its tables, which are never changed
const defaultSets = new WeakMap<AtomPlaces, Uint32Array>()

// The rows of the atoms of the structure's first model, each residue in its first conformation: the ones Models and
// Alternates show at their defaults, which the framing and the entry's spreads come from, so that showing more models
// or conformations moves neither
export function defaultAtoms(structure: AtomPlaces): Uint32Array {
  let rows = defaultSets.get(structure)
  if (!rows) {
    const { flags } = structure.atoms
    const firstModel = structure.models[0]
    rows = selectAtoms(structure, (atom) => (flags[atom] & firstConformationFlag) !== 0 && modelOf(structure, atom) === firstModel).rows
    defaultSets.set(structure, rows)
  }
  return rows
}
