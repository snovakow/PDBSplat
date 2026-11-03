import { Color } from 'three'

// Each element's CPK colour, as Jmol colours it (jmol.sourceforge.net/jscolors), and its van der Waals radius in
// ångströms. The radii are Bondi's (J. Phys. Chem. 1964, 68, 441) unless a comment names another source
const elements: Record<string, { color: number; radius: number }> = {
  H: { color: 0xffffff, radius: 1.2 },
  // Deuterium, which neutron structures carry in place of hydrogen; Jmol gives it its own colour
  D: { color: 0xffffc0, radius: 1.2 },
  C: { color: 0x909090, radius: 1.7 },
  N: { color: 0x3050f8, radius: 1.55 },
  O: { color: 0xff0d0d, radius: 1.52 },
  F: { color: 0x90e050, radius: 1.47 },
  Na: { color: 0xab5cf2, radius: 2.27 },
  Mg: { color: 0x8aff00, radius: 1.73 },
  P: { color: 0xff8000, radius: 1.8 },
  S: { color: 0xffff30, radius: 1.8 },
  Cl: { color: 0x1ff01f, radius: 1.75 },
  K: { color: 0x8f40d4, radius: 2.75 },
  // Bondi has no calcium; Mantina et al., J. Phys. Chem. A 2009, 113, 5806
  Ca: { color: 0x3dff00, radius: 2.31 },
  // Bondi has no iron; Alvarez, Dalton Trans. 2013, 42, 8617
  Fe: { color: 0xe06633, radius: 2.44 },
  Ni: { color: 0x50d050, radius: 1.63 },
  Cu: { color: 0xc88033, radius: 1.4 },
  Zn: { color: 0x7d80b0, radius: 1.39 },
  Se: { color: 0xffa100, radius: 1.9 },
  Br: { color: 0xa62929, radius: 1.85 },
  I: { color: 0x940094, radius: 1.98 },
}

// Jmol's colour for an unknown element, and a radius between the listed ones' for the rest
const fallback = { color: 0xff1493, radius: 2 }

// The colours as three reads them: hex is sRGB, which Color converts to the renderer's linear working space
const colors = new Map(Object.entries(elements).map(([symbol, { color }]) => [symbol, new Color(color)]))
const fallbackColor = new Color(fallback.color)

export function elementColor(symbol: string): Color {
  return colors.get(symbol) ?? fallbackColor
}

export function vdwRadius(symbol: string): number {
  return elements[symbol]?.radius ?? fallback.radius
}
