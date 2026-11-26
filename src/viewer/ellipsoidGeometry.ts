import {
  BufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Vector3Like,
} from 'three'

// The geometry a set of ellipsoids is drawn from: one quad, drawn once for each, with each one's centre, covariance,
// paint and piece as the instance's attributes. A pool holds a fixed number of them in slots, and the pieces drawn at
// its level are written into stretches of slots and taken out again as they come and go, each change sent to the GPU
// as the ranges of slots it wrote, so that nothing is built again for a change of what's drawn

// How many standard deviations out an ellipsoid's surface is, and so the edge a Gaussian is drawn to: an ellipsoid
// reaches twice the root of its covariance along any direction
export const surfaceDeviations = 2

// The instances' attributes by name: the centre, the covariance's xx, xy and xz, its yy, yz and zz, the colour and
// alpha the atoms are painted with, and the index of the piece the instance belongs to
export const ellipsoidAttributes = {
  centre: 'center',
  shapeA: 'covarianceA',
  shapeB: 'covarianceB',
  paint: 'paint',
  piece: 'piece',
}

// The floats of a covariance, in the order [xx, xy, xz, yy, yz, zz]
export const covarianceSize = 6
// The bytes of an ellipsoid's paint: its colour's red, green and blue, and its alpha
export const paintSize = 4
// The floats of an instance's shape in its slot: its centre's x, y and z, then its covariance
export const shapeSize = 3 + covarianceSize

// The piece that is no piece, which every free slot points at, and which is never drawn
export const noPiece = 0

// A round ellipsoid's covariance, for a standard deviation alike along every axis, written at an offset
export function writeRound(target: Float32Array, offset: number, deviation: number) {
  const variance = deviation * deviation
  target[offset] = variance
  target[offset + 1] = 0
  target[offset + 2] = 0
  target[offset + 3] = variance
  target[offset + 4] = 0
  target[offset + 5] = variance
}

// How far an ellipsoid with a covariance at an offset reaches from its centre, or a little more: twice the root of its
// largest eigenvalue, taken at the largest of the rows' sums of magnitudes, which is no smaller than that eigenvalue,
// and is it for a covariance with no cross terms
export function ellipsoidExtent(covariances: ArrayLike<number>, at: number) {
  const xx = Math.abs(covariances[at])
  const xy = Math.abs(covariances[at + 1])
  const xz = Math.abs(covariances[at + 2])
  const yy = Math.abs(covariances[at + 3])
  const yz = Math.abs(covariances[at + 4])
  const zz = Math.abs(covariances[at + 5])
  return surfaceDeviations * Math.sqrt(Math.max(xx + xy + xz, xy + yy + yz, xz + yz + zz))
}

// How far from the structure's centre any of the ellipsoids at centres, x, y, z triples, with covariances, six floats
// each, reaches, or a little more: each one's centre's distance from it, and the farthest its surface reaches from its
// own centre
export function ellipsoidsReach(centers: Float32Array, covariances: Float32Array, center: Vector3Like) {
  let reach = 0
  for (let i = 0; i < centers.length / 3; i++) {
    const centre = Math.hypot(centers[i * 3] - center.x, centers[i * 3 + 1] - center.y, centers[i * 3 + 2] - center.z)
    reach = Math.max(reach, centre + ellipsoidExtent(covariances, i * covarianceSize))
  }
  return reach
}

// A range of a buffer's elements for the renderer to send, as three's update ranges hold them
interface UpdateRange {
  start: number
  count: number
}

// What a buffer's ranges are handed to: an attribute's or an interleaved buffer's update ranges, and the version a
// write moves on, which has the renderer send them at its next draw
interface Uploaded {
  updateRanges: UpdateRange[]
  needsUpdate: boolean
}

