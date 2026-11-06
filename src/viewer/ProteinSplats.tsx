import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { AdditiveBlending, Vector3, type Intersection } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import {
  createGaussianSplatGeometry,
  writeColorBytes,
  writeCovariance,
} from 'three/addons/utils/GaussianSplatUtils.js'
import type { NodeMaterial } from 'three/webgpu'
import { vdwRadius } from '../pdb/elements.ts'
import { isShown, shownModel, useStore, type PickTest } from '../store.ts'
import { atomColors } from './atomColors.ts'
import type { Bounds } from './bounds.ts'
import { focusTest, pickedKey } from './focus.ts'
import { beyondNear } from './nearPlane.ts'
import { writeEllipsoid } from './ellipsoids.ts'
import { asWebGPU } from './renderer.ts'
import { solidSphereColor, sphereDepth } from './shading.ts'
import { isDepthWritten, isSolid } from './styles.ts'

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

// An atom in focus has a full alpha byte, as Opacity acts through the shading's uniform and so never rebuilds the
// splats; one out of focus has Fade's share of it. Every model drawn at once overlaps the others, so each atom then
// keeps one over the square root of the number of models, and an atom in one of several conformations keeps its
// occupancy's share while they're all drawn
const fullAlpha = 255

// A B-factor is 8π² times its atom's mean square displacement along any one axis, in square ångströms
const bFactorPerVariance = 8 * Math.PI * Math.PI

interface Props {
  bounds: Bounds
  // The style's shading, which replaces the splats' own
  colorNode: NonNullable<NodeMaterial['colorNode']>
}

// One splat per shown atom, round or its thermal ellipsoid, centred on the structure's centroid
export function ProteinSplats({ bounds, colorNode }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const scale = useStore((s) => s.options.scale)
  const hydrogens = useStore((s) => s.options.hydrogens)
  const waters = useStore((s) => s.options.waters)
  const conformations = useStore((s) => s.options.conformations)
  const model = useStore(shownModel)
  const modelCount = useStore((s) => s.models.length)
  const thermal = useStore((s) => s.options.thermal)
  const ellipsoids = useStore((s) => s.options.ellipsoids)
  const focus = useStore((s) => s.options.focus)
  const fade = useStore((s) => s.options.fade)
  const picked = useStore((s) => pickedKey(s.options.focus, s.picked))
  const burial = useStore((s) => s.options.burial)
  const blend = useStore((s) => s.options.blend)
  const solid = useStore((s) => isSolid(s.options))
  const depthWritten = useStore((s) => isDepthWritten(s.options))

  useEffect(() => {
    const shown = atoms.filter((atom) => isShown(atom, { hydrogens, waters, conformations }, model))
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)
    const rgb = atomColors(shown, colorBy, atoms, burial)
    const inFocus = focusTest(atoms, focus, picked)
    const modelShare = model === null ? 1 / Math.sqrt(modelCount) : 1

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

      // Only an alternate's occupancy fades it: an atom without one may be given less than 1, and is still drawn whole
      const focusShare = !inFocus || inFocus(atom) ? 1 : fade
      const occupancyShare = conformations === 'all' && atom.altLoc !== '' ? atom.occupancy : 1
      const alpha = fullAlpha * focusShare * modelShare * occupancyShare
      writeColorBytes(colors, i * 4, rgb[i * 3] * 255, rgb[i * 3 + 1] * 255, rgb[i * 3 + 2] * 255, alpha)
    })

    // Added light doesn't depend on the order it's drawn in, nor does a weighted sum, and nor do solid spheres, as each
    // pixel keeps the nearest, so none of them is sorted as the camera moves
    const additive = blend === 'glow' || blend === 'weighted'
    const sorted = !additive && !solid
    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: sorted })
    splat.material.colorNode = solid ? solidSphereColor : colorNode
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
    // On the WebGL 2 fallback, only a sort moves the splat's data into the textures its shader reads, and the shader
    // is built for one or the other on its first draw, so an unsorted splat sorts once now, before it's ever drawn.
    // On WebGPU its draw order starts as every splat in turn
    if (!sorted) {
      const renderer = asWebGPU(gl)
      if (!('isWebGPUBackend' in renderer.backend)) splat.updateSort(renderer, camera)
    }

    // A ray picks the nearest splat it passes through, whose index is its atom's place among the shown atoms. three
    // skips the faintest splats, so atoms faded far out of focus can't be picked. A splat whose centre is nearer than
    // the near plane isn't drawn at all, so it can't be picked either
    const hits: Intersection[] = []
    const center = new Vector3()
    const pick: PickTest = (raycaster, hit) => {
      hits.length = 0
      splat.raycast(raycaster, hits)
      for (let h = 0; h < hits.length; h++) {
        const { index, distance } = hits[h]
        if (index === undefined || distance >= hit.distance) continue
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
    }
  }, [
    get,
    atoms,
    bounds,
    colorBy,
    scale,
    hydrogens,
    waters,
    conformations,
    model,
    modelCount,
    thermal,
    ellipsoids,
    focus,
    fade,
    picked,
    burial,
    blend,
    solid,
    depthWritten,
    colorNode,
  ])

  return null
}
