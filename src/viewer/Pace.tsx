import type { OrbitControls } from '@react-three/drei'
import { advance, useThree } from '@react-three/fiber'
import { useEffect, type ComponentRef, type RefObject } from 'react'
import { useStore } from '../store.ts'
import { frameDue, settleMs, type Pacing } from './pacing.ts'

interface Props {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
}

// While an entry arrives, the frames are drawn only so often, by a loop of the page's own in place of R3F's, and every
// frame again while a drag, a turn of the wheel or a pinch moves the view and while it settles after one. The frames
// ease, spin and turn by the time that has passed since the last, so drawing fewer of them changes how smoothly the
// view moves and not where it goes. Once the entry has all arrived, or its load ends without it, R3F draws every frame
// again
export function Pace({ controlsRef }: Props) {
  const arriving = useStore((s) => s.status === 'loading' && !s.structure.whole)
  const get = useThree((s) => s.get)
  useEffect(() => {
    const controls = controlsRef.current
    if (!arriving || !controls) return undefined
    // R3F's own clock counts from nought again, by the times its frames are given
    get().setFrameloop('never')
    const start = performance.now()
    const pacing: Pacing = { drawn: -Infinity, held: false, settles: -Infinity }
    const onStart = () => {
      pacing.held = true
    }
    const onEnd = () => {
      pacing.held = false
      pacing.settles = performance.now() + settleMs
    }
    controls.addEventListener('start', onStart)
    controls.addEventListener('end', onEnd)
    // The display frame asked for next, which the loop is ended by cancelling
    const loop = { frame: 0 }
    const tick = (now: number) => {
      loop.frame = requestAnimationFrame(tick)
      if (!frameDue(pacing, now)) return
      pacing.drawn = now
      advance(Math.max(0, now - start) / 1000, true, get())
    }
    loop.frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(loop.frame)
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('end', onEnd)
      get().setFrameloop('always')
    }
  }, [arriving, get, controlsRef])
  return null
}
