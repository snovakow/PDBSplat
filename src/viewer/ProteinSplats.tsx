import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { AdditiveBlending } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import {
  createGaussianSplatGeometry,
  writeColorBytes,
  writeCovariance,
} from 'three/addons/utils/GaussianSplatUtils.js'
import type { NodeMaterial } from 'three/webgpu'
import { vdwRadius } from '../pdb/elements.ts'
import { isShown, useStore } from '../store.ts'
import { atomColors } from './atomColors.ts'
import type { Bounds } from './bounds.ts'
import { focusTest } from './focus.ts'
import { asWebGPU } from './renderer.ts'

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

// An atom in focus has a full alpha byte, as Opacity acts through the shading's uniform and so never rebuilds the
// splats; one out of focus has Fade's share of it
const fullAlpha = 255

// A B-factor is 8π² times its atom's mean square displacement along any one axis, in square ångströms
const bFactorPerVariance = 8 * Math.PI * Math.PI

interface Props {
  bounds: Bounds
  // The style's shading, which replaces the splats' own
  colorNode: NonNullable<NodeMaterial['colorNode']>
}

// One round splat per shown atom, centred on the structure's centroid
export function ProteinSplats({ bounds, colorNode }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const scale = useStore((s) => s.options.scale)
  const hydrogens = useStore((s) => s.options.hydrogens)
  const waters = useStore((s) => s.options.waters)
  const thermal = useStore((s) => s.options.thermal)
  const focus = useStore((s) => s.options.focus)
  const fade = useStore((s) => s.options.fade)
  const burial = useStore((s) => s.options.burial)
  const blend = useStore((s) => s.options.blend)

  useEffect(() => {
    const shown = atoms.filter((atom) => isShown(atom, { hydrogens, waters }))
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)
    const rgb = atomColors(shown, colorBy, atoms, burial)
    const inFocus = focusTest(atoms, focus)

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      // Thermal motion spreads the atom by its displacement, whose variance adds to the splat's own
      const size = (vdwRadius(atom.element) * scale) / kernelCutoff
      const sigma = Math.sqrt(size * size + (thermal * Math.max(atom.bFactor, 0)) / bFactorPerVariance)
      writeCovariance(covariances, i * 6, sigma, sigma, sigma, 0, 0, 0, 1)

      const alpha = !inFocus || inFocus(atom) ? fullAlpha : fullAlpha * fade
      writeColorBytes(colors, i * 4, rgb[i * 3] * 255, rgb[i * 3 + 1] * 255, rgb[i * 3 + 2] * 255, alpha)
    })

    // Added light doesn't depend on the order it's drawn in, so glowing splats aren't sorted as the camera moves
    const glow = blend === 'glow'
    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: !glow })
    splat.material.colorNode = colorNode
    if (glow) splat.material.blending = AdditiveBlending
    const { scene, gl, camera } = get()
    scene.add(splat)
    // On the WebGL 2 fallback, only a sort moves the splat's data into the textures its shader reads, and the shader
    // is built for one or the other on its first draw, so an unsorted splat sorts once now, before it's ever drawn.
    // On WebGPU its draw order starts as every splat in turn
    if (glow) {
      const renderer = asWebGPU(gl)
      if (!('isWebGPUBackend' in renderer.backend)) splat.updateSort(renderer, camera)
    }

    // GaussianSplat has no dispose(): its storage buffers go when it's garbage-collected, so nothing keeps it
    return () => {
      scene.remove(splat)
      splat.geometry.dispose()
      splat.material.dispose()
      geometry.dispose()
    }
  }, [get, atoms, bounds, colorBy, scale, hydrogens, waters, thermal, focus, fade, burial, blend, colorNode])

  return null
}
