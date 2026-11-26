import { longestFrame } from './spinSpeed.ts'

// How often the page draws while an entry arrives. Every frame drawn takes the processor and the GPU from the loader's
// worker: on a two-core laptop a giant drawn at every frame the display showed took two to three times as long to
// arrive, and drawn ten frames a second no longer than it took to arrive before it was drawn as it arrived. So while
// one arrives the frames are drawn only so often, but for a drag, a turn of the wheel or a pinch, which draws every
// frame while it lasts and while the controls' damping carries the view on after it

// The time between the frames drawn while an entry arrives: the longest frame Spin keeps pace with, so that the
// structure turns at its own speed all the while, as few frames drawn as that allows
export const arrivingFrameMs = longestFrame * 1000
// How long after a drag, a turn of the wheel or a pinch ends the view still draws every frame, while the damping
// carries it on: the controls' damping takes a twentieth of what's left each frame, leaving under 1% of it after 90
// frames, a second and a half at sixty frames a second
export const settleMs = 1500
// A frame that falls due within this of a display frame is drawn at it, rather than at the next
const leadMs = 4

// The pacing's state: when the last frame was drawn, whether the view is held by a drag, and until when it settles
// after one
export interface Pacing {
  drawn: number
  held: boolean
  settles: number
}

// Whether the display frame at a time draws a frame: every one while the view is held or settling, and otherwise
// once the time between frames has passed since the last
export function frameDue({ drawn, held, settles }: Pacing, now: number) {
  return held || now < settles || now - drawn >= arrivingFrameMs - leadMs
}
