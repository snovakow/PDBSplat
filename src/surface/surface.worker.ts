import { meshSurface, type SurfaceInput } from './gaussianSurface.ts'

// Meshes one surface per message, and sends it back with its arrays transferred rather than copied
self.onmessage = (event: MessageEvent<SurfaceInput>) => {
  try {
    const start = performance.now()
    const mesh = meshSurface(event.data)
    const milliseconds = performance.now() - start
    const transfer = [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.owners.buffer]
    self.postMessage({ mesh, milliseconds }, { transfer })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
