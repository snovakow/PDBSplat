import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { BackSide, BoxGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor } from 'three'
import { NodeMaterial } from 'three/webgpu'
import { vdwRadius } from '../pdb/elements.ts'
import type { Atom } from '../pdb/mmcif.ts'
import type { ColorBy } from '../options.ts'
import { shownAtoms, useStore, type PickTest } from '../store.ts'
import { requestField } from '../surface/surfaceWorker.ts'
import { createAtomTable, paintAtomTable, type AtomTable, type TablePaint } from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { fieldMarch, type FieldMarch } from './field.ts'
import { nearestSphere, type SphereHit } from './raySpheres.ts'

interface Props {
  bounds: Bounds
}

// A drawn field, with what a recolour needs: the atoms it was sampled from, and the table its points' owners are
// coloured through; and what removes its pick when it goes
interface Field {
  table: AtomTable
  atoms: Atom[]
  shown: readonly Atom[]
  unregister: () => void
}

// The box the cloud is drawn in, its material and march, which serve every field while this style is on, and the
// field drawn in it
interface Drawn {
  box: Mesh<BoxGeometry, NodeMaterial>
  march: FieldMarch
  field: Field | null
}

// The shown atoms' density, sampled on a grid in a worker, and drawn as a cloud by a ray march through the box the
// grid fills, coloured by the atom nearest each point
export function ProteinField({ bounds }: Props) {
  const get = useThree((s) => s.get)
  const atoms = useStore((s) => s.atoms)
  const shown = useStore(shownAtoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const burial = useStore((s) => s.options.burial)
  const scale = useStore((s) => s.options.scale)
  const resolution = useStore((s) => s.options.resolution)
  const drawn = useRef<Drawn | null>(null)

  // The box is a unit cube scaled and placed to each field's grid. Its back faces are drawn, so that the march runs
  // from the camera to the far side of the box whichever side the camera is on, and the cloud is laid over what's
  // behind it by the alpha the march gives, with its colour already multiplied by it. It writes no depth, as a cloud
  // hides nothing, and takes no fog, as the march applies the depth cue point by point
  useEffect(() => {
    const { scene } = get()
    const march = fieldMarch()
    const material = new NodeMaterial()
    material.colorNode = march.colorNode
    material.side = BackSide
    material.transparent = true
    material.depthWrite = false
    material.fog = false
    material.blending = CustomBlending
    material.blendSrc = OneFactor
    material.blendDst = OneMinusSrcAlphaFactor
    const box = new Mesh(new BoxGeometry(1, 1, 1), material)
    box.visible = false
    scene.add(box)
    drawn.current = { box, march, field: null }
    return () => {
      if (drawn.current) discard(drawn.current)
      drawn.current = null
      scene.remove(box)
      box.geometry.dispose()
      material.dispose()
      march.dispose()
    }
  }, [get])

  useEffect(() => {
    const current = drawn.current
    if (!current) return undefined
    // A new entry's field goes at once; for a changed option, the old one stays until the new one is ready
    if (current.field && current.field.atoms !== atoms) discard(current)
    if (shown.length === 0) {
      discard(current)
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

    // A cancelled request can still arrive, during a drag or while models play, and shows until the latest does,
    // unless its entry has gone. Results arrive in the order they were asked for, so one never replaces a newer field
    const request = requestField({ centers, radii, spacing: 1 / resolution })
    request.result.then(
      ({ field, milliseconds }) => {
        const target = drawn.current
        if (!target || useStore.getState().atoms !== atoms) return
        const { options } = useStore.getState()
        const table = createAtomTable(shown.length)
        paintAtomTable(table, paintOf(shown, atoms, options.colorBy, options.burial))

        // A ray picks the atom whose sphere it enters first, among those this field was sampled from. Each field
        // brings its own pick, so that a pointer held still is tested again when a new field is drawn
        const sphereHit: SphereHit = { index: -1, distance: 0 }
        const pick: PickTest = (raycaster, hit) => {
          nearestSphere(raycaster.ray, centers, radii, raycaster.camera, sphereHit)
          if (sphereHit.index < 0 || sphereHit.distance >= hit.distance) return
          hit.atom = shown[sphereHit.index]
          hit.distance = sphereHit.distance
        }

        discard(target)
        target.march.show(field, table)
        const [nx, ny, nz] = field.size
        const { box } = target
        box.scale.set((nx - 1) * field.spacing, (ny - 1) * field.spacing, (nz - 1) * field.spacing)
        box.position.fromArray(field.origin).addScaledVector(box.scale, 0.5)
        box.visible = true
        target.field = { table, atoms, shown, unregister: useStore.getState().registerPick(pick) }
        console.info(
          `PDBSplat: field of ${shown.length} atoms at ${field.spacing.toFixed(2)} Å: ` +
            `${nx}×${ny}×${nz} points, in ${Math.round(milliseconds)} ms`,
        )
      },
      (error: unknown) => console.warn(`PDBSplat: the field couldn't be sampled: ${String(error)}`),
    )
    // While models play, a step leaves the field under way to finish and show while the latest model waits, as the
    // surface does
    return () => {
      if (useStore.getState().options.models !== 'play') request.cancel()
    }
  }, [atoms, shown, bounds, scale, resolution])

  // A new colouring or Burial repaints the table the march reads, without sampling again
  useEffect(() => {
    const field = drawn.current?.field
    if (field) paintAtomTable(field.table, paintOf(field.shown, field.atoms, colorBy, burial))
  }, [colorBy, burial])

  return null
}

// What the field's table is painted from: the colouring and Burial alone, with nothing faded, so every alpha is full
function paintOf(shown: readonly Atom[], entry: readonly Atom[], colorBy: ColorBy, burial: number): TablePaint {
  return {
    shown,
    entry,
    colorBy,
    burial,
    focus: 'all',
    picked: null,
    fade: 1,
    model: 0,
    modelCount: 1,
    conformations: 'first',
  }
}

// Takes the field out of the box, which hides until the next one lands, and frees what the field brought
function discard(current: Drawn) {
  const { field, box } = current
  if (!field) return
  field.unregister()
  field.table.texture.dispose()
  box.visible = false
  current.field = null
}
