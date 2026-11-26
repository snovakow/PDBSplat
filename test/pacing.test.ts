import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrivingFrameMs, frameDue, settleMs } from '../src/viewer/pacing.ts'

// The frames drawn while an entry arrives: one only so often, but every one while a drag holds the view and while it
// settles after one

void test('an arriving entry draws a frame once the time between frames has passed, and every one while the view is held or settling', () => {
  const pacing = { drawn: 1000, held: false, settles: -Infinity }
  // The first frame is due at once
  assert.equal(frameDue({ ...pacing, drawn: -Infinity }, 0), true)
  // The next not before its time, but at the display frame that falls just short of it
  assert.equal(frameDue(pacing, 1000 + arrivingFrameMs / 2), false)
  assert.equal(frameDue(pacing, 1000 + arrivingFrameMs - 1), true)
  // A drag draws every frame, and the view settling after one does until it has settled
  assert.equal(frameDue({ ...pacing, held: true }, 1001), true)
  assert.equal(frameDue({ ...pacing, settles: 1000 + settleMs }, 1000 + settleMs / 2), true)
  assert.equal(frameDue({ ...pacing, settles: 1010 }, 1020), false)
})
