import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createEllipsoids,
  covarianceSize,
  ellipsoidsReach,
  paintSize,
  surfaceDeviations,
  writeRound,
} from '../src/viewer/ellipsoidGeometry.ts'

// The ellipsoids' geometry: one quad, drawn once for each, with each one's centre, covariance and paint as the
// instance's attributes

void test('a round covariance has its variance along each axis and nothing between them', () => {
  const target = new Float32Array(8)
  writeRound(target, 1, 0.5)
  assert.deepEqual([...target], [0, 0.25, 0, 0, 0.25, 0, 0.25, 0])
  assert.equal(covarianceSize, 6)
  assert.equal(paintSize, 4)
})

// The origin of the file's coordinates
const origin = { x: 0, y: 0, z: 0 }

void test('the reach is the farthest an ellipsoid reaches from a point, exact for one with no cross terms', () => {
  // A round one of 1 Å at (3, 4, 0) reaches 5 + 2 Å, and the one stretched to 2 Å along x at the origin 4 Å
  const round = new Float32Array(6)
  writeRound(round, 0, 1)
  assert.equal(ellipsoidsReach(new Float32Array([3, 4, 0]), round, origin), 5 + surfaceDeviations)
  const stretched = new Float32Array([4, 0, 0, 1, 0, 1])
  assert.equal(ellipsoidsReach(new Float32Array([0, 0, 0]), stretched, origin), 2 * surfaceDeviations)
  // Of several, the farthest
  const both = new Float32Array([...round, ...stretched])
  assert.equal(ellipsoidsReach(new Float32Array([3, 4, 0, 0, 0, 0]), both, origin), 5 + surfaceDeviations)
  assert.equal(ellipsoidsReach(new Float32Array(0), new Float32Array(0), origin), 0)
})

void test("the reach is measured from the structure's centre, wherever the file puts the structure", () => {
  // The round one of 1 Å at (3, 4, 0), from a centre at (3, 0, 0), reaches 4 + 2 Å
  const round = new Float32Array(6)
  writeRound(round, 0, 1)
  assert.equal(ellipsoidsReach(new Float32Array([3, 4, 0]), round, { x: 3, y: 0, z: 0 }), 4 + surfaceDeviations)
  // A structure the file puts far from its origin reaches from its centre as far as it would centred on the origin
  const stretched = new Float32Array([4, 0, 0, 1, 0, 1])
  const both = new Float32Array([...round, ...stretched])
  const centre = { x: 40, y: -25, z: 12 }
  const shifted = new Float32Array([43, -21, 12, 40, -25, 12])
  assert.equal(ellipsoidsReach(shifted, both, centre), 5 + surfaceDeviations)
})

void test('a tilted ellipsoid reaches no farther than the reach given, along any direction', () => {
  // Stretched along the diagonal of the xy plane: variances 9 and 1 along (1, 1, 0)/√2 and (1, −1, 0)/√2, and 4
  // along z, whose largest reach is 2 × 3 Å
  const covariance = new Float32Array([5, 4, 0, 5, 0, 4])
  const reach = ellipsoidsReach(new Float32Array([0, 0, 0]), covariance, origin)
  assert.ok(reach >= 3 * surfaceDeviations)
  // The surface reaches 2√(uᵀΣu) along a unit direction u, which a sweep over every direction never passes
  const [xx, xy, xz, yy, yz, zz] = covariance
  let farthest = 0
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j < 120; j++) {
      const polar = (Math.PI * i) / 60
      const around = (2 * Math.PI * j) / 120
      const [x, y, z] = [Math.sin(polar) * Math.cos(around), Math.sin(polar) * Math.sin(around), Math.cos(polar)]
      const form = x * (xx * x + xy * y + xz * z) + y * (xy * x + yy * y + yz * z) + z * (xz * x + yz * y + zz * z)
      farthest = Math.max(farthest, surfaceDeviations * Math.sqrt(form))
    }
  }
  assert.ok(Math.abs(farthest - 3 * surfaceDeviations) < 1e-3)
  assert.ok(reach >= farthest)
})

void test('the geometry draws one quad for each ellipsoid, from its centre, covariance and paint', () => {
  const centers = new Float32Array([1, 2, 3, -4, -5, -6])
  const covariances = new Float32Array([1, 0.1, 0.2, 2, 0.3, 3, 4, 0.4, 0.5, 5, 0.6, 6])
  const { geometry, paint } = createEllipsoids(centers, covariances)
  assert.equal(geometry.instanceCount, 2)
  // The quad: four corners and two triangles
  assert.equal(geometry.getAttribute('position').count, 4)
  assert.equal(geometry.getIndex()?.count, 6)
  const centre = geometry.getAttribute('center')
  assert.equal(centre.count, 2)
  assert.deepEqual([centre.getX(1), centre.getY(1), centre.getZ(1)], [-4, -5, -6])
  // The covariance's xx, xy and xz in one attribute, and its yy, yz and zz in the other, both read from the one array
  const first = geometry.getAttribute('covarianceA')
  const second = geometry.getAttribute('covarianceB')
  assert.deepEqual([first.getX(0), first.getY(0), first.getZ(0)], [1, covariances[1], covariances[2]])
  assert.deepEqual([second.getX(0), second.getY(0), second.getZ(0)], [2, covariances[4], 3])
  assert.deepEqual([first.getX(1), second.getX(1), second.getZ(1)], [4, 5, 6])
  // Each is an attribute of the instances, so every corner of an ellipsoid's quad is given the same
  for (const name of ['center', 'covarianceA', 'covarianceB', 'paint']) {
    const attribute = geometry.getAttribute(name)
    const instanced =
      'data' in attribute ? 'isInstancedInterleavedBuffer' in attribute.data : 'isInstancedBufferAttribute' in attribute
    assert.equal(instanced, true, name)
  }
  assert.equal(paint.length, 2 * paintSize)
})

void test('the paint clamps and rounds what is written, and the attribute reads the same bytes', () => {
  const { geometry, paint, repaint } = createEllipsoids(new Float32Array(6), new Float32Array(12))
  const painted = geometry.getAttribute('paint')
  assert.equal(painted.itemSize, 4)
  assert.equal(painted.normalized, true)
  assert.deepEqual([...paint], [0, 0, 0, 0, 0, 0, 0, 0])
  paint.set([300, -5, 127.6, 255], 4)
  assert.deepEqual([...painted.array].slice(4), [255, 0, 128, 255])
  // As a share of full, as a shader reads it
  assert.equal(painted.getX(1), 1)
  assert.equal(painted.getW(1), 1)
  // Rewritten paint is sent again only when asked
  if (!('version' in painted)) throw new Error('The paint is an attribute of its own')
  const version = painted.version
  repaint()
  assert.equal(painted.version, version + 1)
})
