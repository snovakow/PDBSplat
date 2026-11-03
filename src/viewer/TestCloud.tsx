import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { Color } from 'three'
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js'
import {
  createGaussianSplatGeometry,
  writeColorBytes,
  writeCovariance,
} from 'three/addons/utils/GaussianSplatUtils.js'

// Temporary: procedural splats that prove the GaussianSplat pipeline; Phase 5 replaces them with the protein
const COUNT = 4000
const RADIUS = 20

export function TestCloud() {
  const get = useThree((s) => s.get)

  useEffect(() => {
    const centers = new Float32Array(COUNT * 3)
    const covariances = new Float32Array(COUNT * 6)
    const colors = new Uint8ClampedArray(COUNT * 4)
    const color = new Color()
    const golden = Math.PI * (3 - Math.sqrt(5))

    // A Fibonacci sphere, coloured by latitude, with sizes and opacities varied at random
    for (let i = 0; i < COUNT; i++) {
      const y = 1 - (2 * (i + 0.5)) / COUNT
      const ring = Math.sqrt(1 - y * y)
      const theta = golden * i
      centers[i * 3] = RADIUS * ring * Math.cos(theta)
      centers[i * 3 + 1] = RADIUS * y
      centers[i * 3 + 2] = RADIUS * ring * Math.sin(theta)

      const size = 0.3 + Math.random() * 1.2
      writeCovariance(covariances, i * 6, size, size, size, 0, 0, 0, 1)

      color.setHSL((y + 1) / 2, 0.8, 0.55)
      writeColorBytes(colors, i * 4, color.r * 255, color.g * 255, color.b * 255, 128 + Math.random() * 127)
    }

    const geometry = createGaussianSplatGeometry(centers, covariances, colors)
    const splat = new GaussianSplat(geometry, { autoSort: true })
    const { scene } = get()
    scene.add(splat)

    return () => {
      scene.remove(splat)
      splat.geometry.dispose()
      splat.material.dispose()
      geometry.dispose()
    }
  }, [get])

  return null
}
