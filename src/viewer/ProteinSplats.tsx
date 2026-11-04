import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
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

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

interface Props {
  bounds: Bounds
  // Replaces the splats' shading, or null keeps their soft Gaussian falloff
  colorNode: NodeMaterial['colorNode']
}

// One round splat per shown atom, centred on the structure's centroid
export function ProteinSplats({ bounds, colorNode }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const options = useStore((s) => s.options)

  useEffect(() => {
    const shown = atoms.filter((atom) => isShown(atom, options))
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)
    const rgb = atomColors(shown, options.colorBy)
    const alpha = options.opacity * 255

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      const scale = (vdwRadius(atom.element) * options.scale) / kernelCutoff
      writeCovariance(covariances, i * 6, scale, scale, scale, 0, 0, 0, 1)

      writeColorBytes(colors, i * 4, rgb[i * 3] * 255, rgb[i * 3 + 1] * 255, rgb[i * 3 + 2] * 255, alpha)
    })

    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: true })
    if (colorNode) splat.material.colorNode = colorNode
    const { scene } = get()
    scene.add(splat)

    // GaussianSplat has no dispose(): its storage buffers go when it's garbage-collected, so nothing keeps it
    return () => {
      scene.remove(splat)
      splat.geometry.dispose()
      splat.material.dispose()
      geometry.dispose()
    }
  }, [get, atoms, bounds, options, colorNode])

  return null
}
