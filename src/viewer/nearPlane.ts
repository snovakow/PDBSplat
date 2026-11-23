import { PerspectiveCamera, Vector3, type Camera, type Ray } from 'three'
import { clipDepth } from './shading.ts'

// The camera's near plane, which follows the camera and stays in front of what's drawn, and the cut nothing is drawn
// nearer than

// How many times nearer than the structure's radius the near plane sits while the camera is close to the structure or
// inside it, close enough that zooming in doesn't cut into the atoms
const nearDivisor = 100

// The near plane's distance, while the camera is close to a structure of this radius or inside it
export function baseNear(radius: number) {
  return radius / nearDivisor
}

// How far from the structure's centre anything drawn reaches, as the style drawing it last measured
let lastReach = 0

// Each style gives the radius around the structure's centre that holds everything it draws, as it puts it in the scene
export function setDrawnReach(radius: number) {
  lastReach = radius
}

export function drawnReach() {
  return lastReach
}

// The near plane's distance for a camera this far from the structure's centre: halfway to the nearest point anything
// drawn could reach, or the base while the camera is that close or inside. A depth buffer's precision at a depth goes
// as the near plane's distance, and two surfaces that meet in a crease are told apart there by their depths alone: a
// near plane a hundred times nearer than the structure spends almost all of it in front of the structure, and leaves
// a crease's pixels to rounding, which changes with every move of the view
export function nearPlane(distance: number, reach: number, radius: number) {
  return Math.max(baseNear(radius), (distance - reach) / 2)
}

// The view depth nothing is drawn nearer than, as the last frame set it: Clip's cut, or the camera's near plane where
// that's farther. The shaders cut there pixel by pixel, and a pick reads the same depth
export function cutDepth(camera: Camera) {
  return camera instanceof PerspectiveCamera ? Math.max(camera.near, clipDepth.value) : 0
}

const viewPoint = new Vector3()
const forward = new Vector3()

// Whether a point lies beyond the cut, where it's drawn rather than cut away. It reads the camera's matrices as its
// last render left them, which is the view the pointer is over
export function beyondCut(point: Vector3, camera: Camera) {
  return -viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse).z >= cutDepth(camera)
}

// How far along a ray from the camera the cut lies. The ray's direction has unit length
export function cutAlong(ray: Ray, camera: Camera) {
  return cutDepth(camera) / ray.direction.dot(camera.getWorldDirection(forward))
}
