import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStore } from './store.ts'

// How far the label sits from the pointer, in CSS pixels, below and to its right, or above and to its left near the
// window's far edges
const pointerGap = 14

// The atom under the pointer, named in a label beside it: its name and element, its residue and chain, its B-factor,
// and its occupancy when the atom is only partly there
export function AtomLabel() {
  const atom = useStore((s) => s.hovered)
  const label = useRef<HTMLDivElement>(null)
  const pointer = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current.x = event.clientX
      pointer.current.y = event.clientY
      if (label.current) place(label.current, event.clientX, event.clientY)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  // A label that has just appeared or changed takes its size before it's placed
  useLayoutEffect(() => {
    if (atom && label.current) place(label.current, pointer.current.x, pointer.current.y)
  }, [atom])

  return (
    <div ref={label} className="atom-label" hidden={!atom}>
      {atom && (
        <>
          <div>
            <strong>{atom.atomName}</strong> <span className="atom-label-detail">{atom.element}</span>
          </div>
          <div>
            {atom.residueName} {atom.residueNumber}
            {atom.insertion}
            {atom.chain && <span className="atom-label-detail"> chain {atom.chain}</span>}
          </div>
          <div>
            <span className="atom-label-detail">B-factor</span> {atom.bFactor.toFixed(2)}
            {atom.occupancy < 1 && (
              <>
                {' '}
                <span className="atom-label-detail">occupancy</span> {atom.occupancy.toFixed(2)}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Beside the pointer at x, y, on whichever side keeps the label inside the window
function place(element: HTMLElement, x: number, y: number) {
  const width = element.offsetWidth
  const height = element.offsetHeight
  const left = x + pointerGap + width > window.innerWidth ? x - pointerGap - width : x + pointerGap
  const top = y + pointerGap + height > window.innerHeight ? y - pointerGap - height : y + pointerGap
  element.style.translate = `${left}px ${top}px`
}
