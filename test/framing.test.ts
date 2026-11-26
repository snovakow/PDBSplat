import assert from 'node:assert/strict'
import { test } from 'node:test'
import { easedLeft, easeSeconds, framingDistance } from '../src/viewer/framing.ts'

// The view's ease towards the bounds as an entry arrives: one curve however the time is split into frames, reached in
// a finite time and never passed; and the distance that frames a sphere

// What's left of an ease after frames of the given lengths, in seconds
function after(left: number, frames: number[], speed: number) {
  let remaining = left
  for (const seconds of frames) remaining = easedLeft(remaining, seconds, speed)
  return remaining
}

// Frames of random lengths between 5 and 100 milliseconds adding up to a span, from a seed
function randomFrames(span: number, seed: number) {
  let state = seed
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const frames: number[] = []
  let total = 0
  while (total < span) {
    const length = Math.min(0.005 + random() * 0.095, span - total)
    frames.push(length)
    total += length
  }
  return frames
}

void test('the ease follows the same curve however its time is split into frames', () => {
  const speed = 4
  for (const span of [0.1, 0.5, 1.3]) {
    const whole = after(100, [span], speed)
    assert.ok(whole > 0)
    const sixtieths = after(100, Array.from({ length: Math.round(span * 60) }, () => span / Math.round(span * 60)), speed)
    assert.ok(Math.abs(sixtieths - whole) < 1e-9, `${span} s in sixtieths: ${sixtieths} against ${whole}`)
    for (const seed of [1, 2, 3]) {
      const random = after(100, randomFrames(span, seed), speed)
      assert.ok(Math.abs(random - whole) < 1e-9, `${span} s in random frames: ${random} against ${whole}`)
    }
  }
})

void test('the ease reaches its target in a finite time, falling every frame, and never passes it', () => {
  for (const speed of [0.5, 4, 40]) {
    let left = 100
    let seconds = 0
    let previous = left
    while (left > 0) {
      left = easedLeft(left, 1 / 50, speed)
      seconds += 1 / 50
      assert.ok(left >= 0 && left < previous, `${speed}: ${left} after ${previous}`)
      previous = left
      assert.ok(seconds < 60, `${speed}: still ${left} to go after a minute`)
    }
    // The time to arrive is the curve's own: what's left plus the least speed's share falls by e every ease time
    const expected = easeSeconds * Math.log(1 + 100 / (speed * easeSeconds))
    assert.ok(Math.abs(seconds - expected) <= 1 / 50, `${speed}: arrived after ${seconds} s, expected ${expected}`)
  }
  // A frame longer than the whole ease ends on the target, not past it, and nothing is left of nothing
  assert.equal(easedLeft(100, 1000, 4), 0)
  assert.equal(easedLeft(0, 0.02, 4), 0)
  assert.equal(easedLeft(-3, 0.02, 4), 0)
})

void test('the framing distance holds a sphere in the narrower of the two fields of view, with room around it', () => {
  const tall = framingDistance(10, { fov: 50, aspect: 2 })
  // Wide, the vertical field of view is the narrower
  assert.ok(Math.abs(tall - (10 / Math.sin((25 * Math.PI) / 180)) * 1.15) < 1e-9)
  // Narrow, the horizontal one is, and the camera stands farther back
  const narrow = framingDistance(10, { fov: 50, aspect: 0.5 })
  assert.ok(narrow > tall)
  const halfX = Math.atan(Math.tan((25 * Math.PI) / 180) * 0.5)
  assert.ok(Math.abs(narrow - (10 / Math.sin(halfX)) * 1.15) < 1e-9)
  assert.equal(framingDistance(20, { fov: 50, aspect: 2 }), tall * 2)
})
