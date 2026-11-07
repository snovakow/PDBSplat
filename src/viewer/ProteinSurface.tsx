import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { BackSide, BufferAttribute, BufferGeometry, Mesh, type Object3D, type PointLight } from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { vdwRadius } from '../pdb/elements.ts'
import type { Atom } from '../pdb/mmcif.ts'
import type { ColorBy } from '../options.ts'
import { shownAtoms, useStore, type PickTest } from '../store.ts'
import { requestSurface } from '../surface/surfaceWorker.ts'
import { atomColors } from './atomColors.ts'
import type { Bounds } from './bounds.ts'
import { nearestSphere, type SphereHit } from './raySpheres.ts'
import { isBackShell } from './styles.ts'

interface Props {
  bounds: Bounds
}

// A see-through surface's draws, in the order they go, each ahead of the colour's at three's default of 0: the far
// side's depth alone, then its colour, then the near side's depth alone, then its colour. All four list with the
// transparent objects, which are drawn in this order after everything opaque, so that each side's depth pass hides the
// layers behind that side's nearest face and leaves the other side's alone; two depth passes drawn with the opaque
// objects would share one depth, and keep the nearer face alone
const backDepthOrder = -3
const backOrder = -2
const frontDepthOrder = -1

// A drawn surface, with what a recolour needs: the atoms it was built from, and each vertex's atom among them; and
// what removes its pick when it goes
interface Surface {
  mesh: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  // The same mesh, drawn first into depth alone, so that a see-through surface shows only its nearest layer
  depth: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  // The same mesh again by its back faces, drawn ahead of the two above while the back shell is on, each face lit by
  // its normal turned inward: the surface's far side, which the near side then composites over
  back: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  backDepth: Mesh<BufferGeometry, MeshBasicNodeMaterial>
  colors: BufferAttribute
  atoms: Atom[]
  shown: readonly Atom[]
  owners: Uint32Array
  unregister: () => void
}

