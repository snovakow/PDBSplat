import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef } from 'react'
import { AdditiveBlending, PerspectiveCamera, Vector3, type BufferGeometry, type Camera, type Intersection } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import { createGaussianSplatGeometry, writeCovariance } from 'three/addons/utils/GaussianSplatUtils.js'
import { useShallow } from 'zustand/react/shallow'
import { vdwRadius } from '../pdb/elements.ts'
import { residueKey, type Atom } from '../pdb/mmcif.ts'
import { shownAtoms, shownModel, useStore, type PickTest } from '../store.ts'
import {
  atomTexel,
  createAtomTable,
  isPickable,
  paintAtomTable,
  paintMergedTable,
  writeAtomIndex,
  type AtomTable,
  type TablePaint,
} from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { writeEllipsoid } from './ellipsoids.ts'
import { pickedKey } from './focus.ts'
import {
  groupBy,
  levels,
  levelToDraw,
  mergeGaussians,
  pixelsPerUnit,
  typicalDiameter,
  type Grouping,
  type Level,
} from './levels.ts'
import { beyondNear } from './nearPlane.ts'
import { nearestSphere, type SphereHit } from './raySpheres.ts'
import { asWebGPU } from './renderer.ts'
import { cutSphereColor, solidSphereColor, sphereDepth, sphereEntry, sphereExit, type SplatShading } from './shading.ts'
import { createSphereTables, disposeSphereTables, overlapCut, type SphereTables } from './sphereTable.ts'
import { isBackShell, isCut, isSolid } from './styles.ts'

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

// The back shell's place in the draw, ahead of every splat at three's default of 0, so that the far side is drawn first
// and the near side composites over it whatever order the sort gives the splats
const backShellOrder = -1

// A B-factor is 8π² times its atom's mean square displacement along any one axis, in square ångströms
const bFactorPerVariance = 8 * Math.PI * Math.PI

interface Props {
  bounds: Bounds
  // The style's shading, which replaces the splats' own
  colorNode: SplatShading
}

// A merged level's table and what it's painted from: its members' groups and the weights they were merged by
interface MergedTable {
  table: AtomTable
  grouping: Grouping
  weights: Float32Array
}

// The levels while they're drawn: the atom table, what it was last painted from, the merged levels' tables painted from
// it, the cut spheres' tables while the spheres are cut, each built level's splat, finest first, with its typical
// drawn diameter, which the switch reads, and the back shell's splat while it's drawn, kept beside the levels' splats so
// that the switch shows and hides it with the atom level
interface Drawn {
  table: AtomTable
  painted: TablePaint | null
  merged: MergedTable[]
  spheres: SphereTables | null
  splats: GaussianSplat[]
  diameters: number[]
  back: GaussianSplat | null
}

// Paints the tables from their inputs, unless they were painted from them already: the atom table from the inputs, and
// each merged level's from the atom table
function paintFrom(current: Drawn, inputs: TablePaint) {
  if (current.painted === inputs) return
  paintAtomTable(current.table, inputs)
  for (const { table, grouping, weights } of current.merged) paintMergedTable(table, current.table, grouping, weights)
  current.painted = inputs
}

// The way the camera looks, which the structure's depth is measured along
const forward = new Vector3()

// Shows the one level whose Gaussians are still a few pixels across at the view depth of the structure's centre, which
// sits at the origin, as the camera orbits, zooms or pans, and hides the rest, which then run no sort. With the centre
// at or behind the camera its depth sets no scale, and the finest level stands
function showLevel({ splats, diameters, back }: Drawn, camera: Camera, viewportHeight: number) {
  if (!(camera instanceof PerspectiveCamera)) return
  const centreDepth = -camera.position.dot(forward.set(0, 0, -1).applyQuaternion(camera.quaternion))
  const level = centreDepth > 0 ? levelToDraw(diameters, pixelsPerUnit(viewportHeight, camera.fov, centreDepth)) : 0
  for (let i = 0; i < splats.length; i++) splats[i].visible = i === level
  if (back) back.visible = level === 0
}

// The groups a merged level merges: each residue, or each chain, within its own model, so that every model drawn at
// once keeps its own blobs
const groupKeys: Record<Exclude<Level, 'atoms'>, (atom: Atom) => string> = {
  residues: (atom) => `${atom.model} ${residueKey(atom)}`,
  chains: (atom) => `${atom.model} ${atom.chain}`,
}

