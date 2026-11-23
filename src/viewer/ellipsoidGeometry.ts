import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
} from 'three'

// The geometry a set of ellipsoids is drawn from: one quad, drawn once for each, with each one's centre, covariance
// and paint as the instance's attributes

// How many standard deviations out an ellipsoid's surface is, and so the edge a Gaussian is drawn to: an ellipsoid
// reaches twice the root of its covariance along any direction
export const surfaceDeviations = 2

// The instances' attributes by name: the centre, the covariance's xx, xy and xz, its yy, yz and zz, and the colour and
// alpha the atoms are painted with
export const ellipsoidAttributes = { centre: 'center', shapeA: 'covarianceA', shapeB: 'covarianceB', paint: 'paint' }

// The floats of a covariance, in the order [xx, xy, xz, yy, yz, zz]
export const covarianceSize = 6
// The bytes of an ellipsoid's paint: its colour's red, green and blue, and its alpha
export const paintSize = 4

export interface Ellipsoids {
  geometry: InstancedBufferGeometry
  // The paint, four bytes for each ellipsoid, which clamp and round what's written to them
  paint: Uint8ClampedArray
  // Sends the paint to the GPU again, once it's been rewritten
  repaint: () => void
}

// A round ellipsoid's covariance, for a standard deviation alike along every axis, written at an offset
export function writeRound(target: Float32Array, offset: number, deviation: number) {
  const variance = deviation * deviation
  target[offset] = variance
  target[offset + 1] = 0
  target[offset + 2] = 0
  target[offset + 3] = variance
  target[offset + 4] = 0
  target[offset + 5] = variance
}

// How far from the origin any of the ellipsoids at centres, x, y, z triples, with covariances, six floats each,
// reaches, or a little more: each one's centre's distance, and the farthest its surface reaches from its centre, which
// is twice the root of its covariance's largest eigenvalue, taken at the largest of the rows' sums of magnitudes, which
// is no smaller than that eigenvalue, and is it for a covariance with no cross terms
export function ellipsoidsReach(centers: Float32Array, covariances: Float32Array) {
  let reach = 0
  for (let i = 0; i < centers.length / 3; i++) {
    const at = i * covarianceSize
    const xx = Math.abs(covariances[at])
    const xy = Math.abs(covariances[at + 1])
    const xz = Math.abs(covariances[at + 2])
    const yy = Math.abs(covariances[at + 3])
    const yz = Math.abs(covariances[at + 4])
    const zz = Math.abs(covariances[at + 5])
    const largest = Math.max(xx + xy + xz, xy + yy + yz, xz + yz + zz)
    const centre = Math.hypot(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2])
    reach = Math.max(reach, centre + surfaceDeviations * Math.sqrt(largest))
  }
  return reach
}

// The geometry for ellipsoids at centres, x, y, z triples in scene coordinates, with covariances, six floats each.
// Both arrays are the geometry's own from here on, and the paint starts clear
export function createEllipsoids(centers: Float32Array, covariances: Float32Array): Ellipsoids {
  const count = centers.length / 3
  const geometry = new InstancedBufferGeometry()
  // The quad's corners, which the vertex stage places on screen
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  geometry.setAttribute(ellipsoidAttributes.centre, new InstancedBufferAttribute(centers, 3))
  const shapes = new InstancedInterleavedBuffer(covariances, covarianceSize)
  geometry.setAttribute(ellipsoidAttributes.shapeA, new InterleavedBufferAttribute(shapes, 3, 0))
  geometry.setAttribute(ellipsoidAttributes.shapeB, new InterleavedBufferAttribute(shapes, 3, 3))
  // The attribute reads the paint's bytes as they are, each as a share of 255
  const paint = new Uint8ClampedArray(count * paintSize)
  const painted = new InstancedBufferAttribute(new Uint8Array(paint.buffer), paintSize, true)
  geometry.setAttribute(ellipsoidAttributes.paint, painted)
  geometry.instanceCount = count
  return {
    geometry,
    paint,
    repaint: () => {
      painted.needsUpdate = true
    },
  }
}
