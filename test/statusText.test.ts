import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusText } from '../src/statusText.ts'

// What the panel's Status reads through a load: the compressed bytes received of the total and the atoms read, then
// whether the entry's burial has landed, or why the load failed

const burial = { values: new Float32Array(0), low: 0, high: 1 }
const loading = { status: 'loading', error: null, burial: null } as const

void test('a load reads its bytes of the whole, in one unit for both, and the atoms read once there are any', () => {
  assert.equal(statusText({ ...loading, progress: null }), 'Loading…')
  assert.equal(statusText({ ...loading, progress: { received: 12_000, total: 17_580, atoms: 0 } }), '12 of 18 kB')
  assert.equal(
    statusText({ ...loading, progress: { received: 41_234_567, total: 250_419_102, atoms: 1_234_567 } }),
    '41.2 of 250.4 MB, 1,234,567 atoms',
  )
  // The plain file comes without its compressed size, so its progress is by atoms alone
  assert.equal(statusText({ ...loading, progress: { received: 5, total: null, atoms: 327 } }), 'Loading, 327 atoms')
})

void test('a ready entry reads whether its burial is still to come, and a failed load its message', () => {
  assert.equal(statusText({ status: 'ready', error: null, progress: null, burial: null }), 'Ready, burial to come')
  assert.equal(statusText({ status: 'ready', error: null, progress: null, burial }), 'Ready')
  const error = "There's no entry 9ZZZ in the PDB"
  assert.equal(statusText({ status: 'failed', error, progress: null, burial }), error)
  assert.equal(statusText({ status: 'idle', error: null, progress: null, burial: null }), '')
})
