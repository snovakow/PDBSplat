import { useFrame } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef } from 'react'
import { AdditiveBlending, Matrix4, Mesh, PerspectiveCamera, Ray, Vector3, type Object3D } from 'three'
import { NodeMaterial } from 'three/webgpu'
import { useShallow } from 'zustand/react/shallow'
import { vdwRadii } from '../pdb/elements.ts'
import type { Detail } from '../options.ts'
import type { ShownAtoms, Structure } from '../pdb/structure.ts'
import { entryHolds, shownAtoms, shownModel, useStore, type PickTest } from '../store.ts'
import { isPickable, paintAtoms, paintMerged, type TablePaint } from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { drawsLevel, ellipsoidVertex, readPieceTable } from './ellipsoid.ts'
import {
  covarianceSize,
  createPool,
  ellipsoidsReach,
  paintSize,
  shapeSize,
  surfaceDeviations,
  type Pool,
} from './ellipsoidGeometry.ts'
import { writeAtomShape, type AtomShape } from './ellipsoids.ts'
import { pickedKey } from './focus.ts'
import {
  levelDrawn,
  levelGroups,
  levels,
  mergeGaussians,
  pixelsPerUnit,
  typicalDiameter,
  type Grouping,
  type Level,
} from './levels.ts'
import { cutAlong, setDrawnReach } from './nearPlane.ts'
import {
  atomSpans,
  groupSpans,
  hiddenTexel,
  pickByPieces,
  pieceCount,
  pieceSpheres,
  PieceTable,
  PieceWalk,
  planesSize,
  shownTexel,
  sidePlanes,
  sphereInView,
  sphereSize,
  viewMargin,
  type DrawnInstances,
  type PieceSpans,
} from './pieces.ts'
import { rayInto } from './placement.ts'
import { ellipsoidEntry, invertCovariance, type EllipsoidHit } from './rayEllipsoids.ts'
import { layerNodes, softColor, type Layer } from './shading.ts'
import { compositeOf, hasGhosts, hasSolids, isBackShell } from './styles.ts'

// The see-through layers' places in the draw, each ahead of the colour's at three's default of 0: the back shell's
// depth alone, then its colour, then the ghost layer's depth alone, then its colour. All four list with the
// transparent objects, which are drawn in this order after the solid layer, as the see-through surface's draws are
const layerOrder: Record<Layer, number> = { backDepth: -3, back: -2, ghostDepth: -1, ghost: 0, solid: 0 }

// The most instances a level's pool holds, though an entry's pool holds no more than the entry's own atoms, residues
// or chains. The atoms' holds the 4,527,463 atoms of the bovine sperm axoneme, the most any entry draws as atoms, and
// the residues' as many; their shapes stay under the 256 MiB a WebGPU buffer takes by default, with room for a wider
// slot. On a 2014 Mac mini's Intel Iris, in Chrome, that entry drew whole from its atoms' pool on both backends, if at
// a frame every fourteen seconds. The chains' holds every chain, so that some level always fits
const poolCapacity: Record<Level, number> = { atoms: 5_000_000, residues: 5_000_000, chains: Infinity }

// How many instances an entry has at a level, at most
function entryCount(structure: Structure, level: Level) {
  if (level === 'atoms') return structure.atoms.count
  return level === 'residues' ? structure.residues.count : structure.chains.count
}

// How many slots an entry's pool at a level has
function poolSize(structure: Structure, level: Level) {
  return Math.max(1, Math.min(poolCapacity[level], entryCount(structure, level)))
}

// The levels Detail builds for an entry: every level under auto, and otherwise the one it asks for, followed by the
// coarser ones as far as the first whose pool holds all of the entry's, so that one level always fits
function builtLevels(detail: Detail, structure: Structure): readonly Level[] {
  if (detail === 'auto') return levels
  const built: Level[] = []
  for (let index = levels.indexOf(detail); index < levels.length; index++) {
    built.push(levels[index])
    if (entryCount(structure, levels[index]) <= poolCapacity[levels[index]]) break
  }
  return built
}

