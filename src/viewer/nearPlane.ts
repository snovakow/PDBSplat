import { PerspectiveCamera, Vector3, type Camera } from 'three'

// The camera's near plane, which framing places in front of the structure and Clip moves through it

// How many times nearer than the structure's radius the near plane sits while nothing is clipped, close enough
// that zooming in doesn't cut into the atoms, and far enough to keep the depth buffer's precision
const nearDivisor = 100

// The near plane's distance for a structure of this radius while nothing is clipped
export function baseNear(radius: number) {
  return radius / nearDivisor
}

const viewPoint = new Vector3()

// Whether a point lies beyond the camera's near plane, where it's drawn rather than cut away. It reads the camera's
// matrices as its last render left them, which is the view the pointer is over
export function beyondNear(point: Vector3, camera: Camera) {
  if (!(camera instanceof PerspectiveCamera)) return true
  return -viewPoint.copy(point).applyMatrix4(camera.matrixWorldInverse).z >= camera.near
}
