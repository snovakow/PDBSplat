import type { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, type ComponentRef, type RefObject } from 'react'
import { Color, MathUtils, PerspectiveCamera, Vector3 } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import {
  createGaussianSplatGeometry,
  writeColorBytes,
  writeCovariance,
} from 'three/addons/utils/GaussianSplatUtils.js'
import { elementColor, vdwRadius } from '../pdb/elements.ts'
import type { Atom } from '../pdb/mmcif.ts'
import { isShown, useStore } from '../store.ts'
import { styleColorNode } from './styles.ts'

// three draws each splat out to two standard deviations, so a splat's visible edge sits at twice its scale
const kernelCutoff = 2

// Room around the structure when it's framed
const frameMargin = 1.15

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
}

// One round splat per shown atom, centred on the structure's centroid
export function ProteinSplats({ controlsRef }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const options = useStore((s) => s.options)
  const bounds = useMemo(() => measure(atoms), [atoms])

  useEffect(() => {
    const shown = atoms.filter((atom) => isShown(atom, options))
    if (shown.length === 0) return undefined

    const centers = new Float32Array(shown.length * 3)
    const covariances = new Float32Array(shown.length * 6)
    const colors = new Uint8ClampedArray(shown.length * 4)
    const chainColors = new Map<string, Color>()
    const alpha = options.opacity * 255

    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z

      const scale = (vdwRadius(atom.element) * options.scale) / kernelCutoff
      writeCovariance(covariances, i * 6, scale, scale, scale, 0, 0, 0, 1)

      const color = options.colorBy === 'chain' ? chainColor(chainColors, atom.chain) : elementColor(atom.element)
      writeColorBytes(colors, i * 4, color.r * 255, color.g * 255, color.b * 255, alpha)
    })

    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: true })
    const colorNode = styleColorNode(options.style)
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
  }, [get, atoms, bounds, options])

  // A new entry is framed whole, looking down the z axis at its centroid
  useEffect(() => {
    const controls = controlsRef.current
    const { camera } = get()
    if (atoms.length === 0 || !controls || !(camera instanceof PerspectiveCamera)) return

    const halfFov = MathUtils.degToRad(camera.fov) / 2
    const halfFovX = Math.atan(Math.tan(halfFov) * camera.aspect)
    const distance = (bounds.radius / Math.sin(Math.min(halfFov, halfFovX))) * frameMargin

    camera.position.set(0, 0, distance)
    camera.near = bounds.radius / 100
    camera.far = distance * 4 + bounds.radius
    camera.updateProjectionMatrix()
    // Zooming out stops well before the far plane would clip the structure
    controls.maxDistance = distance * 3
    controls.target.set(0, 0, 0)
    controls.update()
  }, [get, controlsRef, atoms, bounds])

  return null
}

// The centroid, and the radius around it that holds every atom's van der Waals sphere
function measure(atoms: Atom[]) {
  const center = new Vector3()
  for (const atom of atoms) {
    center.x += atom.x
    center.y += atom.y
    center.z += atom.z
  }
  if (atoms.length > 0) center.divideScalar(atoms.length)

  let radius = 0
  for (const atom of atoms) {
    const distance = Math.hypot(atom.x - center.x, atom.y - center.y, atom.z - center.z)
    radius = Math.max(radius, distance + vdwRadius(atom.element))
  }
  return { center, radius }
}

// Chains take hues a golden angle apart, in the order they first appear, so neighbours differ
function chainColor(colors: Map<string, Color>, chain: string) {
  let color = colors.get(chain)
  if (!color) {
    color = new Color().setHSL((colors.size * 0.618034) % 1, 0.75, 0.55)
    colors.set(chain, color)
  }
  return color
}
