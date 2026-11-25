import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ray, Vector3 } from 'three'
import { nearestSphere, type SphereHit } from '../src/viewer/raySpheres.ts'

// The nearest of a set of spheres along a ray, which the surface and the field pick their atoms by, among those it
// enters no nearer than the cut

// Two spheres of 1 Å down the z axis, 10 Å and 20 Å away, and a ray from the origin down it
const centers = new Float32Array([0, 0, -10, 0, 0, -20])
const radii = new Float32Array([1, 1])
const ray = new Ray(new Vector3(), new Vector3(0, 0, -1))

void test('a ray picks the sphere it enters first, at the distance it enters it', () => {
  const hit: SphereHit = { index: -1, distance: 0 }
  nearestSphere(ray, centers, radii, 0, hit)
  assert.deepEqual(hit, { index: 0, distance: 9 })
  // A ray that misses every sphere meets none
  nearestSphere(new Ray(new Vector3(5, 0, 0), new Vector3(0, 0, -1)), centers, radii, 0, hit)
  assert.deepEqual(hit, { index: -1, distance: Infinity })
})

void test('a sphere the ray enters nearer than the cut is passed through, and one it rejects too', () => {
  const hit: SphereHit = { index: -1, distance: 0 }
  // The cut takes the first sphere's front away, so the ray goes on to the second
  nearestSphere(ray, centers, radii, 9.5, hit)
  assert.deepEqual(hit, { index: 1, distance: 19 })
  // Right at the cut, the first is still entered
  nearestSphere(ray, centers, radii, 9, hit)
  assert.deepEqual(hit, { index: 0, distance: 9 })
  nearestSphere(ray, centers, radii, 0, hit, (index) => index !== 0)
  assert.deepEqual(hit, { index: 1, distance: 19 })
})

void test('a ray that starts inside a sphere meets it where it leaves', () => {
  const hit: SphereHit = { index: -1, distance: 0 }
  nearestSphere(new Ray(new Vector3(0, 0, -10.5), new Vector3(0, 0, -1)), centers, radii, 0, hit)
  assert.deepEqual(hit, { index: 0, distance: 0.5 })
})
