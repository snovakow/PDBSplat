import { button, folder, LevaInputs, useControls } from 'leva'
import { useEffect } from 'react'
import { atomText } from './atomText.ts'
import { isOption, optionKeys, viewOptions, type Dependence, type Folder, type ShownFor, type ViewOptions } from './options.ts'
import { examples, firstEntry, shownAtoms, useStore, type Status } from './store.ts'
import { styleOf, styles, type Style } from './viewer/styles.ts'

const statusText: Record<Status, string> = { idle: '', loading: 'Loading…', ready: 'Ready', failed: '' }

// Each example as the panel lists it, such as "1CRN crambin"
const exampleOptions = Object.fromEntries(examples.map((example) => [`${example.id} ${example.name}`, example.id]))

// The full path in the panel of an option's control, its folder and its key, which a render test reads it by, as it
// reads nothing from a bare key inside a folder
const pathOf = (option: keyof ViewOptions) => `${viewOptions[option].folder}.${option}`
const stylePath = pathOf('style')

// The path of the control an entry depends on, which the table names by its key
function optionPath(key: string) {
  if (!isOption(key)) throw new Error(`No option is named ${key}`)
  return pathOf(key)
}

// Whether a value a render test reads is a style's id
const isStyle = (value: unknown): value is Style => styles.some((style) => style.id === value)

// The styles by their labels in the panel
const styleOptions = Object.fromEntries(styles.map((style) => [style.label, style.id]))

// Whether a control is shown for a style
function shownForStyle(shownFor: ShownFor, style: Style) {
  if (shownFor === 'every') return true
  return 'kind' in shownFor ? styleOf(style).kind === shownFor.kind : shownFor.styles.includes(style)
}

// Whether a control another hides is shown, by that control's value
function shownWhile(dependence: Dependence, value: unknown) {
  if ('is' in dependence) return value === dependence.is
  if ('isNot' in dependence) return value !== dependence.isNot
  return typeof value === 'number' && value > dependence.above
}

interface PanelProps {
  forceWebGL: boolean
  setForceWebGL: (forceWebGL: boolean) => void
  // Which backend is drawing, and why when the GPU is known to fail WebGPU
  renderer: string
}

// The leva panel: the view options go to the store as they change, and the entry's details come back read-only.
// The Example and Use WebGL 2 handlers act only on changes made in the panel, so the values set below don't echo back
export function Panel({ forceWebGL, setForceWebGL, renderer }: PanelProps) {
  const id = useStore((s) => s.id)
  const title = useStore((s) => s.title)
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const shown = useStore((s) => shownAtoms(s).length)
  const picked = useStore((s) => s.picked)
  const manyModels = useStore((s) => s.models.length > 1)

  const [, set] = useControls(() => {
    const { load, setOptions } = useStore.getState()

    // The control of one option, which sets the option as it changes, shown for the styles its entry names and while
    // the control its entry depends on allows
    const control = <K extends keyof ViewOptions>(option: K) => {
      const entry = viewOptions[option]
      const forStyles = entry.shownFor === 'every' ? null : entry.shownFor
      const dependence = entry.shownWhile ? { ...entry.shownWhile, path: optionPath(entry.shownWhile.option) } : null
      const render =
        forStyles || dependence
          ? (get: (path: string) => unknown) => {
              const style = get(stylePath)
              const forStyle = !forStyles || (isStyle(style) && shownForStyle(forStyles, style))
              return forStyle && (!dependence || shownWhile(dependence, get(dependence.path)))
            }
          : undefined
      const onChange = (value: ViewOptions[K]) => {
        const changes: Partial<ViewOptions> = {}
        changes[option] = value
        setOptions(changes)
      }
      const common = { label: entry.label, onChange, ...(render && { render }) }
      if (entry.kind === 'slider') return { ...common, value: entry.default, min: entry.min, max: entry.max, step: entry.step }
      if (entry.kind === 'switch') return { ...common, value: entry.default }
      if (entry.kind === 'choice') return { ...common, options: entry.choices, value: entry.default }
      return { ...common, options: styleOptions, value: entry.default }
    }
    // A folder's controls, in the table's order
    const controls = (name: Folder) =>
      Object.fromEntries(optionKeys.filter((option) => viewOptions[option].folder === name).map((option) => [option, control(option)]))

    return {
      example: {
        label: 'Example',
        options: exampleOptions,
        value: firstEntry,
        onChange: (example: string, _path, { fromPanel }) => {
          if (fromPanel) void load(example)
        },
      },
      // Without the type, leva takes an ID like 1CRN for the number 1 with the unit CRN, as in 10px
      id: { label: 'PDB ID', value: firstEntry, type: LevaInputs.STRING },
      Load: button((get) => void load(String(get('id')))),
      Look: folder(controls('Look')),
      Colour: folder(controls('Colour')),
      Atoms: folder(controls('Atoms')),
      Scene: folder(controls('Scene')),
      Info: folder({
        webgl: {
          label: 'Use WebGL 2',
          value: forceWebGL,
          // Inside a folder, leva's types leave a transient control out of set, which the effect below calls with it
          transient: false,
          onChange: (webgl: boolean, _path, { fromPanel }) => {
            if (fromPanel) setForceWebGL(webgl)
          },
        },
        renderer: { label: 'Renderer', value: '', editable: false },
        entry: { label: 'Entry', value: '', editable: false },
        shown: { label: 'Atoms shown', value: '', editable: false },
        picked: { label: 'Picked', value: '', editable: false },
        status: { label: 'Status', value: '', editable: false },
      }),
    }
  })

  // Once an entry has loaded, the ID field shows it, and so does the example list if it's one of the examples
  useEffect(() => {
    if (!id) return
    set(examples.some((example) => example.id === id) ? { id, example: id } : { id })
  }, [set, id])

  // The checkbox follows the flag, which a WebGPU failure also sets
  useEffect(() => {
    set({ webgl: forceWebGL, renderer: renderer || 'Starting…' })
  }, [set, forceWebGL, renderer])

  useEffect(() => {
    set({
      entry: id ? `${id}: ${title}` : '',
      shown: id ? shown.toLocaleString('en') : '',
      status: error ?? statusText[status],
    })
  }, [set, id, title, shown, status, error])

  useEffect(() => {
    set({ picked: picked ? atomText(picked, manyModels) : '' })
  }, [set, picked, manyModels])

  return null
}
