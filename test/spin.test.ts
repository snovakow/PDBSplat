import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { PerspectiveCamera } from 'three'
import { OrbitControls } from 'three-stdlib'
import { longestFrame, spinSpeed, turnSeconds } from '../src/viewer/spinSpeed.ts'

// Spin's speed, on the orbit controls drei wraps, which are three-stdlib's: that it turns the camera once every
// turnSeconds whatever the frame rate, and that a frame longer than longestFrame turns it no further than one of
// longestFrame. The app reaches three-stdlib only through drei, and it's among this project's own packages for these
// tests alone, which the first of them holds to the copy drei wraps

void test('the orbit controls driven here are the copy of three-stdlib that drei wraps', () => {
  const ours = createRequire(import.meta.url).resolve('three-stdlib')
  const dreis = createRequire(import.meta.resolve('@react-three/drei')).resolve('three-stdlib')
  assert.equal(ours, dreis)
})

// How far the orbit controls turn the camera about the vertical axis over frames of the times given, in seconds, in
// turns: negative as they turn it to its left, which turns the structure to the right. The controls are as drei sets
// them, with damping, and their speed is set before each update as Spin sets it. The turn is summed frame by frame, so
// that it can run past half a turn
function turned(frames: readonly number[]) {
  const camera = new PerspectiveCamera()
  camera.position.set(0, 0, 10)
  const controls = new OrbitControls(camera)
  controls.enableDamping = true
  controls.autoRotate = true
  let turn = 0
  let azimuth = 0
  for (const frame of frames) {
    controls.autoRotateSpeed = spinSpeed(frame)
    controls.update()
    const next = Math.atan2(camera.position.x, camera.position.z)
    // Each frame's step, the short way round
    turn += Math.atan2(Math.sin(next - azimuth), Math.cos(next - azimuth))
    azimuth = next
  }
  return turn / (2 * Math.PI)
}

// Frames at a steady rate, lasting the seconds given
const steady = (seconds: number, fps: number) => Array.from({ length: Math.round(seconds * fps) }, () => 1 / fps)

void test('Spin turns the camera to its left once every turnSeconds, whatever the frame rate', () => {
  for (const fps of [24, 60, 144]) {
    // Once the damping has eased the turn in, a quarter of a turn's time turns it a quarter turn
    const easedIn = steady(10, fps)
    const quarter = turned([...easedIn, ...steady(turnSeconds / 4, fps)]) - turned(easedIn)
    assert.ok(Math.abs(quarter + 0.25) < 1e-6, `${fps} fps: ${quarter}`)
  }
})

void test('a frame longer than longestFrame turns the camera no further than one of longestFrame', () => {
  const before = steady(5, 60)
  const after = steady(5, 60)
  // A stall of 5 seconds, such as a rebuild of the atoms, turns it as far as a frame of longestFrame
  assert.equal(turned([...before, 5, ...after]), turned([...before, longestFrame, ...after]))
  // That's longestFrame's share of a turn, once the damping has eased it out
  const extra = turned([...before, longestFrame, ...after]) - turned([...before, ...after])
  assert.ok(Math.abs(extra + longestFrame / turnSeconds) < 1e-6, String(extra))
})