interface Props {
  bounds: Bounds
  // The structure's object, which the meshes are children of
  structureObject: Object3D
}

// What the entry is drawn from while it's shown: a pool for each level, made the first time that level is built,
// what each pool was last filled from, and the piece table every pool's meshes read
interface Stage {
  pools: (Pool | null)[]
  filledFrom: (Content | null)[]
  table: PieceTable
}

// A level as its pool is filled from it: the instances each piece owns, a merged level's blobs with its members'
// groups, the paint of each instance, and whether all of them fit the pool, without which the level isn't drawn
interface LevelContent {
  spans: PieceSpans
  blobs: { centers: Float32Array; covariances: Float32Array; grouping: Grouping } | null
  paint: Uint8ClampedArray
  offered: boolean
}

// What the shown atoms are drawn as while they and their shapes stand: the shapes' options and the elements' radii,
// the shown atoms' spans, which the pick walks at every level, the levels Detail builds, each piece's sphere, each
// level's typical drawn diameter, which auto switches by, the atoms' paint and the weights the blobs mix it by, and
// what it was last painted from, and which levels are offered, as their instances fit their pools
interface Content {
  structure: Structure
  shown: ShownAtoms
  detail: Detail
  shape: AtomShape
  radii: number[]
  atoms: PieceSpans
  levels: (LevelContent | null)[]
  spheres: Float64Array
  diameters: number[]
  atomPaint: Uint8ClampedArray
  weights: Float32Array
  painted: TablePaint | null
  offered: boolean[]
}

// What the frames keep between them: the level drawn, or -1 before one is, a count of the frames that tested the
// pieces, whether they must be tested again whatever the view, and the view's planes they were last tested against
interface Frames {
  level: number
  frame: number
  stale: boolean
  planes: Float64Array
}

// Writes a piece's instances at a level into its pool, refusing where they don't fit
function fillPiece(pool: Pool, content: Content, level: number, piece: number, frame: number) {
  const owned = content.levels[level]
  if (!owned) return false
  const { spans, blobs, paint } = owned
  let slot = pool.fill(piece, spans.sizes[piece], frame)
  if (slot < 0) return false
  const { structure, shown, radii, shape } = content
  const { positions } = structure.atoms
  const { shapes } = pool
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = spans.start[s]; i < spans.end[s]; i++, slot++) {
      const at = slot * shapeSize
      if (blobs) {
        for (let k = 0; k < 3; k++) shapes[at + k] = blobs.centers[i * 3 + k]
        for (let k = 0; k < covarianceSize; k++) shapes[at + 3 + k] = blobs.covariances[i * covarianceSize + k]
      } else {
        const atom = shown.rows[i]
        for (let k = 0; k < 3; k++) shapes[at + k] = positions[atom * 3 + k]
        writeAtomShape(shapes, at + 3, structure, atom, radii, shape)
      }
      for (let k = 0; k < paintSize; k++) pool.paint[slot * paintSize + k] = paint[i * paintSize + k]
    }
  }
  return true
}

// Copies a piece's paint at a level into its slots, where it holds any
function repaintPiece(pool: Pool, { spans, paint }: LevelContent, piece: number) {
  let slot = pool.slotOf(piece)
  if (slot < 0) return
  for (let s = spans.first[piece]; s < spans.first[piece + 1]; s++) {
    for (let i = spans.start[s]; i < spans.end[s]; i++, slot++) {
      for (let k = 0; k < paintSize; k++) pool.paint[slot * paintSize + k] = paint[i * paintSize + k]
    }
  }
  pool.repainted(piece)
}

