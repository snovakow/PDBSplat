import { useEffect } from 'react'
import { useStore } from '../store.ts'

// How long each model shows while the models play, in milliseconds: about four a second
const modelDuration = 250

// Plays an entry's models as an animation while it's mounted, showing each in turn and starting over after the last.
// Each step redraws the atoms, and the surface meshes the latest model it can keep up with
export function ModelPlayer() {
  const nextModel = useStore((s) => s.nextModel)

  useEffect(() => {
    const timer = setInterval(nextModel, modelDuration)
    return () => clearInterval(timer)
  }, [nextModel])

  return null
}
