import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Ray, Vector3 } from 'three'
import { baseNear, beyondCut, cutAlong, cutDepth } from '../src/viewer/nearPlane.ts'
import { clipDepth } from '../src/viewer/shading.ts'

// The cut nothing is drawn nearer than: Clip's cut, or the camera's near plane where that's farther, as a pick reads it

// A camera at the origin looking down the z axis, as a render leaves its matrices
function cameraWith(near: number) {
  const camera = new PerspectiveCamera(50, 1, near, 1000)
  camera.updateMatrixWorld()
  return camera
}

void test("the near plane sits a hundredth of the structure's radius away", () => {
  assert.equal(baseNear(50), 0.5)
  assert.equal(baseNear(0), 0)
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
  assert.equal(beyondCut(new Vector3(0, 0, -2.5), camera), true)
  assert.equal(beyondCut(new Vector3(0, 0, -1.5), camera), false)
  // Clip's cut, once it's farther than the near plane
  clipDepth.value = 10
  assert.equal(cutDepth(camera), 10)
  assert.equal(cutAlong(ahead, camera), 10)
  assert.equal(beyondCut(new Vector3(3, 0, -9.5), camera), false)
  assert.equal(beyondCut(new Vector3(3, 0, -10.5), camera), true)
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
  assert.equal(beyondCut(new Vector3(16, 0, 0), camera), false)
  assert.equal(beyondCut(new Vector3(14, 0, 0), camera), true)
})