// One splat per shown atom, round or its thermal ellipsoid, centred on the structure's centroid, or one per residue or
// per chain, each the moment match of its atoms' splats, as Detail asks, and every level under auto. Each splat's
// colour bytes carry its atom's, or its group's, index into its level's atom table, which holds the colour and the
// alpha, so that a change of either repaints the tables in place and rebuilds nothing
export function ProteinSplats({ bounds, colorNode }: Props) {
  const get = useThree((s) => s.get)
  const scale = useStore((s) => s.options.scale)
  const thermal = useStore((s) => s.options.thermal)
  const ellipsoids = useStore((s) => s.options.ellipsoids)
  const blend = useStore((s) => s.options.blend)
  const detail = useStore((s) => s.options.detail)
  const solid = useStore((s) => isSolid(s.options))
  const cut = useStore((s) => isCut(s.options))
  const backShell = useStore((s) => isBackShell(s.options))
  // What the table is painted from, in one object that stands while its fields do. The shown atoms already follow
  // Hydrogens, Waters, Alternates and the model, which the alpha factors read as well
  const paint = useStore(
    useShallow(
      (s): TablePaint => ({
        shown: shownAtoms(s),
        entry: s.atoms,
        colorBy: s.options.colorBy,
        burial: s.options.burial,
        focus: s.options.focus,
        picked: pickedKey(s.options.focus, s.picked),
        fade: s.options.fade,
        model: shownModel(s),
        modelCount: s.models.length,
        conformations: s.options.conformations,
      }),
    ),
  )
  const { shown } = paint
  const drawn = useRef<Drawn | null>(null)

  // Paints the new tables from the inputs as they stand now, so that the build below needn't depend on them and no
  // frame draws a table blank
  const paintNow = useEffectEvent((current: Drawn) => paintFrom(current, paint))

  useEffect(() => {
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    // Each atom's van der Waals radius at Size, and its share of the blob it's merged into: its van der Waals volume,
    // which goes as that radius cubed. A round splat's sphere is drawn out to its edge, which Thermal swells, and the
    // cut spheres' table holds that drawn radius
    const radii = new Float32Array(shown.length)
    const drawnRadii = new Float32Array(shown.length)
    const weights = new Float32Array(shown.length)

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      const radius = vdwRadius(atom.element) * scale
      radii[i] = radius
      weights[i] = radius * radius * radius
      if (ellipsoids) {
        writeEllipsoid(covariances, i * 6, atom, scale)
      } else {
        // Thermal motion spreads the atom by its displacement, whose variance adds to the splat's own
        const size = radius / kernelCutoff
        const sigma = Math.sqrt(size * size + (thermal * Math.max(atom.bFactor, 0)) / bFactorPerVariance)
        writeCovariance(covariances, i * 6, sigma, sigma, sigma, 0, 0, 0, 1)
        drawnRadii[i] = sigma * kernelCutoff
      }
    })

    // Added light doesn't depend on the order it's drawn in, nor does a weighted sum, and nor do solid spheres, as each
    // pixel keeps the nearest, so none of them is sorted as the camera moves
    const additive = blend === 'glow' || blend === 'weighted'
    const sorted = !additive && !solid
    const { scene, gl, camera, size } = get()
    const renderer = asWebGPU(gl)
    const fallback = !('isWebGPUBackend' in renderer.backend)
    const current: Drawn = {
      table: createAtomTable(shown.length),
      painted: null,
      merged: [],
      spheres: null,
      splats: [],
      diameters: [],
      back: null,
    }
    const geometries: BufferGeometry[] = []

    // A level's splat on its centres and covariances, reading its table: the atom level as its style and options ask,
    // and a merged level as translucent ellipsoids in the style's shading, sorted as the soft splats are, since a
    // sphere's depth is worked out for round splats and a blob is seldom round
    const build = (levelCenters: Float32Array, levelCovariances: Float32Array, table: AtomTable, atomLevel: boolean) => {
      const count = levelCenters.length / 3
      const colors = new Uint8ClampedArray(count * 4)
      // The colour bytes carry the Gaussian's place in its level, which is its splat index and its texel's
      for (let i = 0; i < count; i++) writeAtomIndex(colors, i * 4, i)
      const geometry = createGaussianSplatGeometry(levelCenters, levelCovariances, colors)
      const levelSorted = atomLevel ? sorted : !additive
      const levelSolid = atomLevel && solid
      const splat = new GaussianSplat(geometry, { autoSort: levelSorted })
      // A translucent sphere is sorted and blended as the soft splats are, and cut where its surface lies inside a
      // neighbouring sphere, so that nothing inside the overlaps is drawn: the parts a stale order between the
      // splats' re-sorts could draw wrong are exactly those, and what's left shows the union's surface with its creases
      const spheres = atomLevel && cut ? createSphereTables(levelCenters, drawnRadii) : null
      if (spheres) current.spheres = spheres
      const shading = levelSolid
        ? solidSphereColor
        : spheres
          ? cutSphereColor(overlapCut(spheres, sphereEntry))
          : colorNode
      splat.material.colorNode = shading(atomTexel(table))
      if (additive) splat.material.blending = AdditiveBlending
      // A weighted splat adds its colour and its alpha into the sums the composite resolves, so it writes its colour
      // already multiplied by its alpha, and the blend adds both as they are
      if (blend === 'weighted') splat.material.premultipliedAlpha = true
      // A solid sphere writes the depth of its surface, and its edge's fade sets how much of each pixel it covers, so
      // its rim stays smooth with nothing behind it showing through
      if (levelSolid) {
        splat.material.depthNode = sphereDepth
        splat.material.transparent = false
        splat.material.depthWrite = true
        splat.material.alphaToCoverage = true
      }
      scene.add(splat)
      // On the WebGL 2 fallback, only a sort moves the splat's data into the textures its shader reads, and the shader
      // is built for one or the other on its first draw, so an unsorted splat sorts once now, before it's ever drawn.
      // On WebGPU its draw order starts as every splat in turn
      if (!levelSorted && fallback) splat.updateSort(renderer, camera)
      geometries.push(geometry)
      current.splats.push(splat)
      current.diameters.push(typicalDiameter(levelCovariances, kernelCutoff))
      // With the back shell on, a second splat on the same geometry draws the far side of the union under the near:
      // its fragment takes the exit of the pixel's ray from its sphere, cut where the exit lies inside a neighbour, and
      // it draws ahead of every other splat, so that back under front is the draw's doing and not the sort's. It sorts
      // for itself, as the first does, and it's shown with the atom level alone, as the merged levels take no cut
      if (spheres && backShell) {
        const back = new GaussianSplat(geometry, { autoSort: true })
        back.material.colorNode = cutSphereColor(overlapCut(spheres, sphereExit))(atomTexel(table))
        back.renderOrder = backShellOrder
        scene.add(back)
        current.back = back
      }
    }

    // Under auto every level is built, and the switch below shows one; a fixed Detail builds that level alone
    const built: readonly Level[] = detail === 'auto' ? levels : [detail]
    for (const level of built) {
      if (level === 'atoms') {
        build(centers, covariances, current.table, true)
      } else {
        const grouping = groupBy(shown, groupKeys[level])
        const merged = mergeGaussians(centers, covariances, weights, grouping)
        const table = createAtomTable(grouping.count)
        current.merged.push({ table, grouping, weights })
        build(merged.centers, merged.covariances, table, false)
      }
    }
    paintNow(current)
    if (built.length > 1) showLevel(current, camera, size.height)
    drawn.current = current

    // A ray picks the nearest splat it passes through, whose index is its atom's place among the shown atoms. three
    // skips the faintest splats by their own alpha, which is always full, so the pick skips an atom whose table
    // alpha is below that threshold instead, and atoms faded far out of focus can't be picked. A splat whose centre is
    // nearer than the near plane isn't drawn at all, so it can't be picked either. The atom level's splat is tested
    // whether or not it's the level shown, so the label names the atom under the pointer at every level
    const hits: Intersection[] = []
    const center = new Vector3()
    const pickSplat = (splat: GaussianSplat): PickTest => (raycaster, hit) => {
      hits.length = 0
      splat.raycast(raycaster, hits)
      for (let h = 0; h < hits.length; h++) {
        const { index, distance } = hits[h]
        if (index === undefined || distance >= hit.distance) continue
        if (!isPickable(current.table, index)) continue
        if (!beyondNear(center.fromArray(centers, index * 3), raycaster.camera)) continue
        hit.atom = shown[index]
        hit.distance = distance
      }
    }
    // With a merged level fixed, the atoms have no splat to test, so the pick finds the nearest atom's sphere along the
    // ray at its van der Waals radius at Size, as the surface does, and names an atom of the blob under the pointer.
    // The ray passes through an atom faded far out of focus, as it does through its splat at the atom level
    const pickSpheres = (): PickTest => {
      const pickable = (index: number) => isPickable(current.table, index)
      const sphereHit: SphereHit = { index: -1, distance: Infinity }
      return (raycaster, hit) => {
        nearestSphere(raycaster.ray, centers, radii, raycaster.camera, sphereHit, pickable)
        if (sphereHit.index < 0 || sphereHit.distance >= hit.distance) return
        hit.atom = shown[sphereHit.index]
        hit.distance = sphereHit.distance
      }
    }
    const pick = built[0] === 'atoms' ? pickSplat(current.splats[0]) : pickSpheres()
    const unregister = useStore.getState().registerPick(pick)

    // GaussianSplat has no dispose(): its storage buffers go when it's garbage-collected, so nothing keeps it
    return () => {
      unregister()
      const splats = current.back ? [...current.splats, current.back] : current.splats
      for (const splat of splats) {
        scene.remove(splat)
        splat.geometry.dispose()
        splat.material.dispose()
      }
      for (const geometry of geometries) geometry.dispose()
      current.table.texture.dispose()
      for (const { table } of current.merged) table.texture.dispose()
      if (current.spheres) disposeSphereTables(current.spheres)
      drawn.current = null
    }
  }, [get, shown, bounds, scale, thermal, ellipsoids, blend, detail, solid, cut, backShell, colorNode])

  // A new colouring, Burial, Focus, Fade or pick repaints the tables the splats read, in place
  useEffect(() => {
    if (drawn.current) paintFrom(drawn.current, paint)
  }, [paint])

  // Under auto, each frame shows the level whose Gaussians are still a few pixels across at the view's distance
  useFrame(({ camera, size }) => {
    const current = drawn.current
    if (current && current.splats.length > 1) showLevel(current, camera, size.height)
  })

  return null
}
