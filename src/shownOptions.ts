import {
  isOption,
  viewOptions,
  type Dependence,
  type EntryHolds,
  type ShownFor,
  type ViewOptions,
} from './options.ts'
import { isOpaque, styleOf, type Style } from './viewer/styles.ts'

// Which controls the panel shows for a set of options and an entry: each for the styles its row of the table names,
// and only while the other options and the entry leave it something to change, by the test its row gives. So a hidden
// control's value changes nothing that's drawn

// Whether a control is shown for a style
function shownForStyle(shownFor: ShownFor, style: Style) {
  if (shownFor === 'every') return true
  return 'kind' in shownFor ? styleOf(style).kind === shownFor.kind : shownFor.styles.includes(style)
}

// Whether the test a control shows by holds. One on another control fails while that control is hidden, so that a
// hidden control takes with it the controls that depend on it
function holds(dependence: Dependence, options: ViewOptions, entry: EntryHolds): boolean {
  if ('opaque' in dependence) return isOpaque(options, entry)
  if ('entryHolds' in dependence) return entry[dependence.entryHolds]
  const { option } = dependence
  if (!isOption(option)) throw new Error(`No option is named ${option}`)
  if (!optionShows(option, options, entry)) return false
  const value = options[option]
  if ('is' in dependence) return value === dependence.is
  if ('isNot' in dependence) return value !== dependence.isNot
  if (typeof value !== 'number') return false
  return 'above' in dependence ? value > dependence.above : value < dependence.below
}

// Whether the panel shows an option's control, for the options as they stand and what the entry holds
export function optionShows(option: keyof ViewOptions, options: ViewOptions, entry: EntryHolds): boolean {
  const { shownFor, shownWhile } = viewOptions[option]
  return shownForStyle(shownFor, options.style) && (!shownWhile || holds(shownWhile, options, entry))
}
