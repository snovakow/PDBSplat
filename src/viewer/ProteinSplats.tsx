import { useThree } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef } from 'react'
import { AdditiveBlending, Vector3, type Intersection } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import { createGaussianSplatGeometry, writeCovariance } from 'three/addons/utils/GaussianSplatUtils.js'
import { useShallow } from 'zustand/react/shallow'
import { vdwRadius } from '../pdb/elements.ts'
import { shownAtoms, shownModel, useStore, type PickTest } from '../store.ts'
import {
  atomTexel,
  createAtomTable,
  isPickable,
  paintAtomTable,
  writeAtomIndex,
  type AtomTable,
  type TablePaint,
} from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { writeEllipsoid } from './ellipsoids.ts'
import { pickedKey } from './focus.ts'
import { beyondNear } from './nearPlane.ts'
import { asWebGPU } from './renderer.ts'
import { solidSphereColor, sphereDepth, type SplatShading } from './shading.ts'
import { isDepthWritten, isSolid } from './styles.ts'

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

// A B-factor is 8π² times its atom's mean square displacement along any one axis, in square ångströms
const bFactorPerVariance = 8 * Math.PI * Math.PI

interface Props {
  bounds: Bounds
  // The style's shading, which replaces the splats' own
  colorNode: SplatShading
}

// The splats' atom table while they're drawn, and what it was last painted from
interface PaintedTable {
  table: AtomTable
  painted: TablePaint | null
}

// Paints a table from its inputs, unless it was painted from them already
function paintFrom(current: PaintedTable, inputs: TablePaint) {
  if (current.painted === inputs) return
  paintAtomTable(current.table, inputs)
  current.painted = inputs
}

// One splat per shown atom, round or its thermal ellipsoid, centred on the structure's centroid. Each splat's colour
// bytes carry its atom's index into the atom table, which holds the colour and the alpha, so that a change of either
// repaints the table in place and rebuilds nothing
export function ProteinSplats({ bounds, colorNode }: Props) {
  const get = useThree((s) => s.get)
  const scale = useStore((s) => s.options.scale)
  const thermal = useStore((s) => s.options.thermal)
  const ellipsoids = useStore((s) => s.options.ellipsoids)
  const blend = useStore((s) => s.options.blend)
  const solid = useStore((s) => isSolid(s.options))
  const depthWritten = useStore((s) => isDepthWritten(s.options))
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
  const drawn = useRef<PaintedTable | null>(null)

  // Paints a new table from the inputs as they stand now, so that the build below needn't depend on them and no frame
  // draws the table blank
  const paintNow = useEffectEvent((current: PaintedTable) => paintFrom(current, paint))

  useEffect(() => {
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      if (ellipsoids) {
        writeEllipsoid(covariances, i * 6, atom, scale)
      } else {
        // Thermal motion spreads the atom by its displacement, whose variance adds to the splat's own
        const size = (vdwRadius(atom.element) * scale) / kernelCutoff
        const sigma = Math.sqrt(size * size + (thermal * Math.max(atom.bFactor, 0)) / bFactorPerVariance)
        writeCovariance(covariances, i * 6, sigma, sigma, sigma, 0, 0, 0, 1)
      }

      // The colour bytes carry the atom's place among the shown atoms, which is its splat index and its texel's
      writeAtomIndex(colors, i * 4, i)
    })

    // Added light doesn't depend on the order it's drawn in, nor does a weighted sum, and nor do solid spheres, as each
    // pixel keeps the nearest, so none of them is sorted as the camera moves
    const additive = blend === 'glow' || blend === 'weighted'
    const sorted = !additive && !solid
    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: sorted })
    const current: PaintedTable = { table: createAtomTable(shown.length), painted: null }
    paintNow(current)
    splat.material.colorNode = (solid ? solidSphereColor : colorNode)(atomTexel(current.table))
    if (additive) splat.material.blending = AdditiveBlending
    // A weighted splat adds its colour and its alpha into the sums the composite resolves, so it writes its colour
    // already multiplied by its alpha, and the blend adds both as they are
    if (blend === 'weighted') splat.material.premultipliedAlpha = true
    // A solid sphere writes the depth of its surface, and its edge's fade sets how much of each pixel it covers, so its
    // rim stays smooth with nothing behind it showing through
    if (solid) {
      splat.material.depthNode = sphereDepth
      splat.material.transparent = false
      splat.material.depthWrite = true
      splat.material.alphaToCoverage = true
    } else if (depthWritten) {
      // A translucent sphere is sorted and blended as the soft splats are, and writes the depth of its surface too, so
      // that where two spheres meet the nearer cuts into the farther, and a pair drawn in a stale order between the
      // splats' re-sorts loses only the farther one's share under the nearer, until the next re-sort brings it back
      splat.material.depthNode = sphereDepth
      splat.material.depthWrite = true
    }
    const { scene, gl, camera } = get()
    scene.add(splat)
    drawn.current = current
    // On the WebGL 2 fallback, only a sort moves the splat's data into the textures its shader reads, and the shader
    // is built for one or the other on its first draw, so an unsorted splat sorts once now, before it's ever drawn.
    // On WebGPU its draw order starts as every splat in turn
    if (!sorted) {
      const renderer = asWebGPU(gl)
      if (!('isWebGPUBackend' in renderer.backend)) splat.updateSort(renderer, camera)
    }

    // A ray picks the nearest splat it passes through, whose index is its atom's place among the shown atoms. three
    // skips the faintest splats by their own alpha, which is always full, so the pick skips an atom whose table
    // alpha is below that threshold instead, and atoms faded far out of focus can't be picked. A splat whose centre is
    // nearer than the near plane isn't drawn at all, so it can't be picked either
    const hits: Intersection[] = []
    const center = new Vector3()
    const pick: PickTest = (raycaster, hit) => {
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
    const unregister = useStore.getState().registerPick(pick)

    // GaussianSplat has no dispose(): its storage buffers go when it's garbage-collected, so nothing keeps it
    return () => {
      unregister()
      scene.remove(splat)
      splat.geometry.dispose()
      splat.material.dispose()
      geometry.dispose()
      current.table.texture.dispose()
      drawn.current = null
    }
  }, [get, shown, bounds, scale, thermal, ellipsoids, blend, solid, depthWritten, colorNode])

  // A new colouring, Burial, Focus, Fade or pick repaints the table the splats read, in place
  useEffect(() => {
    if (drawn.current) paintFrom(drawn.current, paint)
  }, [paint])

  return null
}
