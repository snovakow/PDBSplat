import { meshSurface, packField, sampleField } from './gaussianSurface.ts'
import type { SurfaceReply, SurfaceRequest } from './surfaceWorker.ts'

// Answers one request per message, meshing the surface or sampling and packing the field, and sends the result back
// with its arrays transferred rather than copied
self.onmessage = (event: MessageEvent<SurfaceRequest>) => {
  try {
    const { reply, transfer } = answer(event.data)
    self.postMessage(reply, { transfer })
  } catch (error) {
    const reply: SurfaceReply = { error: error instanceof Error ? error.message : String(error) }
    self.postMessage(reply)
  }
}

function answer(request: SurfaceRequest): { reply: SurfaceReply; transfer: ArrayBuffer[] } {
  const start = performance.now()
  if (request.kind === 'mesh') {
    const mesh = meshSurface(request.input)
    const milliseconds = performance.now() - start
    const transfer = [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.owners.buffer]
    return { reply: { kind: 'mesh', mesh, milliseconds }, transfer }
  }
  const field = packField(sampleField(request.input))
  const milliseconds = performance.now() - start
  return { reply: { kind: 'field', field, milliseconds }, transfer: [field.density.buffer, field.owners.buffer] }
}
