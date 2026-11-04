import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type BloomNode from 'three/addons/tsl/display/BloomNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { pass } from 'three/tsl'
import { RenderPipeline } from 'three/webgpu'
import { useStore } from '../store.ts'
import { asWebGPU } from './renderer.ts'

// Above R3F's own render, which a frame callback at a higher priority takes over until it unmounts
const renderPriority = 1

// The scene drawn through a pipeline of passes, with bloom spreading a glow around its bright parts, in place of R3F's
// own render. It renders only while it's mounted, so the scene renders directly whenever there's no effect to apply
export function Effects() {
  const get = useThree((s) => s.get)
  const strength = useStore((s) => s.options.bloom)
  const radius = useStore((s) => s.options.bloomRadius)
  const threshold = useStore((s) => s.options.bloomThreshold)
  const pipeline = useRef<RenderPipeline | null>(null)
  const glow = useRef<BloomNode | null>(null)

  useEffect(() => {
    const { gl, scene, camera } = get()
    const scenePass = pass(scene, camera)
    const sceneColor = scenePass.getTextureNode('output')
    // Bloom's settings are uniforms, which the effects below set without building the pipeline again
    const bloomNode = bloom(sceneColor)
    const built = new RenderPipeline(asWebGPU(gl), sceneColor.add(bloomNode))
    pipeline.current = built
    glow.current = bloomNode
    // The pipeline frees only its own quad, so the passes it runs are freed first
    return () => {
      pipeline.current = null
      glow.current = null
      bloomNode.dispose()
      scenePass.dispose()
      built.dispose()
    }
  }, [get])

  useEffect(() => {
    if (glow.current) glow.current.strength.value = strength
  }, [strength])
  useEffect(() => {
    if (glow.current) glow.current.radius.value = radius
  }, [radius])
  useEffect(() => {
    if (glow.current) glow.current.threshold.value = threshold
  }, [threshold])

  // The frame callback subscribes before the pipeline is built, so until then it renders the scene as R3F would
  useFrame(({ gl, scene, camera }) => {
    if (pipeline.current) pipeline.current.render()
    else gl.render(scene, camera)
  }, renderPriority)

  return null
}