// Moves the stretches from one place in lists of starts and ends to another, in place, the lists growing or shrinking
// to fit, so that nothing is allocated once they've grown to the most they hold
function moveStretches(starts: number[], ends: number[], from: number, to: number) {
  const length = starts.length
  if (to > from) {
    for (let i = length - 1; i >= from; i--) {
      starts[i + to - from] = starts[i]
      ends[i + to - from] = ends[i]
    }
  } else if (to < from) {
    for (let i = from; i < length; i++) {
      starts[i + to - from] = starts[i]
      ends[i + to - from] = ends[i]
    }
    starts.length = length + to - from
    ends.length = length + to - from
  }
}

// Inserts the stretch [start, end) into stretches kept sorted and apart, as pairs of starts and ends, joining every one
// it overlaps or touches
function insertStretch(starts: number[], ends: number[], start: number, end: number) {
  let at = 0
  while (at < starts.length && ends[at] < start) at++
  let last = at
  while (last < starts.length && starts[last] <= end) last++
  if (last > at) {
    start = Math.min(start, starts[at])
    end = Math.max(end, ends[last - 1])
  }
  moveStretches(starts, ends, last, at + 1)
  starts[at] = start
  ends[at] = end
}

// The slots of one buffer that were written and not yet sent. three sends a buffer's update ranges at the first draw
// after its version moves on and then clears them, and a buffer not drawn keeps them, so ranges handed over before are
// known to be sent once the buffer's list is empty, and are otherwise handed over again with the new ones. The range
// objects are kept and reused, so that a frame that sends what it wrote allocates nothing once they're made
class WrittenSlots {
  // The stretches written since the last hand-over, and those handed over last, in slots
  private readonly freshStarts: number[] = []
  private readonly freshEnds: number[] = []
  private readonly heldStarts: number[] = []
  private readonly heldEnds: number[] = []
  private readonly ranges: UpdateRange[] = []
  private readonly target: Uploaded
  // The buffer's elements in a slot
  private readonly stride: number

  constructor(target: Uploaded, stride: number) {
    this.target = target
    this.stride = stride
  }

  add(slot: number, count: number) {
    if (count > 0) insertStretch(this.freshStarts, this.freshEnds, slot, slot + count)
  }

  // Hands the buffer the ranges it hasn't sent, in its own elements, and has it send them
  send() {
    if (this.freshStarts.length === 0) return
    const { target, stride } = this
    if (target.updateRanges.length === 0) {
      this.heldStarts.length = 0
      this.heldEnds.length = 0
    }
    for (let i = 0; i < this.freshStarts.length; i++) {
      insertStretch(this.heldStarts, this.heldEnds, this.freshStarts[i], this.freshEnds[i])
    }
    this.freshStarts.length = 0
    this.freshEnds.length = 0
    target.updateRanges.length = 0
    for (let i = 0; i < this.heldStarts.length; i++) {
      const range = (this.ranges[i] ??= { start: 0, count: 0 })
      range.start = this.heldStarts[i] * stride
      range.count = (this.heldEnds[i] - this.heldStarts[i]) * stride
      target.updateRanges.push(range)
    }
    target.needsUpdate = true
  }
}

// A fixed number of slots for ellipsoids, each holding one instance's shape, paint and piece, which a piece fills as
// one stretch of slots. The slots past the last one in use aren't drawn, and a slot between that a piece left points
// at no piece, which the vertex stage never draws
export class Pool {
  readonly geometry = new InstancedBufferGeometry()
  readonly capacity: number
  // Each slot's centre and covariance, its paint, four bytes that clamp and round what's written to them, and its
  // piece, as the GPU's copies are written from
  readonly shapes: Float32Array
  readonly paint: Uint8ClampedArray
  readonly pieces: Uint32Array
  // How many slots from the first are drawn: the end of the last stretch a piece holds
  extent = 0

  // Each piece's first slot, or -1 while it holds none, how many it holds, and the last frame it was seen in
  private first: Int32Array
  private held: Uint32Array
  private seen: Float64Array
  // The stretches of free slots below the extent, sorted and apart, as starts and ends
  private readonly freeStarts: number[] = []
  private readonly freeEnds: number[] = []
  private readonly shapesWritten: WrittenSlots
  private readonly paintWritten: WrittenSlots
  private readonly piecesWritten: WrittenSlots

