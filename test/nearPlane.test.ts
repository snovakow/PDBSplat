import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Ray, Vector3 } from 'three'
import {
  baseNear,
  cutAlong,
  cutDepth,
  drawnReach,
  nearPlane,
  setDrawnReach,
} from '../src/viewer/nearPlane.ts'
import { clipDepth } from '../src/viewer/shading.ts'

// The near plane, which follows the camera to halfway in front of what's drawn, and the cut nothing is drawn nearer
// than: Clip's cut, or the camera's near plane where that's farther, as a pick reads it

// A camera at the origin looking down the z axis, as a render leaves its matrices
function cameraWith(near: number) {
  const camera = new PerspectiveCamera(50, 1, near, 1000)
  camera.updateMatrixWorld()
  return camera
}

void test("the near plane sits a hundredth of the structure's radius away while the camera is close", () => {
  assert.equal(baseNear(50), 0.5)
  assert.equal(baseNear(0), 0)
  // Inside what's drawn, at its edge, and so close outside it that halfway would be nearer than the base
  assert.equal(nearPlane(10, 60, 50), 0.5)
  assert.equal(nearPlane(60, 60, 50), 0.5)
  assert.equal(nearPlane(60.8, 60, 50), 0.5)
})

void test('farther out, the near plane sits halfway to the nearest point anything drawn could reach', () => {
  assert.equal(nearPlane(160, 60, 50), 50)
  assert.equal(nearPlane(61.25, 60, 50), 0.625)
  // Nothing drawn is nearer than the near plane once the camera is farther from it than the base, and the near plane
  // moves with the camera, without a jump
  let previous = nearPlane(0, 60, 50)
  for (let distance = 0; distance <= 400; distance += 0.25) {
    const near = nearPlane(distance, 60, 50)
    if (distance - 60 > baseNear(50)) assert.ok(near < distance - 60, `${distance}`)
    assert.ok(near >= previous && near - previous <= 0.125 + 1e-12, `${distance}`)
    previous = near
  }
})

void test('the reach drawn is the one the style drawing last gave', (t) => {
  t.after(() => {
    setDrawnReach(0)
  })
  setDrawnReach(42.5)
  assert.equal(drawnReach(), 42.5)
  setDrawnReach(7)
  assert.equal(drawnReach(), 7)
})

void test("the cut is Clip's, or the near plane where that is farther, which a slanted ray meets later", (t) => {
  t.after(() => {
    clipDepth.value = 0
  })
  const camera = cameraWith(2)
  // With nothing clipped, the cut is the near plane
  clipDepth.value = 0
  assert.equal(cutDepth(camera), 2)
  const ahead = new Ray(new Vector3(), new Vector3(0, 0, -1))
  assert.equal(cutAlong(ahead, camera), 2)
  // A ray 60° off the way the camera looks covers twice the distance to reach the same depth
  const slanted = new Ray(new Vector3(), new Vector3(Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3)))
  assert.ok(Math.abs(cutAlong(slanted, camera) - 4) < 1e-9)
  // Clip's cut, once it's farther than the near plane
  clipDepth.value = 10
  assert.equal(cutDepth(camera), 10)
  assert.equal(cutAlong(ahead, camera), 10)
  assert.ok(Math.abs(cutAlong(slanted, camera) - 20) < 1e-9)
  // And the near plane again while the cut is nearer than it
  clipDepth.value = 1
  assert.equal(cutDepth(camera), 2)
})

void test('the cut follows the camera wherever it looks from', (t) => {
  t.after(() => {
    clipDepth.value = 0
  })
  clipDepth.value = 5
  const camera = cameraWith(1)
  camera.position.set(20, 0, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const towards = new Ray(camera.position.clone(), new Vector3(-1, 0, 0))
  assert.ok(Math.abs(cutAlong(towards, camera) - 5) < 1e-9)
  // A ray 60° off the way the camera looks, in the level plane, reaches the cut's depth at twice its distance
  const slanted = new Ray(camera.position.clone(), new Vector3(-Math.cos(Math.PI / 3), 0, Math.sin(Math.PI / 3)))
  assert.ok(Math.abs(cutAlong(slanted, camera) - 10) < 1e-9)
})
