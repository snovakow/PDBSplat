import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { fog, rangeFogFactor, vec3 } from 'three/tsl'
import { useStore } from '../store.ts'
import type { Bounds } from './bounds.ts'
import { cueFar, cueNear, depthCue, optionUniforms, structureRadius } from './shading.ts'

interface Props {
  bounds: Bounds
}

// Copies the panel's shading options and the entry's radius into the shading's uniforms, in every style,
// and gives the surface the splats' depth cue as fog: its material takes fog and theirs doesn't
export function ShadingUniforms({ bounds }: Props) {
  const get = useThree((s) => s.get)
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

  // Fog to black reads as a depth cue over the page's black, and at Depth cue 0 it leaves the colour untouched.
  // Setting or clearing it recompiles the scene's materials once
  useEffect(() => {
    const { scene } = get()
    scene.fogNode = fog(vec3(0), rangeFogFactor(cueNear, cueFar).mul(depthCue))
    return () => {
      scene.fogNode = null
    }
  }, [get])

  return null
}

// Keeps one shading option's uniform at the store's value
function useOptionUniform(option: keyof typeof optionUniforms) {
  const value = useStore((s) => s.options[option])
  useEffect(() => {
    optionUniforms[option].value = value
  }, [option, value])
}
