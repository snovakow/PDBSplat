import assert from 'node:assert/strict'
import { test } from 'node:test'
import { percentile } from '../src/pdb/percentile.ts'

// Percentiles of sorted values

void test('no values give 0', () => {
  assert.equal(percentile(new Float64Array(0), 0.5), 0)
})

void test('one value is every percentile', () => {
  const one = Float64Array.of(7.5)
  assert.equal(percentile(one, 0), 7.5)
  assert.equal(percentile(one, 0.5), 7.5)
  assert.equal(percentile(one, 1), 7.5)
})

void test('a fraction that lands on a value gives it', () => {
  const values = Float64Array.of(1, 2, 3, 4, 5)
  assert.equal(percentile(values, 0), 1)
  assert.equal(percentile(values, 0.25), 2)
  assert.equal(percentile(values, 0.5), 3)
  assert.equal(percentile(values, 1), 5)
})

void test('a fraction between two values interpolates between them', () => {
  assert.equal(percentile(Float64Array.of(10, 20), 0.25), 12.5)
  assert.equal(percentile(Float64Array.of(1, 2, 4), 0.75), 3)
  assert.equal(percentile(Float64Array.of(0, 0, 0, 100), 0.75), 25)
})
