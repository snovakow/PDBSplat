import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef } from 'react'
import { AdditiveBlending, Mesh, PerspectiveCamera, Vector3, type Camera, type InstancedBufferGeometry } from 'three'
import { NodeMaterial } from 'three/webgpu'
import { useShallow } from 'zustand/react/shallow'
import { vdwRadii } from '../pdb/elements.ts'
import { entryHolds, shownAtoms, shownModel, useStore, type PickTest } from '../store.ts'
import { isPickable, paintAtoms, paintMerged, type TablePaint } from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { ellipsoidVertex } from './ellipsoid.ts'
import {
  covarianceSize,
  createEllipsoids,
  ellipsoidsReach,
  paintSize,
  surfaceDeviations,
  writeRound,
  type Ellipsoids,
} from './ellipsoidGeometry.ts'
import { writeEllipsoid } from './ellipsoids.ts'
import { pickedKey } from './focus.ts'
import {
  levelGroups,
  levels,
  levelToDraw,
  mergeGaussians,
  pixelsPerUnit,
  typicalDiameter,
  type Grouping,
  type Level,
} from './levels.ts'
import { cutAlong, setDrawnReach } from './nearPlane.ts'
import { invertCovariances, nearestEllipsoid, type EllipsoidHit } from './rayEllipsoids.ts'
import { layerNodes, softColor, type Layer } from './shading.ts'
import { compositeOf, hasGhosts, hasSolids, isBackShell } from './styles.ts'

// The see-through layers' places in the draw, each ahead of the colour's at three's default of 0: the back shell's
// depth alone, then its colour, then the ghost layer's depth alone, then its colour. All four list with the
// transparent objects, which are drawn in this order after the solid layer, as the see-through surface's draws are
const layerOrder: Record<Layer, number> = { backDepth: -3, back: -2, ghostDepth: -1, ghost: 0, solid: 0 }

// A B-factor is 8π² times its atom's mean square displacement along any one axis, in square ångströms
const bFactorPerVariance = 8 * Math.PI * Math.PI

interface Props {
  bounds: Bounds
}

// A level while it's drawn: its ellipsoids, the meshes that draw them, one for each layer it's drawn in, and, for a
// merged level, its members' groups, which its paint is mixed by
interface DrawnLevel {
  instances: Ellipsoids
  meshes: Mesh<InstancedBufferGeometry, NodeMaterial>[]
  grouping: Grouping | null
}

// The levels while they're drawn, finest first: the atoms' paint, which is the atom level's own where that's built,
// what it was last painted from, the weights the merged levels were merged by, and each level's typical drawn
// diameter, which the switch reads
interface Drawn {
  paint: Uint8ClampedArray
  painted: TablePaint | null
  weights: Float32Array
  levels: DrawnLevel[]
  diameters: number[]
}

// Paints the levels from their inputs, unless they were painted from them already: the atoms from the inputs, and
// each merged level from the atoms
function paintFrom(current: Drawn, inputs: TablePaint) {
  if (current.painted === inputs) return
  paintAtoms(current.paint, inputs)
  for (const { instances, grouping } of current.levels) {
    if (grouping) paintMerged(instances.paint, current.paint, grouping, current.weights)
    instances.repaint()
  }
  current.painted = inputs
}

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()

// Shows the one level whose ellipsoids are still a few pixels across at the view depth of the structure's centre,
// which sits at the origin, as the camera orbits, zooms or pans, and hides the rest. With the centre at or behind the
// camera its depth sets no scale, and the finest level stands
function showLevel({ levels: built, diameters }: Drawn, camera: Camera, viewportHeight: number) {
  if (!(camera instanceof PerspectiveCamera)) return
  const centreDepth = -camera.position.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion))
  const level = centreDepth > 0 ? levelToDraw(diameters, pixelsPerUnit(viewportHeight, camera.fov, centreDepth)) : 0
  for (let i = 0; i < built.length; i++) {
    const { meshes } = built[i]
    for (let m = 0; m < meshes.length; m++) meshes[m].visible = i === level
  }
}