// The shown atoms' surface, meshed by marching cubes in a worker, and lit from above and below and from the camera
export function ProteinSurface({ bounds }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const shown = useStore(shownAtoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const burial = useStore((s) => s.options.burial)
  const scale = useStore((s) => s.options.scale)
  const opacity = useStore((s) => s.options.opacity)
  const backShell = useStore((s) => isBackShell(s.options))
  const resolution = useStore((s) => s.options.resolution)
  const material = useRef<MeshStandardNodeMaterial | null>(null)
  const depthMaterial = useRef<MeshBasicNodeMaterial | null>(null)
  const backMaterial = useRef<MeshStandardNodeMaterial | null>(null)
  const backDepthMaterial = useRef<MeshBasicNodeMaterial | null>(null)
  const surface = useRef<Surface | null>(null)
  const headlight = useRef<PointLight>(null)

  // The headlight follows the camera, so the side in view is always lit
  useFrame(({ camera }) => {
    headlight.current?.position.copy(camera.position)
  })

  // The materials serve every surface while this style is on, and go with the last one. The depth-only materials are
  // transparent, though they write no colour, so that they list with the colour materials and draw in their order
  useEffect(() => {
    const created = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 })
    const depthOnly = new MeshBasicNodeMaterial({ colorWrite: false, transparent: true })
    const back = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: BackSide })
    const backDepthOnly = new MeshBasicNodeMaterial({ colorWrite: false, transparent: true, side: BackSide })
    material.current = created
    depthMaterial.current = depthOnly
    backMaterial.current = back
    backDepthMaterial.current = backDepthOnly
    return () => {
      if (surface.current) discard(get().scene, surface.current)
      surface.current = null
      material.current = null
      depthMaterial.current = null
      backMaterial.current = null
      backDepthMaterial.current = null
      created.dispose()
      depthOnly.dispose()
      back.dispose()
      backDepthOnly.dispose()
    }
  }, [get])

  useEffect(() => {
    const { scene } = get()
    // A new entry's surface goes at once; for a changed option, the old one stays until the new one is ready
    if (surface.current && surface.current.atoms !== atoms) {
      discard(scene, surface.current)
      surface.current = null
    }
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

    // A cancelled request can still arrive, during a drag or while models play, and shows until the latest does, unless
    // its entry has gone. Results arrive in the order they were asked for, so one never replaces a newer surface
    const request = requestSurface({ centers, radii, spacing: 1 / resolution })
    request.result.then(
      ({ mesh: built, milliseconds }) => {
        const surfaceMaterial = material.current
        const surfaceDepth = depthMaterial.current
        const surfaceBack = backMaterial.current
        const surfaceBackDepth = backDepthMaterial.current
        if (!surfaceMaterial || !surfaceDepth || !surfaceBack || !surfaceBackDepth) return
        if (useStore.getState().atoms !== atoms) return
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(built.positions, 3))
        geometry.setAttribute('normal', new BufferAttribute(built.normals, 3))
        const colors = new BufferAttribute(new Float32Array(built.positions.length), 3)
        geometry.setAttribute('color', colors)
        geometry.setIndex(new BufferAttribute(built.indices, 1))
        geometry.computeBoundingSphere()

        // A ray picks the atom whose sphere it enters first, among those this surface was meshed from. Each surface
        // brings its own pick, so that a pointer held still is tested again when a new surface is drawn
        const sphereHit: SphereHit = { index: -1, distance: 0 }
        const pick: PickTest = (raycaster, hit) => {
          nearestSphere(raycaster.ray, centers, radii, raycaster.camera, sphereHit)
          if (sphereHit.index < 0 || sphereHit.distance >= hit.distance) return
          hit.atom = shown[sphereHit.index]
          hit.distance = sphereHit.distance
        }

        const next: Surface = {
          mesh: new Mesh(geometry, surfaceMaterial),
          depth: new Mesh(geometry, surfaceDepth),
          back: new Mesh(geometry, surfaceBack),
          backDepth: new Mesh(geometry, surfaceBackDepth),
          colors,
          atoms,
          shown,
          owners: built.owners,
          unregister: useStore.getState().registerPick(pick),
        }
        next.depth.renderOrder = frontDepthOrder
        next.back.renderOrder = backOrder
        next.backDepth.renderOrder = backDepthOrder
        const { options } = useStore.getState()
        paint(next, options.colorBy, options.burial)
        if (surface.current) discard(scene, surface.current)
        scene.add(next.backDepth, next.back, next.depth, next.mesh)
        surface.current = next
        console.info(
          `PDBSplat: surface of ${shown.length} atoms at ${built.spacing.toFixed(2)} Å: ` +
            `${built.positions.length / 3} vertices, ${built.indices.length / 3} triangles, in ${Math.round(milliseconds)} ms`,
        )
      },
      (error: unknown) => console.warn(`PDBSplat: the surface couldn't be meshed: ${String(error)}`),
    )
    // While models play, a step leaves the mesh under way to finish and show while the latest model waits. Cut off at
    // every step, each mesh would start in a fresh worker, and one slower than its grace would never arrive, leaving
    // the surface on an old model, or showing none
    return () => {
      if (useStore.getState().options.models !== 'play') request.cancel()
    }
  }, [get, atoms, shown, bounds, scale, resolution])

  // A new colouring or Burial repaints the vertices from their atoms, without meshing again
  useEffect(() => {
    if (surface.current) paint(surface.current, colorBy, burial)
  }, [colorBy, burial])

  // Below full opacity, the near side's depth pass draws ahead of its colour and hides every layer but the nearest; with
  // the back shell on as well, the far side's two passes draw ahead of both, so that its nearest face shows under the
  // near side's. At full Opacity the surface is opaque and hides its far side, so the back shell draws nothing. None of
  // this meshes the surface again
  useEffect(() => {
    const surfaceMaterial = material.current
    const surfaceDepth = depthMaterial.current
    const surfaceBack = backMaterial.current
    const surfaceBackDepth = backDepthMaterial.current
    if (!surfaceMaterial || !surfaceDepth || !surfaceBack || !surfaceBackDepth) return
    const transparent = opacity < 1
    for (const colour of [surfaceMaterial, surfaceBack]) {
      if (colour.transparent !== transparent) {
        colour.transparent = transparent
        colour.needsUpdate = true
      }
      colour.opacity = opacity
    }
    surfaceDepth.visible = transparent
    surfaceBack.visible = backShell
    surfaceBackDepth.visible = backShell
  }, [opacity, backShell])

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

function discard(scene: Object3D, { mesh, depth, back, backDepth, unregister }: Surface) {
  unregister()
  scene.remove(mesh, depth, back, backDepth)
  mesh.geometry.dispose()
}
