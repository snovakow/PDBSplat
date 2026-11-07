import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Color, Vector4 } from 'three'
import type BloomNode from 'three/addons/tsl/display/BloomNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import type SSAONode from 'three/addons/tsl/display/SSAONode.js'
import { ssao } from 'three/addons/tsl/display/SSAONode.js'
import { getNormalFromDepth, mix, pass, sample, uniform, vec4 } from 'three/tsl'
import { RenderPipeline, type Node, type PassNode, type UniformNode } from 'three/webgpu'
import { useStore } from '../store.ts'
import { asWebGPU } from './renderer.ts'
import { isOpaque, isWeighted } from './styles.ts'
import { weightedBlend } from './weighted.ts'

// Above R3F's own render, which a frame callback at a higher priority takes over until it unmounts
const renderPriority = 1

// How strongly ambient occlusion darkens what it finds. three's own strength of 1 changes a whole protein by a few
// per cent, too little to see, so this was chosen by eye on the crambin and antibody examples: contacts between
// spheres and the surface's grooves read as shade, while open faces stay bright
const occlusionStrength = 3

// The pipeline and the pass that draws the scene into it, which last while the effects are mounted
interface Stage {
  pipeline: RenderPipeline
  scenePass: PassNode
}

// The scene drawn through a pipeline of passes, in place of R3F's own render: the weighted blend sums the splats into
// two targets and composites them, ambient occlusion darkens the scene's crevices while everything in it is opaque,
// and bloom spreads a glow around its bright parts. It renders only while it's mounted, so the scene renders directly
// whenever there's no effect to apply
export function Effects() {
  const get = useThree((s) => s.get)
  const weighted = useStore((s) => isWeighted(s.options))
  const bloomOn = useStore((s) => s.options.bloom > 0)
  const strength = useStore((s) => s.options.bloom)
  const radius = useStore((s) => s.options.bloomRadius)
  const threshold = useStore((s) => s.options.bloomThreshold)
  const aoOn = useStore((s) => s.options.ao > 0 && isOpaque(s.options))
  const ao = useStore((s) => s.options.ao)
  const aoRadius = useStore((s) => s.options.aoRadius)
  const stage = useRef<Stage | null>(null)
  const glow = useRef<BloomNode | null>(null)
  const occlusion = useRef<SSAONode | null>(null)
  const occlusionAmount = useRef<UniformNode<'float', number> | null>(null)

  useEffect(() => {
    const { gl, scene, camera } = get()
    const scenePass = pass(scene, camera)
    const pipeline = new RenderPipeline(asWebGPU(gl), scenePass.getTextureNode('output'))
    stage.current = { pipeline, scenePass }
    // The pipeline frees only its own quad, so the pass it runs is freed first
    return () => {
      stage.current = null
      scenePass.dispose()
      pipeline.dispose()
    }
  }, [get])

  // The effects that are on join the pipeline's output, and leave it as they turn off, each taking its passes with it
  useEffect(() => {
    if (!stage.current) return undefined
    const { pipeline, scenePass } = stage.current
    const { gl, scene, camera } = get()
    const { options } = useStore.getState()
    const made: Node[] = []
    let sceneColor: Node<'vec4'> = scenePass.getTextureNode('output')

    if (weighted) {
      // A pass of its own sums the splats into two targets, which the composite resolves, and the scene pass draws
      // nothing meanwhile. The targets take no multisampling, as the soft splats don't alias and the spheres' rims
      // are fades, and the renderer's half-float output type, which holds the sums without clipping. The composite
      // lays the sum over the renderer's clear colour, which the sorted blend lays its splats over, taken as it is
      // when the blend turns on
      const renderer = asWebGPU(gl)
      const sumPass = pass(scene, camera, { samples: 0 })
      const clear = renderer.getClearColor(new Color())
      const background = uniform(new Vector4(clear.r, clear.g, clear.b, renderer.getClearAlpha()))
      const { targets, composite } = weightedBlend(sumPass, background)
      sceneColor = composite
      made.push(sumPass, background, targets, composite)
    }

    let output: Node<'vec4'> = sceneColor

    if (aoOn) {
      // A second pass draws only what's opaque, without multisampling, for a depth that can be read pixel by pixel.
      // The splats carry no normals, so the occlusion's normals are rebuilt from that depth. The camera's inverse
      // projection goes in as a uniform, which follows it as the window resizes or Clip moves the near plane
      const depthPass = pass(scene, camera, { samples: 0 })
      depthPass.transparent = false
      const depth = depthPass.getTextureNode('depth')
      const projectionInverse = uniform(camera.projectionMatrixInverse)
      const normals = sample((uv) => getNormalFromDepth(uv, depth, projectionInverse))
      // Its reach is in the scene's units, ångströms
      const aoNode = ssao(depth, normals, camera)
      aoNode.radius.value = options.aoRadius
      aoNode.intensity.value = occlusionStrength
      const amount = uniform(options.ao)
      output = vec4(sceneColor.rgb.mul(mix(1, aoNode.r, amount)), sceneColor.a)
      occlusion.current = aoNode
      occlusionAmount.current = amount
      made.push(depthPass, projectionInverse, normals, aoNode, amount)
    }

    if (bloomOn) {
      // Bloom's settings are uniforms, which the effects below set without building the pipeline again
      const bloomNode = bloom(sceneColor, options.bloom, options.bloomRadius, options.bloomThreshold)
      output = output.add(bloomNode)
      glow.current = bloomNode
      made.push(bloomNode)
    }

    pipeline.outputNode = output
    pipeline.needsUpdate = true
    return () => {
      glow.current = null
      occlusion.current = null
      occlusionAmount.current = null
      for (const node of made) node.dispose()
    }
  }, [get, weighted, aoOn, bloomOn])

  useEffect(() => {
    if (glow.current) glow.current.strength.value = strength
  }, [strength])
  useEffect(() => {
    if (glow.current) glow.current.radius.value = radius
  }, [radius])
  useEffect(() => {
    if (glow.current) glow.current.threshold.value = threshold
  }, [threshold])
  useEffect(() => {
    if (occlusionAmount.current) occlusionAmount.current.value = ao
  }, [ao])
  useEffect(() => {
    if (occlusion.current) occlusion.current.radius.value = aoRadius
  }, [aoRadius])

  // The frame callback subscribes before the pipeline is built, so until then it renders the scene as R3F would
  useFrame(({ gl, scene, camera }) => {
    if (stage.current) stage.current.pipeline.render()
    else gl.render(scene, camera)
  }, renderPriority)

  return null
}
