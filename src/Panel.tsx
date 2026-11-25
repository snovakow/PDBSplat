import { button, folder, LevaInputs, useControls } from 'leva'
import { useEffect } from 'react'
import { atomText } from './atomText.ts'
import { optionKeys, viewOptions, type Folder, type ViewOptions } from './options.ts'
import { presetList, presets, withPreset } from './presets.ts'
import { optionShows } from './shownOptions.ts'
import { entryHolds, examples, firstEntry, shownAtoms, useStore, type Status } from './store.ts'
import { styles } from './viewer/styles.ts'

const statusText: Record<Status, string> = { idle: '', loading: 'Loading…', ready: 'Ready', failed: '' }

// Each example as the panel lists it, such as "1CRN crambin"
const exampleOptions = Object.fromEntries(examples.map((example) => [`${example.id} ${example.name}`, example.id]))

// The styles by their labels in the panel
const styleOptions = Object.fromEntries(styles.map((style) => [style.label, style.id]))

// What the controls below the Preset list can be set to: the options, by their keys, which leva's own types can't see
// inside folders built from the table, and the panel's own fields
interface PanelValues extends Partial<ViewOptions> {
  example?: string
  id?: string
  webgl?: boolean
  renderer?: string
  entry?: string
  shown?: string
  picked?: string
  status?: string
}
type PanelControls = [values: unknown, set: (values: PanelValues) => void, get: unknown]

interface PanelProps {
  forceWebGL: boolean
  setForceWebGL: (forceWebGL: boolean) => void
  // Which backend is drawing
  renderer: string
}

// The leva panel: the view options go to the store as they change, and the entry's details come back read-only. The
// controls follow the store's options, which a preset sets all at once. The Preset, Example and Use WebGL 2 handlers
// act only on changes made in the panel, so the values set below don't echo back
export function Panel({ forceWebGL, setForceWebGL, renderer }: PanelProps) {
  const options = useStore((s) => s.options)
  // The same object while the entry's atoms and models stand
  const held = useStore(entryHolds)
  // The names the Preset list offers for the options and the entry
  const presetNames = presetList(options, held).names

  // The Preset list, in controls of its own, ahead of the rest, so that it sits at the top of the panel, as it sets
  // most of what's below it: choosing a preset sets every option of its look at once. They're built again as the names
  // the list offers change, which gives the list its new names and leaves what it reads to the effect below. Built
  // again, leva hands the list's handler the choice it already holds, as it does at first, which sets nothing: only a
  // choice made in the panel since does
  const [, setPreset] = useControls(
    () => ({
      preset: {
        label: 'Preset',
        options: presetNames,
        value: presetList(options, held).reads,
        onChange: (name: string, _path, { initial, fromPanel }) => {
          if (initial || !fromPanel) return
          const chosen = presets.find((candidate) => candidate.name === name)
          const { options: current, setOptions } = useStore.getState()
          if (chosen) setOptions(withPreset(current, chosen))
        },
      },
    }),
    [presetNames],
  )
  const id = useStore((s) => s.id)
  const title = useStore((s) => s.title)
  const status = useStore((s) => s.status)
  const error = useStore((s) => s.error)
  const shown = useStore((s) => shownAtoms(s).count)
  const structure = useStore((s) => s.structure)
  const picked = useStore((s) => s.picked)
  const manyModels = useStore((s) => s.models.length > 1)

  const [, set]: PanelControls = useControls(() => {
    const { load, setOptions } = useStore.getState()

    // The control of one option, which sets the option as it changes, shown only while the options and the entry leave
    // it something to change. The test reads the store, not the panel's own values: leva runs it whenever a value of
    // the panel's is set, which the effects below do with every change of the options and of the entry
    const control = <K extends keyof ViewOptions>(option: K) => {
      const entry = viewOptions[option]
      const hides = entry.shownFor !== 'every' || entry.shownWhile !== undefined
      const shows = () => {
        const state = useStore.getState()
        return optionShows(option, state.options, entryHolds(state))
      }
      const render = hides ? shows : undefined
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
      // Atoms and Scene start folded: they hold the controls that change what's drawn and the scene around it, which a
      // visitor reaches for after the look and the colour, so that the entry, the look, the colour and the read-outs,
      // the Status among them, sit together near the top of a panel that would otherwise run past a short window
      Look: folder(controls('Look')),
      Colour: folder(controls('Colour')),
      Atoms: folder(controls('Atoms'), { collapsed: true }),
      Scene: folder(controls('Scene'), { collapsed: true }),
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

  // The controls show the options, so that a preset moves every control it sets, and the Preset list names the preset
  // they're of for the entry, or reads custom, which it lists by now. Each control the options move tells the store
  // its value, which it already has. Setting them also has leva test again which controls show, against the options
  // and the entry as they now are
  useEffect(() => {
    setPreset({ preset: presetList(options, held).reads })
    set(options)
  }, [setPreset, set, options, held])

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
    set({ picked: picked === null ? '' : atomText(structure, picked, manyModels) })
  }, [set, structure, picked, manyModels])

  return null
}
