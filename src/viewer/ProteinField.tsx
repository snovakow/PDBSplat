import { useEffect, useEffectEvent, useRef } from 'react'
import {
  BackSide,
  BoxGeometry,
  CustomBlending,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Ray,
  Vector3,
  type Object3D,
} from 'three'
import { NodeMaterial } from 'three/webgpu'
import { vdwRadii } from '../pdb/elements.ts'
import type { ShownAtoms, Structure } from '../pdb/structure.ts'
import type { ColorBy } from '../options.ts'
import { shownAtoms, useStore, type PickTest } from '../store.ts'
import { requestField } from '../surface/surfaceWorker.ts'
import { createAtomTable, paintAtomTable, type AtomTable, type TablePaint } from './atomTable.ts'
import type { Bounds } from './bounds.ts'
import { fieldMarch, type FieldMarch } from './field.ts'
import { cutAlong, setDrawnReach } from './nearPlane.ts'
import { rayInto } from './placement.ts'
import { nearestSphere, type SphereHit } from './raySpheres.ts'

interface Props {
  bounds: Bounds
  // The structure's object, which the box is a child of
  structureObject: Object3D
}

// A drawn field, with what a recolour needs: the atoms it was sampled from and their structure, and the table its
// points' owners are coloured through; and what removes its pick when it goes
interface Field {
  table: AtomTable
  structure: Structure
  shown: ShownAtoms
  unregister: () => void
}

// The box the cloud is drawn in, its material and march, which serve every field while this style is on, and the
// field drawn in it
interface Drawn {
  box: Mesh<BoxGeometry, NodeMaterial>
  march: FieldMarch
  field: Field | null
}

// The shown atoms' density, sampled on a grid in a worker where the file puts them, and drawn as a cloud by a ray march
// through the box the grid fills, placed by the structure's object and coloured by the atom nearest each point
export function ProteinField({ bounds, structureObject }: Props) {
  const structure = useStore((s) => s.structure)
  const shown = useStore(shownAtoms)
  const colorBy = useStore((s) => s.options.colorBy)
  const burial = useStore((s) => s.options.burial)
  const scale = useStore((s) => s.options.scale)
  const resolution = useStore((s) => s.options.resolution)
  const drawn = useRef<Drawn | null>(null)
  // How far from the structure's centre, as its bounds stand now, a box of this middle and diagonal reaches
  const reachOf = useEffectEvent((middle: Vector3, diagonal: number) => middle.distanceTo(bounds.center) + diagonal / 2)

  // The box's geometry is each field's grid, as the march reads it, and the box itself is never moved, so that its
  // own space is the structure's. Its back faces are drawn, so that the march runs from the camera to the far side of
  // the box whichever side the camera is on, and the cloud is laid over what's behind it by the alpha the march gives,
  // with its colour already multiplied by it. It writes no depth, as a cloud hides nothing
  useEffect(() => {
    const march = fieldMarch()
    const material = new NodeMaterial()
    material.colorNode = march.colorNode
    material.side = BackSide
    material.transparent = true
    material.depthWrite = false
    material.blending = CustomBlending
    material.blendSrc = OneFactor
    material.blendDst = OneMinusSrcAlphaFactor
    const box = new Mesh(new BoxGeometry(1, 1, 1), material)
    box.visible = false
    structureObject.add(box)
    drawn.current = { box, march, field: null }
    return () => {
      if (drawn.current) discard(drawn.current)
      drawn.current = null
      structureObject.remove(box)
      box.geometry.dispose()
      material.dispose()
      march.dispose()
    }
  }, [structureObject])

  useEffect(() => {
    const current = drawn.current
    if (!current) return undefined
    // A new entry's field goes at once; for a changed option, the old one stays until the new one is ready
    if (current.field && current.field.structure !== structure) discard(current)
    if (shown.count === 0) {
      discard(current)
      return undefined
    }

    const centers = new Float32Array(shown.count * 3)
    const radii = new Float32Array(shown.count)
    const { positions, element } = structure.atoms
    const elementRadii = vdwRadii(structure.elements)
    for (let i = 0; i < shown.count; i++) {
      const atom = shown.rows[i]
      centers[i * 3] = positions[atom * 3]
      centers[i * 3 + 1] = positions[atom * 3 + 1]
      centers[i * 3 + 2] = positions[atom * 3 + 2]
      radii[i] = elementRadii[element[atom]] * scale
    }

    // A cancelled request can still arrive, during a drag or while models play, and shows until the latest does,
    // unless its entry has gone. Results arrive in the order they were asked for, so one never replaces a newer field
    const request = requestField({ centers, radii, spacing: 1 / resolution })
    request.result.then(
      ({ field, milliseconds }) => {
        const target = drawn.current
        if (!target || useStore.getState().structure !== structure) return
        const { options } = useStore.getState()
        const table = createAtomTable(shown.count)
        paintAtomTable(table, paintOf(shown, structure, options.colorBy, options.burial))

        // A ray picks the atom whose sphere it enters first, among those this field was sampled from, tested in the
        // structure's own space, where the spheres are. Each field brings its own pick, so that a pointer held still is
        // tested again when a new field is drawn
        const sphereHit: SphereHit = { index: -1, distance: 0 }
        const local = new Ray()
        const pick: PickTest = (raycaster, hit) => {
          const cut = cutAlong(raycaster.ray, raycaster.camera)
          nearestSphere(rayInto(raycaster.ray, structureObject, local), centers, radii, cut, sphereHit)
          if (sphereHit.index < 0 || sphereHit.distance >= hit.distance) return
          hit.atom = shown.rows[sphereHit.index]
          hit.distance = sphereHit.distance
        }

        discard(target)
        target.march.show(field, table)
        const [nx, ny, nz] = field.size
        const { box } = target
        const extent = new Vector3((nx - 1) * field.spacing, (ny - 1) * field.spacing, (nz - 1) * field.spacing)
        const middle = new Vector3().fromArray(field.origin).addScaledVector(extent, 0.5)
        box.geometry.dispose()
        box.geometry = new BoxGeometry(extent.x, extent.y, extent.z).translate(middle.x, middle.y, middle.z)
        box.visible = true
        // The cloud reaches no farther from the structure's centre than the box's corners
        setDrawnReach(reachOf(middle, extent.length()))
        target.field = { table, structure, shown, unregister: useStore.getState().registerPick(pick) }
        console.info(
          `PDBSplat: field of ${shown.count} atoms at ${field.spacing.toFixed(2)} Å: ` +
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
  }, [structureObject, structure, shown, scale, resolution])

  // A new colouring or Burial repaints the table the march reads, without sampling again
  useEffect(() => {
    const field = drawn.current?.field
    if (field) paintAtomTable(field.table, paintOf(field.shown, field.structure, colorBy, burial))
  }, [colorBy, burial])

  return null
}

// What the field's table is painted from: the colouring and Burial alone, with nothing faded, so every alpha is full
function paintOf(shown: ShownAtoms, structure: Structure, colorBy: ColorBy, burial: number): TablePaint {
  return {
    shown,
    structure,
    colorBy,
    burial,
    focus: 'all',
    picked: null,
    fade: 1,
    model: 0,
    modelCount: 1,
    conformations: 'first',
    layered: false,
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