  // A pool of a number of slots, for pieces numbered below a count
  constructor(capacity: number, pieceCount: number) {
    this.capacity = capacity
    this.first = new Int32Array(pieceCount).fill(-1)
    this.held = new Uint32Array(pieceCount)
    this.seen = new Float64Array(pieceCount).fill(-Infinity)
    const { geometry } = this
    // The quad's corners, which the vertex stage places on screen
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    // Each kind of value is one buffer, its attributes interleaved in it, as a draw takes only so many buffers
    this.shapes = new Float32Array(capacity * shapeSize)
    const shapes = new InstancedInterleavedBuffer(this.shapes, shapeSize)
    geometry.setAttribute(ellipsoidAttributes.centre, new InterleavedBufferAttribute(shapes, 3, 0))
    geometry.setAttribute(ellipsoidAttributes.shapeA, new InterleavedBufferAttribute(shapes, 3, 3))
    geometry.setAttribute(ellipsoidAttributes.shapeB, new InterleavedBufferAttribute(shapes, 3, 6))
    // The attribute reads the paint's bytes as they are, each as a share of 255
    this.paint = new Uint8ClampedArray(capacity * paintSize)
    const paint = new InstancedInterleavedBuffer(new Uint8Array(this.paint.buffer), paintSize)
    geometry.setAttribute(ellipsoidAttributes.paint, new InterleavedBufferAttribute(paint, paintSize, 0, true))
    // A whole number of 32 bits, which both backends read as an unsigned integer as it's written
    this.pieces = new Uint32Array(capacity)
    const pieces = new InstancedInterleavedBuffer(this.pieces, 1)
    geometry.setAttribute(ellipsoidAttributes.piece, new InterleavedBufferAttribute(pieces, 1, 0))
    geometry.instanceCount = 0
    this.shapesWritten = new WrittenSlots(shapes, shapeSize)
    this.paintWritten = new WrittenSlots(paint, paintSize)
    this.piecesWritten = new WrittenSlots(pieces, 1)
  }

  // Makes room for pieces numbered below a count, where it has less, as an entry still arriving gains chains
  reservePieces(count: number) {
    if (count <= this.first.length) return
    const first = new Int32Array(count).fill(-1)
    first.set(this.first)
    this.first = first
    const held = new Uint32Array(count)
    held.set(this.held)
    this.held = held
    const seen = new Float64Array(count).fill(-Infinity)
    seen.set(this.seen)
    this.seen = seen
  }

  // A piece's first slot, or -1 while it holds none
  slotOf(piece: number) {
    return this.first[piece]
  }

  // How many slots a piece holds
  heldBy(piece: number) {
    return this.held[piece]
  }

  // Marks a piece as seen in a frame, which keeps its slots from being taken for another piece in that frame
  see(piece: number, frame: number) {
    this.seen[piece] = frame
  }

  // Gives a piece a stretch of slots for a number of instances, marked seen in the frame, and returns its first slot,
  // whose shapes and paint the caller then writes in full. Where no stretch is free, the pieces seen longest ago and
  // not in this frame give theirs up, oldest first, until one is. A fill that can't fit is refused whole, with -1, and
  // takes nothing from any other piece
  fill(piece: number, count: number, frame: number) {
    if (this.first[piece] >= 0) this.hide(piece)
    if (count === 0 || count > this.capacity) return -1
    let slot = this.place(count)
    if (slot < 0 && !this.fitsOnceReclaimed(count, frame)) return -1
    while (slot < 0) {
      const oldest = this.oldestUnseen(frame)
      if (oldest < 0) return -1
      this.hide(oldest)
      slot = this.place(count)
    }
    this.first[piece] = slot
    this.held[piece] = count
    this.seen[piece] = frame
    this.pieces.fill(piece, slot, slot + count)
    this.shapesWritten.add(slot, count)
    this.paintWritten.add(slot, count)
    this.piecesWritten.add(slot, count)
    return slot
  }

