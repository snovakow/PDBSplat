import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  altLocOf,
  atomNameOf,
  chainOf,
  elementOf,
  insertionOf,
  modelOf,
  residueNameOf,
} from './pdb/structure.ts'
import { useStore } from './store.ts'

// How far the label sits from the pointer, in CSS pixels, below and to its right, or above and to its left near the
// window's far edges
const pointerGap = 14

// The atom under the pointer, named in a label beside it: its name and element, and its alternate ID if it has one;
// its residue with any insertion code, its chain, and its model when the entry has more than one; its B-factor, and its
// occupancy when the atom is only partly there
export function AtomLabel() {
  const atom = useStore((s) => s.hovered)
  const structure = useStore((s) => s.structure)
  const manyModels = useStore((s) => s.models.length > 1)
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
    if (atom !== null && label.current) place(label.current, pointer.current.x, pointer.current.y)
  }, [atom])

  const residue = atom === null ? 0 : structure.atoms.residue[atom]
  const altLoc = atom === null ? '' : altLocOf(structure, atom)
  const chain = atom === null ? '' : structure.chains.name[chainOf(structure, atom)]
  const occupancy = atom === null ? 1 : structure.atoms.occupancy[atom]
  return (
    <div ref={label} className="atom-label" hidden={atom === null}>
      {atom !== null && (
        <>
          <div>
            <strong>{atomNameOf(structure, atom)}</strong>{' '}
            <span className="atom-label-detail">{elementOf(structure, atom)}</span>
            {altLoc && (
              <>
                {' '}
                <span className="atom-label-detail">alternate</span> {altLoc}
              </>
            )}
          </div>
          <div>
            {residueNameOf(structure, atom)} {structure.residues.number[residue]}
            {insertionOf(structure, residue)}
            {chain && <span className="atom-label-detail"> chain {chain}</span>}
            {manyModels && <span className="atom-label-detail"> model {modelOf(structure, atom)}</span>}
          </div>
          <div>
            <span className="atom-label-detail">B-factor</span> {structure.atoms.bFactor[atom].toFixed(2)}
            {occupancy < 1 && (
              <>
                {' '}
                <span className="atom-label-detail">occupancy</span> {occupancy.toFixed(2)}
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
