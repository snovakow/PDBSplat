import { useFrame } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef } from 'react'
import { AdditiveBlending, Matrix4, Mesh, PerspectiveCamera, Vector3, type Object3D } from 'three'
import { NodeMaterial } from 'three/webgpu'
import { useShallow } from 'zustand/react/shallow'
import { vdwRadii } from '../pdb/elements.ts'
import { sameChoice } from '../pdb/structure.ts'
import { entryHolds, shownAtoms, shownChoice, shownModel, useStore } from '../store.ts'
import type { TablePaint } from './atomTable.ts'
import { useBounds } from './bounds.ts'
import { drawsLevel, ellipsoidVertex, readPieceTable } from './ellipsoid.ts'
import { createPool, type Pool } from './ellipsoidGeometry.ts'
import type { AtomShape } from './ellipsoids.ts'
import { pickedKey } from './focus.ts'
import { levelDrawn, levels, pixelsPerUnit, type Level } from './levels.ts'
import { setDrawnReach } from './nearPlane.ts'
import { pieceCount, PieceTable, planesSize, sidePlanes, viewMargin } from './pieces.ts'
import { layerNodes, softColor, type Layer } from './shading.ts'
import { buildsMerged, builtLevels, fittingLevels, poolSize, SplatContent } from './splatContent.ts'
import { drawLevel, paintStepOf, replaceContent, resizePools, showNothing, type Frames, type Stage } from './splatStage.ts'
import { compositeOf, hasGhosts, hasSolids, isBackShell } from './styles.ts'

// The see-through layers' places in the draw, each ahead of the colour's at three's default of 0: the back shell's
// depth alone, then its colour, then the ghost layer's depth alone, then its colour. All four list with the
// transparent objects, which are drawn in this order after the solid layer, as the see-through surface's draws are
const layerOrder: Record<Layer, number> = { backDepth: -3, back: -2, ghostDepth: -1, ghost: 0, solid: 0 }

interface Props {
  // The structure's object, which the meshes are children of
  structureObject: Object3D
}

// Gives the piece table and the pools room for an entry's pieces as its chains arrive. A larger table takes the
// smaller one's place, with its values, and is sent whole
function roomForPieces(stage: Stage, count: number) {
  if (count > stage.table.capacity) {
    const table = new PieceTable(Math.ceil(count * 1.5), stage.table)
    stage.table.dispose()
    stage.table = table
    readPieceTable(table)
  }
  for (const pool of stage.pools) pool?.reservePieces(stage.table.capacity)
}

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()
// The matrix from the structure's own space into clip space, and the view's planes in the structure's space
const clip = new Matrix4()
const planes = new Float64Array(planesSize)

