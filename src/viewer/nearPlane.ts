import { PerspectiveCamera, Vector3, type Camera, type Ray } from 'three'
import { clipDepth } from './shading.ts'

// The camera's near plane, which framing places in front of the structure, and the cut nothing is drawn nearer than

// How many times nearer than the structure's radius the near plane sits, close enough that zooming in doesn't cut
// into the atoms, and far enough to keep the depth buffer's precision
const nearDivisor = 100

// The near plane's distance for a structure of this radius
export function baseNear(radius: number) {
  return radius / nearDivisor
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
