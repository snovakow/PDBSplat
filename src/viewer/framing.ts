import { MathUtils, Vector3, type PerspectiveCamera } from 'three'

// How the view frames an entry, and how it follows the entry's bounds as they grow while it arrives: the structure's
// object eases towards the place that brings its centre to the origin, and the camera's distance towards the one that
// frames its radius, each by a step of its own each frame, as the controls ease only what the pointer does

// Room around the structure when it's framed
const frameMargin = 1.15

// The camera's distance from the structure's centre that frames a sphere of a radius whole in its view, wide or tall
export function framingDistance(radius: number, camera: Pick<PerspectiveCamera, 'fov' | 'aspect'>) {
  const halfFov = MathUtils.degToRad(camera.fov) / 2
  const halfFovX = Math.atan(Math.tan(halfFov) * camera.aspect)
  return (radius / Math.sin(Math.min(halfFov, halfFovX))) * frameMargin
}

// How fast the view eases: what's left to go falls by a factor of e in this many seconds, and also goes at least this
// share of the structure's radius each second, so that it arrives in a time of its own rather than ever more slowly
export const easeSeconds = 0.6
export const leastPace = 0.05

// What's left to go of an ease after a frame of so many seconds, at a least speed in the same units a second: it
// falls as dr/dt = -r/T - v, whose steps compose, so that it follows the same curve however the time is split into
// frames, reaches 0 in a finite time and never passes it
export function easedLeft(left: number, seconds: number, speed: number) {
  if (!(left > 0)) return 0
  const floor = speed * easeSeconds
  return Math.max(0, (left + floor) * Math.exp(-seconds / easeSeconds) - floor)
}

// The bounds the view stands on in this frame: where the structure's centre has eased to, how far it still is from the
// centre the bounds give, which the near plane leaves room for, and the radius eased to, which the depth cue and Clip
// span and the camera's distance frames
export const viewBounds = { center: new Vector3(), offset: 0, radius: 0 }