// The level drawn for the whole structure: under auto the one whose ellipsoids are still a few pixels across at the
// view depth of the structure's centre, which sits at the origin, as the camera orbits, zooms or pans; with the centre
// at or behind the camera its depth sets no scale, and the finest stands
function drawnLevelOf(content: SplatContent, camera: PerspectiveCamera, viewportHeight: number) {
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

// One ellipsoid per shown atom, round or its thermal ellipsoid, where the file puts it, or one per residue or per
// chain, each the moment match of its atoms', as Detail asks, all placed by the structure's object. Each level draws
// from a pool of its own, which holds the chains in view, a piece each, and a chain coming into view is written into
// it as it does. An entry is drawn as it arrives: each batch's atoms and blobs are added to what's drawn, its chains
// becoming pieces and a chain it adds to filled again, and painted a stretch at a time, as a repaint of a giant is.
// A new colour or alpha repaints in place, a new shape or a new choice of atoms empties the pools to be filled again,
// and a new layer of the spheres remakes their meshes on the same pools. The loader merges the blobs' places, and a
// new choice of atoms is drawn once it has merged them again, what's drawn standing until then; each blob's own
// spread is added here from its atoms' shapes, so that a new shape needs no merge. With no atoms shown nothing is
// drawn. Nothing is ever sorted: the spheres are told apart by their surfaces' depths, and the soft splats are summed
// or glow, in an order that doesn't matter
export function ProteinSplats({ structureObject }: Props) {
  // The entry's bounds, as far as it has arrived
  const bounds = useBounds()
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
        buried: s.burial?.values ?? null,
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
  // The entry every snapshot of it names as it arrives, which what's kept for it while it's shown is kept by
  const entryOf = structure.arrival ?? structure
  // The shown atoms' choice, and the blobs the loader last merged, with the choice they were merged for
  const choice = useStore(useShallow(shownChoice))
  const merged = useStore((s) => s.merged)
  const fitting = fittingLevels(shown.count, merged, structure)
  const stage = useRef<Stage | null>(null)
  const content = useRef<SplatContent | null>(null)
  // The meshes of each level
  const meshes = useRef<Mesh<Pool['geometry'], NodeMaterial>[][]>([])
  const frames = useRef<Frames>({ level: -1, frame: 0, stale: true, planes: new Float64Array(planesSize) })
  // The inputs the paint stands on, which the frames paint on from while a step is still to do
  const painting = useRef<TablePaint | null>(null)

  // Paints the content from the inputs as they stand now, so that the build below needn't depend on them and no frame
  // draws it blank
  const paintNow = useEffectEvent((current: SplatContent, entry: Stage) => {
    painting.current = paint
    paintStepOf(current, entry, paint)
  })
  // The bounds' centre, as they stand now, which the reach is measured from
  const centreNow = useEffectEvent((): [number, number, number] => [bounds.center.x, bounds.center.y, bounds.center.z])
  // The structure as it stands now
  const structureNow = useEffectEvent(() => structure)

  // The entry's pools, made as its levels are first built, and its piece table, which every mesh reads, all kept
  // while it's shown and as it arrives
  useEffect(() => {
    const entry: Stage = {
      entry: entryOf,
      pools: levels.map(() => null),
      filledFrom: levels.map(() => null),
      table: new PieceTable(pieceCount(structureNow())),
    }
    readPieceTable(entry.table)
    stage.current = entry
    return () => {
      replaceContent(content, null)
      for (const pool of entry.pools) pool?.dispose()
      entry.table.dispose()
      stage.current = null
    }
  }, [entryOf])

  // The blobs merged again by the loader for a new choice of atoms, where Detail builds a merged level
  const needsMerge = buildsMerged(detail, structure) && shown.count > 0 && !(merged && sameChoice(merged.choice, choice))
  useEffect(() => {
    if (needsMerge) useStore.getState().requestMerge(choice)
  }, [needsMerge, choice])

  // What the shown atoms are drawn as, grown by what each batch of an arriving entry adds, or made afresh for another
  // entry, choice of atoms, shape or Detail. The pools take it as the frames fill them, and the pieces a batch changed
  // are taken out of them to be filled again. Where the merged levels' blobs are of another choice of atoms, what's
  // drawn stands until the loader's merge for this one lands
  useEffect(() => {
    const entry = stage.current
    if (!entry) return
    if (shown.count === 0) {
      showNothing(entry, content)
      return
    }
    const places = merged && sameChoice(merged.choice, choice) ? merged : null
    if (!places && buildsMerged(detail, structure)) return

    const shape: AtomShape = { scale, thermal, ellipsoids }
    let current = content.current
    if (!current?.growsInto(structure, choice, detail, shape, places, structureObject)) {
      const { registerPick } = useStore.getState()
      current = new SplatContent(structure, shown, choice, detail, shape, vdwRadii(structure.elements), structureObject, registerPick)
      replaceContent(content, current)
    }
    if (structure.whole) resizePools(entry, structure, meshes.current)
    const slots = (level: Level) => entry.pools[levels.indexOf(level)]?.capacity ?? poolSize(structure, level)
    const changed = current.grow(structure, shown, places, centreNow(), slots)
    if (!changed) {
      replaceContent(content, null)
      return
    }
    roomForPieces(entry, pieceCount(structure))
    entry.pools.forEach((pool, level) => {
      if (pool && entry.filledFrom[level] === current) for (const piece of changed) pool.hide(piece)
    })
    paintNow(current, entry)
    setDrawnReach(current.reachOnward() ?? current.reach)
    frames.current.stale = true
  }, [structureObject, structure, shown, choice, merged, scale, thermal, ellipsoids, detail])

  // What's drawn goes with the component
  useEffect(() => () => replaceContent(content, null), [])

  // The meshes on the pools of the levels Detail builds whose instances fit: one for each layer while the splats are
  // layered, and otherwise one of soft splats that's summed or glows. Every mesh of a level draws the same instances,
  // and none is culled by the quad's own bounds, which say nothing of where its instances are. They start hidden, and
  // the frames show the level drawn
  useEffect(() => {
    const entry = stage.current
    if (entry?.entry !== entryOf) return undefined
    const layered = composite === 'layered'
    const latest = structureNow()
    const built = builtLevels(detail, latest)
    const made = levels.map((level, index) => {
      const levelMeshes: Mesh<Pool['geometry'], NodeMaterial>[] = []
      if (!built.includes(level) || fitting[index] !== '1') return levelMeshes
      const pool = (entry.pools[index] ??= createPool(poolSize(latest, level), entry.table.capacity))
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
  }, [structureObject, entryOf, detail, composite, solids, ghosts, backShell, fitting])

  // A new colouring, Burial, Focus, Fade or pick repaints the ellipsoids, in place, a step now and the rest in the
  // frames that follow
  useEffect(() => {
    painting.current = paint
    if (content.current && stage.current) paintStepOf(content.current, stage.current, paint)
  }, [paint])

  // Each frame, after the controls have moved the camera and before the render, so that every pass of the frame draws
  // the same instances: a step of a paint or of the exact reach still to do; the level to draw, shown and the rest
  // hidden, and, where the view or what's drawn has changed, the pieces whose spheres lie in view or within a margin
  // of it tested again; then whatever was written since the last frame, a fill or a repaint, is sent
  useFrame(({ camera, size }) => {
    const entry = stage.current
    const current = content.current
    if (!entry || !current || !(camera instanceof PerspectiveCamera)) return
    const inputs = painting.current
    if (inputs && !current.paintedFrom(inputs)) paintStepOf(current, entry, inputs)
    const reach = current.reachOnward()
    if (reach !== null) setDrawnReach(reach)
    const state = frames.current
    const level = drawnLevelOf(current, camera, size.height)
    if (level !== state.level) {
      showLevel(meshes.current, level)
      state.level = level
      state.stale = true
    }
    camera.updateMatrixWorld()
    clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(structureObject.matrixWorld)
    sidePlanes(clip.elements, viewMargin, planes)
    drawLevel(entry, current, level, state, planes)
  })

  return null
}