// Paints the atoms from the inputs, unless they were painted from them already, and each merged level from the atoms,
// and repaints in place the pieces the pools hold
function paintFrom(content: Content, stage: Stage, inputs: TablePaint) {
  if (content.painted === inputs) return
  paintAtoms(content.atomPaint, inputs)
  content.levels.forEach((owned, level) => {
    if (!owned) return
    if (owned.blobs) paintMerged(owned.paint, content.atomPaint, owned.blobs.grouping, content.weights)
    const pool = stage.pools[level]
    if (!pool || stage.filledFrom[level] !== content) return
    for (let piece = 1; piece < owned.spans.sizes.length; piece++) repaintPiece(pool, owned, piece)
  })
  content.painted = inputs
}

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()
// The matrix from the structure's own space into clip space, and the view's planes in the structure's space
const clip = new Matrix4()
const planes = new Float64Array(planesSize)

// The level drawn for the whole structure: under auto the one whose ellipsoids are still a few pixels across at the
// view depth of the structure's centre, which sits at the origin, as the camera orbits, zooms or pans; with the centre
// at or behind the camera its depth sets no scale, and the finest stands
function drawnLevelOf(content: Content, camera: PerspectiveCamera, viewportHeight: number) {
  const centreDepth = -camera.position.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion))
  const pixels = centreDepth > 0 ? pixelsPerUnit(viewportHeight, camera.fov, centreDepth) : Infinity
  return levelDrawn(content.detail, content.offered, content.diameters, pixels)
}

// Shows one level's meshes, by its place among the levels, and hides the rest
function showLevel(meshes: readonly Object3D[][], level: number) {
  for (let index = 0; index < meshes.length; index++) {
    for (const mesh of meshes[index]) mesh.visible = index === level
  }
}

// Tests every piece against the view's planes, as the frame last wrote them: each one in view at the level drawn is
// filled into that level's pool where it isn't there yet, and shown in the piece table, and every other piece is
// hidden there
function cull(entry: Stage, current: Content, level: number, state: Frames) {
  state.planes.set(planes)
  state.stale = false
  const pool = entry.pools[level]
  const owned = current.levels[level]
  if (!pool || !owned) return
  const frame = ++state.frame
  const { spheres } = current
  const { table } = entry
  for (let piece = 1; piece < owned.spans.sizes.length; piece++) {
    const at = piece * sphereSize
    let value = hiddenTexel
    if (
      owned.spans.sizes[piece] > 0 &&
      sphereInView(planes, spheres[at], spheres[at + 1], spheres[at + 2], spheres[at + 3])
    ) {
      if (pool.slotOf(piece) >= 0) {
        pool.see(piece, frame)
        value = shownTexel
      } else if (fillPiece(pool, current, level, piece, frame)) {
        value = shownTexel
      }
    }
    for (let other = 0; other < levels.length; other++) table.set(piece, other, other === level ? value : hiddenTexel)
  }
}

