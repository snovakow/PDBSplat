// Percentiles of a set of values, which the colourings spread across

// Interpolates between the two nearest of the sorted values, or gives 0 for none
export function percentile(sorted: Float64Array, fraction: number) {
  if (sorted.length === 0) return 0
  const place = fraction * (sorted.length - 1)
  const below = Math.floor(place)
  const above = Math.min(below + 1, sorted.length - 1)
  return sorted[below] + (sorted[above] - sorted[below]) * (place - below)
}
