import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Matrix4, Raycaster, Vector2 } from 'three'
import { useStore, type PickHit, type PickTest } from '../store.ts'

// A press released within this many CSS pixels of where it began is a click, which picks; a longer one orbits or pans
const clickTolerance = 4

// Names the atom under the pointer as it moves, at most once a frame and never while a button is held, and picks the
// atom a click lands on, or clears the pick on a click on empty space. It listens beside the orbit controls and leaves
// their events alone
export function Picking() {
  const get = useThree((s) => s.get)
  // The hover test, which the frame callback runs while the listeners are on
  const hoverTest = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = get().gl.domElement
    const page = canvas.ownerDocument
    const { hover, pick } = useStore.getState()
    const raycaster = new Raycaster()
    const coords = new Vector2()
    const hit: PickHit = { atom: null, distance: Infinity }
    // The pointer as the listeners last heard it: whether it's over the canvas with no button held, where, in CSS
    // pixels from the canvas's top left, and whether it has moved since the last hover test. Then where a press of the
    // main button began, in the page's CSS pixels, while it's held
    const pointer = { over: false, x: 0, y: 0, moved: false, pressed: false, pressX: 0, pressY: 0 }
    // What the last hover test saw: the view, and the drawing components' picks
    const last: { view: Matrix4; picks: readonly PickTest[] } = { view: new Matrix4(), picks: [] }

    // The nearest atom any drawing component draws under a point of the canvas, as its last render showed it
    const atomAt = (atX: number, atY: number) => {
      coords.set((atX / canvas.clientWidth) * 2 - 1, 1 - (atY / canvas.clientHeight) * 2)
      raycaster.setFromCamera(coords, get().camera)
      hit.atom = null
      hit.distance = Infinity
      for (const test of useStore.getState().picks) test(raycaster, hit)
      return hit.atom
    }

    // The atom under a still pointer changes too when the view does, or what's drawn
    hoverTest.current = () => {
      if (!pointer.over) return
      const view = get().camera.matrixWorld
      const { picks } = useStore.getState()
      if (!pointer.moved && picks === last.picks && view.equals(last.view)) return
      pointer.moved = false
      last.picks = picks
      last.view.copy(view)
      hover(atomAt(pointer.x, pointer.y))
    }

    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        pointer.over = false
        hover(null)
        return
      }
      pointer.over = true
      pointer.x = event.offsetX
      pointer.y = event.offsetY
      pointer.moved = true
    }
    const onLeave = () => {
      pointer.over = false
      hover(null)
    }
    // A press hides the label until the pointer moves again with no button held, so it doesn't flicker in an orbit
    const onDown = (event: PointerEvent) => {
      pointer.over = false
      hover(null)
      if (event.button !== 0) return
      pointer.pressed = true
      pointer.pressX = event.clientX
      pointer.pressY = event.clientY
    }
    // The orbit controls capture the pointer while a button is held, so the release is heard on the page
    const onUp = (event: PointerEvent) => {
      if (!pointer.pressed || event.button !== 0) return
      pointer.pressed = false
      if (Math.hypot(event.clientX - pointer.pressX, event.clientY - pointer.pressY) > clickTolerance) return
      const bounds = canvas.getBoundingClientRect()
      pointer.x = event.clientX - bounds.left
      pointer.y = event.clientY - bounds.top
      pick(atomAt(pointer.x, pointer.y))
      // A mouse is still over what it clicked, so the label comes back at once; a finger has lifted away
      if (event.pointerType !== 'touch') {
        pointer.over = true
        pointer.moved = true
      }
    }
    const onCancel = () => {
      pointer.pressed = false
    }

    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('pointerdown', onDown)
    page.addEventListener('pointerup', onUp)
    page.addEventListener('pointercancel', onCancel)
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      page.removeEventListener('pointerup', onUp)
      page.removeEventListener('pointercancel', onCancel)
      hoverTest.current = null
      hover(null)
    }
  }, [get])

  useFrame(() => hoverTest.current?.())

  return null
}