// One ellipsoid per shown atom, round or its thermal ellipsoid, where the file puts it, or one per residue or per
// chain, each the moment match of its atoms', as Detail asks, all placed by the structure's object. Each level draws
// from a pool of its own, which holds the chains in view, a piece each, and a chain coming into view is written into
// it as it does. A new colour or alpha repaints in place, a new shape or a new choice of atoms empties the pools to be
// filled again, and a new layer of the spheres remakes their meshes on the same pools. Nothing is ever sorted: the
// spheres are told apart by their surfaces' depths, and the soft splats are summed or glow, in an order that doesn't
// matter
export function ProteinSplats({ bounds, structureObject }: Props) {
  const scale = useStore((s) => s.options.scale)
  const thermal = useStore((s) => s.options.thermal)
  const ellipsoids = useStore((s) => s.options.ellipsoids)
  const detail = useStore((s) => s.options.detail)
  // How the splats are laid over one another, and, while they're layered, which layers there are to draw
  const composite = useStore((s) => compositeOf(s.options))
  const solids = useStore((s) => hasSolids(s.options))
  const ghosts = useStore((s) => hasGhosts(s.options, entryHolds(s)))
  const backShell = useStore((s) => isBackShell(s.options))
  // What the atoms are painted from, in one object that stands while its fields do. The shown atoms already follow
  // Hydrogens, Waters, Alternates and the model, which the alpha factors read as well
  const paint = useStore(
    useShallow(
      (s): TablePaint => ({
        shown: shownAtoms(s),
        structure: s.structure,
        colorBy: s.options.colorBy,
        burial: s.options.burial,
        focus: s.options.focus,
        picked: pickedKey(s.structure, s.options.focus, s.picked),
        fade: s.options.fade,
        model: shownModel(s),
        modelCount: s.models.length,
        conformations: s.options.conformations,
        layered: compositeOf(s.options) === 'layered',
      }),
    ),
  )
  const { shown, structure } = paint
  const stage = useRef<Stage | null>(null)
  const content = useRef<Content | null>(null)
  // The meshes of each level
  const meshes = useRef<Mesh<Pool['geometry'], NodeMaterial>[][]>([])
  const frames = useRef<Frames>({ level: -1, frame: 0, stale: true, planes: new Float64Array(planesSize) })

  // Paints the new content from the inputs as they stand now, so that the build below needn't depend on them and no
  // frame draws it blank
  const paintNow = useEffectEvent((current: Content, entry: Stage) => paintFrom(current, entry, paint))
  // How far from the structure's centre, as its bounds stand now, ellipsoids reach
  const reachOf = useEffectEvent((centers: Float32Array, covariances: Float32Array) =>
    ellipsoidsReach(centers, covariances, bounds.center),
  )

  // The entry's pools, made as its levels are first built, and its piece table, which every mesh reads, all kept
  // while it's shown
  useEffect(() => {
    const entry: Stage = {
      pools: levels.map(() => null),
      filledFrom: levels.map(() => null),
      table: new PieceTable(pieceCount(structure)),
    }
    readPieceTable(entry.table)
    stage.current = entry
    return () => {
      for (const pool of entry.pools) pool?.dispose()
      entry.table.dispose()
      stage.current = null
    }
  }, [structure])

  // What the shown atoms are drawn as: each atom's ellipsoid, the blobs of the merged levels Detail builds, each
  // piece's spans and sphere, and the pick. The pools take it as the frames fill them
  useEffect(() => {
    const entry = stage.current
    if (!entry || shown.count === 0) return undefined

    const shape: AtomShape = { scale, thermal, ellipsoids }
    const radii = vdwRadii(structure.elements)
    const centers = new Float32Array(shown.count * 3)
    const covariances = new Float32Array(shown.count * covarianceSize)
    // Each atom's share of the blob it's merged into: its van der Waals volume, which goes as its radius at Size cubed
    const weights = new Float32Array(shown.count)
    const { positions, element } = structure.atoms
    for (let i = 0; i < shown.count; i++) {
      const atom = shown.rows[i]
      centers[i * 3] = positions[atom * 3]
      centers[i * 3 + 1] = positions[atom * 3 + 1]
      centers[i * 3 + 2] = positions[atom * 3 + 2]
      const radius = radii[element[atom]] * scale
      weights[i] = radius * radius * radius
      writeAtomShape(covariances, i * covarianceSize, structure, atom, radii, shape)
    }

    const atoms = atomSpans(structure, shown)
    const atomPaint = new Uint8ClampedArray(shown.count * paintSize)
    const owned: (LevelContent | null)[] = levels.map(() => null)
    const drawn: DrawnInstances[] = [{ spans: atoms, centers, covariances }]
    const diameters = levels.map(() => 0)
    // How far from the structure's centre the levels reach, the farthest of them, as any of them may be shown
    let reach = 0
    // Under auto every level is built, and the frames show one; a fixed Detail builds that level alone, where it fits
    for (const level of builtLevels(detail, structure)) {
      const index = levels.indexOf(level)
      let levelCenters: Float32Array = centers
      let levelCovariances: Float32Array = covariances
      if (level === 'atoms') {
        owned[index] = { spans: atoms, blobs: null, paint: atomPaint, offered: false }
      } else {
        const grouping = levelGroups(structure, shown, level)
        const merged = mergeGaussians(centers, covariances, weights, grouping)
        levelCenters = merged.centers
        levelCovariances = merged.covariances
        const spans = groupSpans(atoms, grouping.groups)
        const blobs = { centers: levelCenters, covariances: levelCovariances, grouping }
        owned[index] = { spans, blobs, paint: new Uint8ClampedArray(grouping.count * paintSize), offered: false }
        drawn.push({ spans, centers: levelCenters, covariances: levelCovariances })
      }
      const levelOwned = owned[index]
      if (levelOwned) levelOwned.offered = levelCenters.length / 3 <= poolSize(structure, level)
      if (detail === 'auto') diameters[index] = typicalDiameter(levelCovariances, surfaceDeviations)
      reach = Math.max(reach, reachOf(levelCenters, levelCovariances))
    }

    const spheres = pieceSpheres(drawn)
    const current: Content = {
      structure,
      shown,
      detail,
      shape,
      radii,
      atoms,
      levels: owned,
      spheres,
      diameters,
      atomPaint,
      weights,
      painted: null,
      offered: owned.map((level) => level?.offered === true),
    }
    paintNow(current, entry)
    setDrawnReach(reach)
    content.current = current
    frames.current.stale = true

    // A ray picks the atom whose ellipsoid it meets first, whichever level is drawn, so the label names the atom
    // under the pointer at every level, and an atom of the blob under it. It passes through an atom faded far out of
    // focus, and through whatever the cut has taken. The ray is tested in the structure's own space, where the atoms'
    // ellipsoids are, and the cut is as far along it there as in the scene. Only the pieces whose spheres it passes
    // through are tested, nearest first, and each atom's ellipsoid is worked out as it's tested
    const walk = new PieceWalk(pieceCount(structure))
    const found: EllipsoidHit = { index: -1, distance: Infinity }
    const local = new Ray()
    const atomShape = new Float32Array(covarianceSize)
    const inverse = new Float32Array(covarianceSize)
    // How far along the ray the cut lies, for the pick under way
    const along = { cut: 0 }
    const testPiece = (piece: number) => {
      for (let s = atoms.first[piece]; s < atoms.first[piece + 1]; s++) {
        for (let i = atoms.start[s]; i < atoms.end[s]; i++) {
          const atom = shown.rows[i]
          writeAtomShape(atomShape, 0, structure, atom, radii, shape)
          invertCovariance(atomShape, 0, inverse, 0)
          const distance = ellipsoidEntry(local, positions, atom * 3, inverse, 0, along.cut)
          if (distance > found.distance || (distance === found.distance && i > found.index)) continue
          if (!isPickable(atomPaint, i)) continue
          found.index = i
          found.distance = distance
        }
      }
    }
    const pick: PickTest = (raycaster, hit) => {
      along.cut = cutAlong(raycaster.ray, raycaster.camera)
      pickByPieces(rayInto(raycaster.ray, structureObject, local), spheres, along.cut, walk, found, testPiece)
      if (found.index < 0 || found.distance >= hit.distance) return
      hit.atom = shown.rows[found.index]
      hit.distance = found.distance
    }
    const unregister = useStore.getState().registerPick(pick)

    return () => {
      unregister()
      content.current = null
    }
  }, [structureObject, structure, shown, scale, thermal, ellipsoids, detail])

  // The meshes on the pools of the levels Detail builds: one for each layer while the splats are layered, and
  // otherwise one of soft splats that's summed or glows. Every mesh of a level draws the same instances, and none is
  // culled by the quad's own bounds, which say nothing of where its instances are. They start hidden, and the frames
  // show the level drawn
  useEffect(() => {
    const entry = stage.current
    if (!entry) return undefined
    const layered = composite === 'layered'
    const built = builtLevels(detail, structure)
    const made = levels.map((level, index) => {
      const levelMeshes: Mesh<Pool['geometry'], NodeMaterial>[] = []
      if (!built.includes(level)) return levelMeshes
      const pool = (entry.pools[index] ??= createPool(poolSize(structure, level), pieceCount(structure)))
      const add = () => {
        const material = new NodeMaterial()
        material.vertexNode = ellipsoidVertex
        const mesh = new Mesh(pool.geometry, material)
        mesh.frustumCulled = false
        mesh.visible = false
        drawsLevel(mesh, index)
        levelMeshes.push(mesh)
        return mesh
      }
      if (layered) {
        const layer = (kind: Layer) => {
          const mesh = add()
          const { colorNode, depthNode } = layerNodes(kind, backShell)
          mesh.material.colorNode = colorNode
          mesh.material.depthNode = depthNode
          mesh.renderOrder = layerOrder[kind]
          return mesh.material
        }
        // A solid writes the depth of its surface, and its edge's fade sets how much of each pixel it covers, so its
        // rim stays smooth with nothing behind it showing through
        if (solids) layer('solid').alphaToCoverage = true
        // A see-through layer's colour is blended over what's behind it, and writes no depth
        const colourLayer = (kind: Layer) => {
          const material = layer(kind)
          material.transparent = true
          material.depthWrite = false
        }
        // A depth layer writes its surface's depth and no colour, and the colour layer after it passes only where
        // it's the surface that depth kept. It's transparent so that it lists, and draws in order, with the colours
        const depthLayer = (kind: Layer) => {
          const material = layer(kind)
          material.transparent = true
          material.colorWrite = false
        }
        if (ghosts) {
          if (backShell) {
            depthLayer('backDepth')
            colourLayer('back')
          }
          depthLayer('ghostDepth')
          colourLayer('ghost')
        }
      } else {
        // Added light doesn't depend on the order it's drawn in, and nor does a weighted sum, to which a splat adds
        // its colour and its alpha already multiplied by its alpha, both as they are
        const { material } = add()
        material.colorNode = softColor
        material.transparent = true
        material.depthWrite = false
        material.blending = AdditiveBlending
        if (composite === 'summed') material.premultipliedAlpha = true
      }
      for (const mesh of levelMeshes) structureObject.add(mesh)
      return levelMeshes
    })
    meshes.current = made
    frames.current.level = -1
    return () => {
      for (const levelMeshes of made) {
        for (const mesh of levelMeshes) {
          structureObject.remove(mesh)
          mesh.material.dispose()
        }
      }
      meshes.current = []
    }
  }, [structureObject, structure, detail, composite, solids, ghosts, backShell])

  // A new colouring, Burial, Focus, Fade or pick repaints the ellipsoids, in place
  useEffect(() => {
    if (content.current && stage.current) paintFrom(content.current, stage.current, paint)
  }, [paint])

  // Each frame, after the controls have moved the camera and before the render, so that every pass of the frame draws
  // the same instances: the level to draw, shown and the rest hidden, and, where the view or what's drawn has changed,
  // the pieces whose spheres lie in view or within a margin of it tested again; then whatever was written since the
  // last frame, a fill or a repaint, is sent
  useFrame(({ camera, size }) => {
    const entry = stage.current
    const current = content.current
    if (!entry || !current || !(camera instanceof PerspectiveCamera)) return
    const state = frames.current
    const level = drawnLevelOf(current, camera, size.height)
    if (level !== state.level) {
      showLevel(meshes.current, level)
      state.level = level
      state.stale = true
    }
    const pool = entry.pools[level]
    if (!pool) return
    if (entry.filledFrom[level] !== current) {
      pool.clear()
      entry.filledFrom[level] = current
      state.stale = true
    }

    camera.updateMatrixWorld()
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(structureObject.matrixWorld)
    sidePlanes(clip.elements, viewMargin, planes)
    let moved = state.stale
    for (let k = 0; k < planesSize; k++) moved ||= planes[k] !== state.planes[k]
    if (moved) cull(entry, current, level, state)
    // A repaint since the last frame goes too, though nothing was culled
    pool.send()
    entry.table.send()
  })

  return null
}
