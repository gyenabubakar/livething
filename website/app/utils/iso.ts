/**
 * Isometric projection for the landing illustrations. World space has x going
 * down-right, y going down-left and z going up; the result is SVG pixels around
 * an origin.
 */
const COS = Math.cos(Math.PI / 6)
const SIN = 0.5

export interface IsoOrigin { ox: number, oy: number }

export function iso(origin: IsoOrigin, x: number, y: number, z = 0): [number, number] {
  return [origin.ox + (x - y) * COS, origin.oy + (x + y) * SIN - z]
}

function points(list: [number, number][]): string {
  return list.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
}

/** The three visible faces of a box: top, front-left (the +y side) and front-right (the +x side). */
export function isoBox(origin: IsoOrigin, x: number, y: number, z: number, w: number, d: number, h: number) {
  const p = (px: number, py: number, pz: number) => iso(origin, px, py, pz)
  return {
    top: points([p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)]),
    left: points([p(x, y + d, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x, y + d, z)]),
    right: points([p(x + w, y, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x + w, y, z)]),
  }
}

/** An SVG `matrix()` that lays flat content onto the top face of a box, with (0,0) at world (x, y, z). */
export function isoTopMatrix(origin: IsoOrigin, x: number, y: number, z: number): string {
  const [tx, ty] = iso(origin, x, y, z)
  return `matrix(${COS} ${SIN} ${-COS} ${SIN} ${tx} ${ty})`
}