// One ellipsoid per shown atom, round or its thermal ellipsoid, centred on the structure's centroid, or one per residue
// or per chain, each the moment match of its atoms', as Detail asks, and every level under auto. Each is an instance
// of one quad, with its paint as an attribute, so that a new colour or alpha repaints in place and rebuilds nothing.
// Nothing is ever sorted: the spheres are told apart by their surfaces' depths, and the soft splats are summed or
// glow, in an order that doesn't matter
export function ProteinSplats({ bounds }: Props) {
  const get = useThree((s) => s.get)
  const scale = useStore((s) => s.options.scale)
  const thermal = useStore((s) => s.options.thermal)
  const ellipsoids = useStore((s) => s.options.ellipsoids)
  const detail = useStore((s) => s.options.detail)
  // How the splats are laid over one another, and, while they're layered, which layers there are to draw
  const composite = useStore((s) => compositeOf(s.options))
  const solids = useStore((s) => hasSolids(s.options))
  const ghosts = useStore((s) => hasGhosts(s.options, entryHolds(s)))
  const backShell = useStore((s) => isBackShell(s.options))
  // What the table is painted from, in one object that stands while its fields do. The shown atoms already follow
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
  const drawn = useRef<Drawn | null>(null)

  // Paints the new tables from the inputs as they stand now, so that the build below needn't depend on them and no
  // frame draws a table blank
  const paintNow = useEffectEvent((current: Drawn) => paintFrom(current, paint))

  useEffect(() => {
    if (shown.count === 0) return undefined

    const centers = new Float32Array(shown.count * 3)
    const covariances = new Float32Array(shown.count * 6)
    // Each atom's share of the blob it's merged into: its van der Waals volume, which goes as its radius at Size cubed
    const weights = new Float32Array(shown.count)
    const { positions, element, bFactor } = structure.atoms
    const radii = vdwRadii(structure.elements)

    for (let i = 0; i < shown.count; i++) {
      const atom = shown.rows[i]
      centers[i * 3] = positions[atom * 3] - bounds.center.x
      centers[i * 3 + 1] = positions[atom * 3 + 1] - bounds.center.y
      centers[i * 3 + 2] = positions[atom * 3 + 2] - bounds.center.z

      const radius = radii[element[atom]] * scale
      weights[i] = radius * radius * radius
      if (ellipsoids) {
        writeEllipsoid(covariances, i * covarianceSize, structure, atom, scale)
      } else {
        // An atom's surface is its van der Waals sphere at Size, and thermal motion spreads the atom by its
        // displacement, whose variance adds to its own
        const size = radius / surfaceDeviations
        const spread = (thermal * Math.max(bFactor[atom], 0)) / bFactorPerVariance
        writeRound(covariances, i * covarianceSize, Math.sqrt(size * size + spread))
      }
    }

    const layered = composite === 'layered'
    const { scene, camera, size } = get()
    const current: Drawn = {
      paint: new Uint8ClampedArray(shown.count * paintSize),
      painted: null,
      weights,
      levels: [],
      diameters: [],
    }

    // How far from the structure's centre the levels reach, the farthest of them, as any of them may be shown
    let reach = 0
    // A level's meshes on its ellipsoids: one for each layer while the level is layered, and otherwise one of soft
    // splats that's summed or glows. Every mesh draws the same instances, and none is culled by the quad's own bounds,
    // which say nothing of where its instances are
    const build = (levelCenters: Float32Array, levelCovariances: Float32Array, grouping: Grouping | null) => {
      const instances = createEllipsoids(levelCenters, levelCovariances)
      const meshes: DrawnLevel['meshes'] = []
      const add = () => {
        const material = new NodeMaterial()
        material.vertexNode = ellipsoidVertex
        const mesh = new Mesh(instances.geometry, material)
        mesh.frustumCulled = false
        meshes.push(mesh)
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
      for (const mesh of meshes) scene.add(mesh)
      current.levels.push({ instances, meshes, grouping })
      current.diameters.push(typicalDiameter(levelCovariances, surfaceDeviations))
      reach = Math.max(reach, ellipsoidsReach(levelCenters, levelCovariances))
      return instances
    }

    // The atoms are picked by their own ellipsoids, whichever level is drawn, so the pick keeps their centres and the
    // inverses of their shapes before a level takes the arrays as its own
    const inverses = invertCovariances(covariances)

    // Under auto every level is built, and the switch below shows one; a fixed Detail builds that level alone
    const built: readonly Level[] = detail === 'auto' ? levels : [detail]
    for (const level of built) {
      if (level === 'atoms') {
        // The atom level's paint is the atoms' own, which the merged levels are painted from
        current.paint = build(centers, covariances, null).paint
      } else {
        const grouping = levelGroups(structure, shown, level)
        const merged = mergeGaussians(centers, covariances, weights, grouping)
        build(merged.centers, merged.covariances, grouping)
      }
    }
    paintNow(current)
    setDrawnReach(reach)
    if (built.length > 1) showLevel(current, camera, size.height)
    drawn.current = current

    // A ray picks the atom whose ellipsoid it meets first, whichever level is drawn, so the label names the atom
    // under the pointer at every level, and an atom of the blob under it. It passes through an atom faded far out of
    // focus, and through whatever the cut has taken
    const found: EllipsoidHit = { index: -1, distance: Infinity }
    const pickable = (index: number) => isPickable(current.paint, index)
    const pick: PickTest = (raycaster, hit) => {
      const cut = cutAlong(raycaster.ray, raycaster.camera)
      nearestEllipsoid(raycaster.ray, centers, inverses, cut, found, pickable)
      if (found.index < 0 || found.distance >= hit.distance) return
      hit.atom = shown.rows[found.index]
      hit.distance = found.distance
    }
    const unregister = useStore.getState().registerPick(pick)

    return () => {
      unregister()
      for (const { instances, meshes } of current.levels) {
        for (const mesh of meshes) {
          scene.remove(mesh)
          mesh.material.dispose()
        }
        instances.geometry.dispose()
      }
      drawn.current = null
    }
  }, [get, structure, shown, bounds, scale, thermal, ellipsoids, detail, composite, solids, ghosts, backShell])

  // A new colouring, Burial, Focus, Fade or pick repaints the ellipsoids, in place
  useEffect(() => {
    if (drawn.current) paintFrom(drawn.current, paint)
  }, [paint])

  // Under auto, each frame shows the level whose ellipsoids are still a few pixels across at the view's distance
  useFrame(({ camera, size }) => {
    const current = drawn.current
    if (current && current.levels.length > 1) showLevel(current, camera, size.height)
  })

  return null
}
