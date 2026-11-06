import { Vector3, type Camera, type Ray } from 'three'
import { beyondNear } from './nearPlane.ts'

// The nearest of a set of spheres along a ray, which the surface style picks its atoms by, and the splat styles while
// Detail draws residues or chains alone: meshes are far too many triangles to test as the pointer moves, and a blob
// stands for a whole residue or chain, so each atom's sphere stands for its part of what's drawn

export interface SphereHit {
  // The sphere's place in the list, or -1 when the ray meets none
  index: number
  // How far along the ray it's entered
  distance: number
}

const point = new Vector3()

// Writes into hit the sphere the ray enters first, among those it enters beyond the camera's near plane, which may cut
// a sphere's front away, and, where a test is given, among those it accepts by their place in the list: the ray passes
// through the rest. Centres are x, y, z triples, and the ray's direction has unit length
export function nearestSphere(
  ray: Ray,
  centers: Float32Array,
  radii: Float32Array,
  camera: Camera,
  hit: SphereHit,
  accepts?: (index: number) => boolean,
) {
  const { origin, direction } = ray
  hit.index = -1
  hit.distance = Infinity
  for (let i = 0; i < radii.length; i++) {
    // With o the origin less the centre, |o + t·d|² = r² gives t² + 2bt + c = 0
    const ox = origin.x - centers[i * 3]
    const oy = origin.y - centers[i * 3 + 1]
    const oz = origin.z - centers[i * 3 + 2]
    const b = ox * direction.x + oy * direction.y + oz * direction.z
    const c = ox * ox + oy * oy + oz * oz - radii[i] * radii[i]
    const discriminant = b * b - c
    if (discriminant < 0) continue
    // The ray enters at the smaller root, unless it starts inside the sphere
    const root = Math.sqrt(discriminant)
    const t = -b - root >= 0 ? -b - root : -b + root
    if (t < 0 || t >= hit.distance) continue
    if (accepts?.(i) === false) continue
    if (!beyondNear(ray.at(t, point), camera)) continue
    hit.index = i
    hit.distance = t
  }
}
