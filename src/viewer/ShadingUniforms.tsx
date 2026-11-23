import { useEffect } from 'react'
import { useStore } from '../store.ts'
import type { Bounds } from './bounds.ts'
import { optionUniforms, structureRadius } from './shading.ts'

interface Props {
  bounds: Bounds
}

// Copies the panel's shading options and the entry's radius into the shading's uniforms, in every style
export function ShadingUniforms({ bounds }: Props) {
  useOptionUniform('opacity')
  useOptionUniform('hardness')
  useOptionUniform('shading')
  useOptionUniform('highlight')
  useOptionUniform('shininess')
  useOptionUniform('outline')
  useOptionUniform('depthCue')

  useEffect(() => {
    structureRadius.value = bounds.radius
  }, [bounds])

  return null
}

// Keeps one shading option's uniform at the store's value
function useOptionUniform(option: keyof typeof optionUniforms) {
  const value = useStore((s) => s.options[option])
  useEffect(() => {
    optionUniforms[option].value = value
  }, [option, value])
}
