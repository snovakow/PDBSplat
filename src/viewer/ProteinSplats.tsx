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

// Every splat's alpha byte is full, as Opacity acts through the shading's uniform and so never rebuilds the splats
const fullAlpha = 255

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

  useEffect(() => {
    const shown = atoms.filter((atom) => isShown(atom, { hydrogens, waters }))
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)
    const rgb = atomColors(shown, colorBy)

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      const sigma = (vdwRadius(atom.element) * scale) / kernelCutoff
      writeCovariance(covariances, i * 6, sigma, sigma, sigma, 0, 0, 0, 1)

      writeColorBytes(colors, i * 4, rgb[i * 3] * 255, rgb[i * 3 + 1] * 255, rgb[i * 3 + 2] * 255, fullAlpha)
    })

    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: true })
    splat.material.colorNode = colorNode
    const { scene } = get()
    scene.add(splat)

    // GaussianSplat has no dispose(): its storage buffers go when it's garbage-collected, so nothing keeps it
    return () => {
      scene.remove(splat)
      splat.geometry.dispose()
      splat.material.dispose()
      geometry.dispose()
    }
  }, [get, atoms, bounds, colorBy, scale, hydrogens, waters, colorNode])

  return null
}
