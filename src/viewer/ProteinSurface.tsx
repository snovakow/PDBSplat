import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Mesh, type Object3D, type PointLight } from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { vdwRadius } from '../pdb/elements.ts'
import type { Atom } from '../pdb/mmcif.ts'
import { isShown, useStore, type ColorBy } from '../store.ts'
import { requestSurface } from '../surface/surfaceWorker.ts'
import { atomColors } from './atomColors.ts'
import type { Bounds } from './bounds.ts'

interface Props {
  bounds: Bounds
}

// A drawn surface, with what a recolour needs: the atoms it was built from, and each vertex's atom among them
interface Surface {
  mesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  // The same mesh, drawn first into depth alone, so that a see-through surface shows only its nearest layer
  depth: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  colors: BufferAttribute
  atoms: Atom[]
  shown: Atom[]
  owners: Uint32Array
}

// The shown atoms' surface, meshed by marching cubes in a worker, and lit from above and below and from the camera
export function ProteinSurface({ bounds }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const burial = useStore((s) => s.options.burial)
  const scale = useStore((s) => s.options.scale)
  const opacity = useStore((s) => s.options.opacity)
  const hydrogens = useStore((s) => s.options.hydrogens)
  const waters = useStore((s) => s.options.waters)
  const resolution = useStore((s) => s.options.resolution)
  const material = useRef<MeshStandardNodeMaterial | null>(null)
  const depthMaterial = useRef<MeshBasicNodeMaterial | null>(null)
  const surface = useRef<Surface | null>(null)
  const headlight = useRef<PointLight>(null)

  // The headlight follows the camera, so the side in view is always lit
  useFrame(({ camera }) => {
    headlight.current?.position.copy(camera.position)
  })

  // The materials serve every surface while this style is on, and go with the last one
  useEffect(() => {
    const created = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 })
    const depthOnly = new MeshBasicNodeMaterial({ colorWrite: false })
    material.current = created
    depthMaterial.current = depthOnly
    return () => {
      if (surface.current) discard(get().scene, surface.current)
      surface.current = null
      material.current = null
      depthMaterial.current = null
      created.dispose()
      depthOnly.dispose()
    }
  }, [get])

  useEffect(() => {
    const { scene } = get()
    // A new entry's surface goes at once; for a changed option, the old one stays until the new one is ready
    if (surface.current && surface.current.atoms !== atoms) {
      discard(scene, surface.current)
      surface.current = null
    }
    const shown = atoms.filter((atom) => isShown(atom, { hydrogens, waters }))
    if (shown.length === 0) {
      if (surface.current) discard(scene, surface.current)
      surface.current = null
      return undefined
    }

    const centers = new Float32Array(shown.length * 3)
    const radii = new Float32Array(shown.length)
    shown.forEach((atom, i) => {
      centers[i * 3] = atom.x - bounds.center.x
      centers[i * 3 + 1] = atom.y - bounds.center.y
      centers[i * 3 + 2] = atom.z - bounds.center.z
      radii[i] = vdwRadius(atom.element) * scale
    })

    // A cancelled request can still arrive, during a drag, and shows until the latest does, unless its entry has gone.
    // Results arrive in the order they were asked for, so one never replaces a newer surface
    const request = requestSurface({ centers, radii, spacing: 1 / resolution })
    request.result.then(
      ({ mesh: built, milliseconds }) => {
        const surfaceMaterial = material.current
        const surfaceDepth = depthMaterial.current
        if (!surfaceMaterial || !surfaceDepth || useStore.getState().atoms !== atoms) return
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(built.positions, 3))
        geometry.setAttribute('normal', new BufferAttribute(built.normals, 3))
        const colors = new BufferAttribute(new Float32Array(built.positions.length), 3)
        geometry.setAttribute('color', colors)
        geometry.setIndex(new BufferAttribute(built.indices, 1))
        geometry.computeBoundingSphere()

        const next: Surface = {
          mesh: new Mesh(geometry, surfaceMaterial),
          depth: new Mesh(geometry, surfaceDepth),
          colors,
          atoms,
          shown,
          owners: built.owners,
        }
        const { options } = useStore.getState()
        paint(next, options.colorBy, options.burial)
        if (surface.current) discard(scene, surface.current)
        scene.add(next.depth, next.mesh)
        surface.current = next
        console.info(
          `PDBSplat: surface of ${shown.length} atoms at ${built.spacing.toFixed(2)} Å: ` +
            `${built.positions.length / 3} vertices, ${built.indices.length / 3} triangles, in ${Math.round(milliseconds)} ms`,
        )
      },
      (error: unknown) => console.warn(`PDBSplat: the surface couldn't be meshed: ${String(error)}`),
    )
    return () => request.cancel()
  }, [get, atoms, bounds, scale, hydrogens, waters, resolution])

  // A new colouring or Burial repaints the vertices from their atoms, without meshing again
  useEffect(() => {
    if (surface.current) paint(surface.current, colorBy, burial)
  }, [colorBy, burial])

  // Below full opacity, the depth pass draws first, as it's opaque, and hides every layer but the nearest
  useEffect(() => {
    const surfaceMaterial = material.current
    const surfaceDepth = depthMaterial.current
    if (!surfaceMaterial || !surfaceDepth) return
    const transparent = opacity < 1
    if (surfaceMaterial.transparent !== transparent) {
      surfaceMaterial.transparent = transparent
      surfaceMaterial.needsUpdate = true
    }
    surfaceMaterial.opacity = opacity
    surfaceDepth.visible = transparent
  }, [opacity])

  return (
    <>
      <hemisphereLight args={['#ffffff', '#404040', 1]} />
      <pointLight ref={headlight} decay={0} intensity={2.2} />
    </>
  )
}

// Each vertex takes the colour of the atom adding the most density there
function paint({ colors, atoms, shown, owners }: Surface, colorBy: ColorBy, burial: number) {
  const atomRgb = atomColors(shown, colorBy, atoms, burial)
  const rgb = colors.array
  for (let v = 0; v < owners.length; v++) {
    const a = owners[v] * 3
    rgb[v * 3] = atomRgb[a]
    rgb[v * 3 + 1] = atomRgb[a + 1]
    rgb[v * 3 + 2] = atomRgb[a + 2]
  }
  colors.needsUpdate = true
}

function discard(scene: Object3D, { mesh, depth }: Surface) {
  scene.remove(mesh, depth)
  mesh.geometry.dispose()
}
