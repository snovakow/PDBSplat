import { useEffect } from 'react'
import { useStore } from '../store.ts'
import { optionUniforms } from './shading.ts'

// Copies the panel's shading options into the shading's uniforms, in every style. The entry's radius is the framing's
// to set, as it eases
export function ShadingUniforms() {
  useOptionUniform('opacity')
  useOptionUniform('hardness')
  useOptionUniform('shading')
  useOptionUniform('highlight')
  useOptionUniform('shininess')
  useOptionUniform('outline')
  useOptionUniform('depthCue')

  return null
}

// Keeps one shading option's uniform at the store's value
function useOptionUniform(option: keyof typeof optionUniforms) {
  const value = useStore((s) => s.options[option])
  useEffect(() => {
    optionUniforms[option].value = value
  }, [option, value])
}
