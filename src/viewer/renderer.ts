import { WebGPURenderer } from 'three/webgpu'

// R3F types its renderer as a WebGLRenderer, though the Canvas's factory always makes a WebGPURenderer
export function asWebGPU(renderer: unknown): WebGPURenderer {
  if (!(renderer instanceof WebGPURenderer)) throw new Error('Expected a WebGPURenderer')
  return renderer
}