  // Marks a piece's paint as rewritten, to be sent again
  repainted(piece: number) {
    const slot = this.first[piece]
    if (slot >= 0) this.paintWritten.add(slot, this.held[piece])
  }

  // Takes a piece out of the pool: its slots point at no piece and are free for another
  hide(piece: number) {
    const slot = this.first[piece]
    if (slot < 0) return
    const end = slot + this.held[piece]
    this.first[piece] = -1
    this.held[piece] = 0
    this.pieces.fill(noPiece, slot, end)
    this.piecesWritten.add(slot, end - slot)
    insertStretch(this.freeStarts, this.freeEnds, slot, end)
    // A free stretch that reaches the extent comes off it
    const last = this.freeStarts.length - 1
    if (this.freeEnds[last] === this.extent) {
      this.extent = this.freeStarts[last]
      this.freeStarts.pop()
      this.freeEnds.pop()
    }
    this.geometry.instanceCount = this.extent
  }

  // Takes every piece out of the pool, which then draws nothing until it's filled again. No slot is drawn past the
  // extent, and a fill writes every slot it takes, so the GPU's copy of the pieces needn't be sent again
  clear() {
    this.first.fill(-1)
    this.held.fill(0)
    this.pieces.fill(noPiece, 0, this.extent)
    this.freeStarts.length = 0
    this.freeEnds.length = 0
    this.extent = 0
    this.geometry.instanceCount = 0
  }

  // Has the GPU's copies take what was written since the last time, by the ranges written
  send() {
    this.shapesWritten.send()
    this.paintWritten.send()
    this.piecesWritten.send()
  }

  dispose() {
    this.geometry.dispose()
  }

  // The first slot of a free stretch of a count, the first such stretch below the extent or else past it, which it
  // takes, or -1 where there's none
  private place(count: number) {
    for (let i = 0; i < this.freeStarts.length; i++) {
      const start = this.freeStarts[i]
      if (this.freeEnds[i] - start < count) continue
      if (this.freeEnds[i] - start === count) {
        moveStretches(this.freeStarts, this.freeEnds, i + 1, i)
      } else {
        this.freeStarts[i] = start + count
      }
      return start
    }
    if (this.extent + count > this.capacity) return -1
    const start = this.extent
    this.extent += count
    this.geometry.instanceCount = this.extent
    return start
  }

  // Whether a stretch of a count would be free were every piece not seen in a frame to give its slots up: some gap
  // between the stretches of the pieces seen in it, or after the last, is long enough. The slots below the extent are
  // free stretches and pieces' stretches in turn, which are walked in order
  private fitsOnceReclaimed(count: number, frame: number) {
    let from = 0
    let free = 0
    for (let slot = 0; slot < this.extent; ) {
      if (free < this.freeStarts.length && this.freeStarts[free] === slot) {
        slot = this.freeEnds[free++]
        continue
      }
      const piece = this.pieces[slot]
      if (this.seen[piece] >= frame) {
        if (slot - from >= count) return true
        from = slot + this.held[piece]
      }
      slot += this.held[piece]
    }
    return this.capacity - from >= count
  }

  // The piece holding slots that was seen longest ago, before a frame, or -1 where there's none
  private oldestUnseen(frame: number) {
    let oldest = -1
    for (let piece = 0; piece < this.first.length; piece++) {
      if (this.first[piece] < 0 || this.seen[piece] >= frame) continue
      if (oldest < 0 || this.seen[piece] < this.seen[oldest]) oldest = piece
    }
    return oldest
  }
}

// A pool of a number of slots for pieces numbered below a count, which draws nothing until it's filled
export function createPool(capacity: number, pieceCount: number) {
  return new Pool(capacity, pieceCount)
}
