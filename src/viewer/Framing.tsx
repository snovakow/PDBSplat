import type { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useEffectEvent, useRef, type ComponentRef, type RefObject } from 'react'
import { PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three'
import { useStore } from '../store.ts'
import { useBounds } from './bounds.ts'
import { easedLeft, framingDistance, leastPace, viewBounds } from './framing.ts'
import { drawnReach, nearPlane } from './nearPlane.ts'
import { placeStructure } from './placement.ts'
import { structureRadius } from './shading.ts'

// The turn the structure is placed by about its centre: none, so that it stands as the file gives it
const asGiven = new Quaternion()

// drei's orbit controls update in a frame callback of priority -1, and a lower priority runs first without taking over
// the render, so each frame eases the view before they turn the camera, and every pass of the frame sees it
const beforeControls = -2

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
  // The structure's object, which places the structure in the scene
  structureObject: Object3D
}

// What the frames ease: the entry they ease for, the centre and the radius eased to, the largest radius the entry's
// bounds have reached as it arrives, and whether the visitor has taken the view, after which the camera's distance is
// theirs
interface Eased {
  entry: string
  center: Vector3
  radius: number
  most: number
  taken: boolean
}

// The way from the eased centre to the bounds' own, reused by every frame
const towards = new Vector3()

// A new entry is framed whole, looking level at its centroid from the side it's broadest, whatever the style, as its
// first batch gives them. While the rest of it arrives, the bounds move and grow, and each frame the structure's object
// eases towards placing their centre at the origin, and the camera's distance towards framing the largest radius they
// have reached, so that the view only ever eases out as the entry comes, until the visitor zooms, turns or pans the
// view, which leaves the distance to them; the centre eases on. Once the entry has arrived, its exact bounds land the
// same way. The near plane follows the camera, and the far plane and the farthest the controls zoom out follow the
// bounds
export function Framing({ controlsRef, structureObject }: Props) {
  // The entry's bounds, as far as it has arrived
  const bounds = useBounds()
  const get = useThree((s) => s.get)
  const entry = useStore((s) => s.id)
  // Whether the entry has all arrived, after which its own radius is framed
  const whole = useStore((s) => s.structure.whole)
  const eased = useRef<Eased>({ entry: '', center: new Vector3(), radius: 0, most: 0, taken: false })

  // Sets the far plane beyond the farthest the bounds or the radius eased to could reach, and the farthest the
  // controls zoom out well before it
  const reachOut = (camera: PerspectiveCamera, radius: number) => {
    const controls = controlsRef.current
    const widest = Math.max(radius, bounds.radius)
    const far = framingDistance(widest, camera) * 4 + widest
    if (controls) controls.maxDistance = framingDistance(radius, camera) * 3
    if (camera.far === far) return
    camera.far = far
    camera.updateProjectionMatrix()
  }

  // Frames the entry by its bounds as they stand when it's framed, with nothing eased. Only a new entry is framed: a
  // later change of its bounds, or a repeat load of the entry shown, leaves the view to the easing
  const frame = useEffectEvent(() => {
    const controls = controlsRef.current
    const { camera } = get()
    if (bounds.radius === 0 || !controls || !(camera instanceof PerspectiveCamera)) return
    const distance = framingDistance(bounds.radius, camera)

    // Spin turns the view about the y axis, so the camera opens on that turn where the structure shows its broadest
    // side, rather than wherever the file's z axis happens to point
    camera.position.set(distance * Math.sin(bounds.broadside), 0, distance * Math.cos(bounds.broadside))
    controls.target.set(0, 0, 0)
    const view = eased.current
    view.entry = entry
    view.center.copy(bounds.center)
    view.radius = bounds.radius
    view.most = bounds.radius
    view.taken = false
    reachOut(camera, view.radius)
    controls.update()
    placeStructure(structureObject, view.center, asGiven)
    viewBounds.center.copy(view.center)
    viewBounds.offset = 0
    viewBounds.radius = view.radius
    structureRadius.value = view.radius
  })
  // Nothing is framed before the first entry arrives, and then each new one is
  useEffect(() => {
    if (entry !== '') frame()
  }, [entry])

  // A press, a wheel turn or a touch on the view takes it from the easing
  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return undefined
    const take = () => {
      eased.current.taken = true
    }
    controls.addEventListener('start', take)
    return () => controls.removeEventListener('start', take)
  }, [controlsRef])

  // Each frame, before the controls: the centre and the radius eased a step towards the bounds' centre and the radius
  // framed, each by what's left to go and a least pace of the radius, and what follows them placed
  useFrame(({ camera }, delta) => {
    const view = eased.current
    const controls = controlsRef.current
    if (view.entry !== entry || entry === '' || !controls || !(camera instanceof PerspectiveCamera)) return
    view.most = Math.max(view.most, bounds.radius)
    const framed = whole ? bounds.radius : view.most
    const speed = leastPace * Math.max(framed, view.radius)
    towards.subVectors(bounds.center, view.center)
    const offset = towards.length()
    if (offset > 0) {
      const left = easedLeft(offset, delta, speed)
      if (left === 0) view.center.copy(bounds.center)
      else view.center.addScaledVector(towards, 1 - left / offset)
      placeStructure(structureObject, view.center, asGiven)
      viewBounds.center.copy(view.center)
      viewBounds.offset = left
    }
    if (view.radius !== framed) {
      const gap = framed - view.radius
      const left = easedLeft(Math.abs(gap), delta, speed)
      view.radius = framed - Math.sign(gap) * left
      viewBounds.radius = view.radius
      structureRadius.value = view.radius
      reachOut(camera, view.radius)
      if (!view.taken) {
        const target = controls.target
        camera.position.sub(target).setLength(framingDistance(view.radius, camera)).add(target)
      }
    }
  }, beforeControls)

  // Each frame, after the controls have moved the camera, the near plane goes in front of what's drawn, as the
  // camera's distance from the structure's centre places it, with room for the way the centre has still to ease. The
  // centre sits at the origin, so a turn about it leaves the near plane where it is, and a zoom or a pan moves it
  useFrame(({ camera }) => {
    if (viewBounds.radius === 0 || !(camera instanceof PerspectiveCamera)) return
    const near = nearPlane(camera.position.length(), drawnReach() + viewBounds.offset, viewBounds.radius)
    if (near === camera.near) return
    camera.near = near
    camera.updateProjectionMatrix()
  })

  return null
}
