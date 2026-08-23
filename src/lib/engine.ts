// Moyou's drawing engine: one or more square cell buffers (variants) tiled
// on the infinite plane via a torus wrap mapping from world coordinates.
// Variants are arranged in a "super cell" grid (e.g. checkerboard) which is
// what actually repeats. Brush mask, stroke stamping and packing helpers are
// adapted from kakeru's packages/paint-core/src/engine.ts, with the tile
// system removed.

export const MAX_BRUSH_SIZE = 64

export type PatternParams = {
  // Horizontal shift in pixels applied per vertical repeat of the super
  // cell (brick / half-drop patterns)
  shift: number
  // Mirror every other column / row of super cells
  flipX: boolean
  flipY: boolean
}

// Arrangement of cell variants inside the super cell: map[gy * cols + gx]
// is the variant index shown at that grid position, rot (optional) its
// clockwise rotation in quarter turns (0-3).
export type Layout = { cols: number; rows: number; map: number[]; rot?: number[] }

export const SINGLE_LAYOUT: Layout = { cols: 1, rows: 1, map: [0] }

export function layoutVariantCount(layout: Layout): number {
  return Math.max(...layout.map) + 1
}

export function layoutRotation(layout: Layout, index: number): number {
  return layout.rot !== undefined ? layout.rot[index] & 3 : 0
}

function rotKey(layout: Layout): string {
  return layout.rot !== undefined && layout.rot.some((r) => (r & 3) !== 0)
    ? layout.rot.map((r) => r & 3).join(',')
    : ''
}

export function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.map.join(',') === b.map.join(',') &&
    rotKey(a) === rotKey(b)
  )
}

// How variants are placed on the plane: either a repeating layout grid, or
// a non-periodic random assignment where the cell at grid coordinate (i, k)
// is a pure function of (seed, i, k) — reproducible from the seed alone.
export type LayoutArrangement = { kind: 'layout'; layout: Layout }
export type RandomArrangement = { kind: 'random'; seed: number; count: number; rotate: boolean }
export type Arrangement = LayoutArrangement | RandomArrangement

export function layoutArrangement(layout: Layout): Arrangement {
  return { kind: 'layout', layout }
}

export function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  if (a.kind === 'layout' && b.kind === 'layout') return sameLayout(a.layout, b.layout)
  if (a.kind === 'random' && b.kind === 'random') {
    return a.seed === b.seed && a.count === b.count && a.rotate === b.rotate
  }
  return false
}

// 32-bit avalanche hash of (seed, x, y). A plain additive seed (s + x + C*y)
// would collide along a diagonal and create a hidden period; full mixing
// makes neighboring cells independent.
export function hash2d(seed: number, x: number, y: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x27d4eb2f) >>> 0
  return (h ^ (h >>> 15)) >>> 0
}

// The variant and rotation shown at cell (i, k) of a random arrangement
export function randomCellAt(
  arr: RandomArrangement,
  i: number,
  k: number
): { v: number; rot: number } {
  const h = hash2d(arr.seed, i, k)
  return { v: h % arr.count, rot: arr.rotate ? (h >>> 10) & 3 : 0 }
}

// Smallest n (up to max) such that the n×n block of cells starting at the
// origin contains every variant, or undefined if none does. Used to pick an
// exportable sample block (and to reject seeds that have none).
export function randomBlockSize(arr: RandomArrangement, max = 8): number | undefined {
  const seen = new Set<number>()
  for (let n = 1; n <= max; n++) {
    // Cells added by growing the block from (n-1)² to n²
    for (let i = 0; i < n; i++) {
      seen.add(randomCellAt(arr, i, n - 1).v)
      seen.add(randomCellAt(arr, n - 1, i).v)
    }
    if (seen.size >= arr.count && n * n >= arr.count) return n
  }
  return undefined
}

// Flat pixel index (sy * n + sx) of the source pixel that is shown at
// (dx, dy) when a square n×n cell is drawn rotated by rot quarter turns
// clockwise.
export function rotSource(dx: number, dy: number, n: number, rot: number): number {
  switch (rot & 3) {
    case 1:
      return (n - 1 - dx) * n + dy
    case 2:
      return (n - 1 - dy) * n + (n - 1 - dx)
    case 3:
      return dx * n + (n - 1 - dy)
    default:
      return dy * n + dx
  }
}

export type LayoutTemplate = { id: string; label: string; layout: Layout }

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { id: 'single', label: '単一', layout: SINGLE_LAYOUT },
  { id: 'cols2', label: '横2種', layout: { cols: 2, rows: 1, map: [0, 1] } },
  { id: 'rows2', label: '縦2種', layout: { cols: 1, rows: 2, map: [0, 1] } },
  { id: 'checker', label: '市松（2種）', layout: { cols: 2, rows: 2, map: [0, 1, 1, 0] } },
  { id: 'quad', label: '田の字（4種）', layout: { cols: 2, rows: 2, map: [0, 1, 2, 3] } },
  { id: 'cols4', label: '横4種', layout: { cols: 4, rows: 1, map: [0, 1, 2, 3] } }
]

const brushMaskCache = new Map<number, Int32Array>()

// Disc-shaped brush mask as [dx0, dy0, dx1, dy1, ...] offsets
function getBrushMask(size: number): Int32Array {
  const cached = brushMaskCache.get(size)
  if (cached !== undefined) return cached

  const offsets: number[] = []
  const c = (size - 1) / 2
  const r = size / 2
  const anchor = size >> 1
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i - c
      const dy = j - c
      if (dx * dx + dy * dy <= r * r) {
        offsets.push(i - anchor, j - anchor)
      }
    }
  }
  const mask = new Int32Array(offsets)
  brushMaskCache.set(size, mask)
  return mask
}

// Endian-safe packing of RGBA bytes into a uint32 for fast equality checks
const packScratch = new Uint8Array(4)
const packScratchView = new Uint32Array(packScratch.buffer)

export function packRgba(r: number, g: number, b: number, a: number): number {
  packScratch[0] = r
  packScratch[1] = g
  packScratch[2] = b
  packScratch[3] = a
  return packScratchView[0]
}

export function packColor(color: number): number {
  return packRgba((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff, 255)
}

export function unpackColor(packed: number): { color: number; alpha: number } {
  packScratchView[0] = packed
  return {
    color: (packScratch[0] << 16) | (packScratch[1] << 8) | packScratch[2],
    alpha: packScratch[3]
  }
}

export const TRANSPARENT = 0

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b)
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b
}

export class PatternEngine {
  readonly width: number // per-cell size
  readonly height: number
  readonly arrangement: Arrangement
  readonly variantCount: number
  // All variants in one buffer, stacked vertically: variant v occupies
  // bytes [v * width * height * 4, (v + 1) * width * height * 4)
  readonly data: Uint8ClampedArray
  readonly words: Uint32Array
  params: PatternParams = { shift: 0, flipX: false, flipY: false }
  // Incremented on every mutation; used by the renderer to know when to
  // re-upload the cells to their canvases
  revision = 0

  constructor(width: number, height: number, arrangement: Arrangement, data?: Uint8ClampedArray) {
    this.width = width
    this.height = height
    this.arrangement = arrangement
    this.variantCount =
      arrangement.kind === 'layout' ? layoutVariantCount(arrangement.layout) : arrangement.count
    const length = this.variantCount * width * height * 4
    if (data !== undefined) {
      if (data.length !== length) throw new Error('PatternEngine: invalid data length')
      this.data = data
    } else {
      this.data = new Uint8ClampedArray(length)
    }
    this.words = new Uint32Array(this.data.buffer, this.data.byteOffset, length / 4)
  }

  // The repeating unit; for random arrangements nothing repeats, so shift,
  // flips, view fitting etc. operate on single cells
  get superWidth(): number {
    return this.arrangement.kind === 'layout'
      ? this.arrangement.layout.cols * this.width
      : this.width
  }

  get superHeight(): number {
    return this.arrangement.kind === 'layout'
      ? this.arrangement.layout.rows * this.height
      : this.height
  }

  // The pixel data of one variant (a view into the shared buffer)
  cellData(variant: number): Uint8ClampedArray {
    const size = this.width * this.height * 4
    return this.data.subarray(variant * size, (variant + 1) * size)
  }

  // World coordinates → flat pixel index (variant * w * h + pixel).
  // Torus wrap of the super cell with shift and alternating mirror, then
  // the arrangement picks the variant and its rotation. For random
  // arrangements the (i, k) cell coordinate itself selects them via the
  // seed hash, so nothing ever repeats.
  mapPoint(wx: number, wy: number): number {
    const { width: w, height: h, arrangement } = this
    const W = this.superWidth
    const H = this.superHeight
    const { shift, flipX, flipY } = this.params
    const k = floorDiv(wy, H)
    let yy = wy - k * H
    const xs = wx - k * shift
    const i = floorDiv(xs, W)
    let xx = xs - i * W
    if (flipX && mod(i, 2) === 1) xx = W - 1 - xx
    if (flipY && mod(k, 2) === 1) yy = H - 1 - yy
    if (arrangement.kind === 'random') {
      const { v, rot } = randomCellAt(arrangement, i, k)
      return v * w * h + rotSource(xx, yy, w, rot)
    }
    const layout = arrangement.layout
    const gx = (xx / w) | 0
    const gy = (yy / h) | 0
    const g = gy * layout.cols + gx
    const v = layout.map[g]
    return v * w * h + rotSource(xx - gx * w, yy - gy * h, w, layoutRotation(layout, g))
  }

  variantOfIndex(index: number): number {
    return (index / (this.width * this.height)) | 0
  }

  readWorldPixel(wx: number, wy: number): number {
    return this.words[this.mapPoint(wx, wy)]
  }

  private writeWorldPixel(wx: number, wy: number, packed: number): void {
    this.words[this.mapPoint(wx, wy)] = packed
  }

  fillAll(packed: number): void {
    this.words.fill(packed)
    this.revision++
  }

  // Stamps a disc brush along the polyline given in world coordinates
  // (flattened [x0, y0, x1, y1, ...]).
  stroke(points: number[], size: number, packed: number): void {
    if (points.length < 2) return
    const mask = getBrushMask(size)

    const stamp = (x: number, y: number) => {
      for (let i = 0; i < mask.length; i += 2) {
        this.writeWorldPixel(x + mask[i], y + mask[i + 1], packed)
      }
    }

    let px = points[0]
    let py = points[1]
    stamp(px, py)

    for (let i = 2; i + 1 < points.length; i += 2) {
      const qx = points[i]
      const qy = points[i + 1]
      // Bresenham line from (px, py) to (qx, qy), stamping at every pixel
      let x = px
      let y = py
      const dx = Math.abs(qx - px)
      const dy = -Math.abs(qy - py)
      const sx = px < qx ? 1 : -1
      const sy = py < qy ? 1 : -1
      let err = dx + dy
      for (;;) {
        if (x !== px || y !== py) stamp(x, y)
        if (x === qx && y === qy) break
        const e2 = 2 * err
        if (e2 >= dy) {
          err += dy
          x += sx
        }
        if (e2 <= dx) {
          err += dx
          y += sy
        }
      }
      px = qx
      py = qy
    }
    this.revision++
  }

  // Flood fill seeded at a world coordinate. The flood walks in world space
  // so that adjacency across cell seams (including shift, mirror and the
  // variant grid) is exactly what the user sees; visited tracking is per
  // cell pixel, so it always terminates.
  fillAtWorld(wx: number, wy: number, packed: number): void {
    const target = this.words[this.mapPoint(wx, wy)]
    if (target === packed) return

    const visited = new Uint8Array(this.words.length)
    const stack: number[] = [wx, wy]
    while (stack.length > 0) {
      const y = stack.pop()!
      const x = stack.pop()!
      const index = this.mapPoint(x, y)
      if (visited[index]) continue
      visited[index] = 1
      if (this.words[index] !== target) continue
      this.words[index] = packed
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1)
    }
    this.revision++
  }

  // Composes the full super cell (what actually repeats) as RGBA pixels;
  // used for PNG export.
  composeSuperData(): Uint8ClampedArray {
    if (this.arrangement.kind !== 'layout') throw new Error('composeSuperData: not a layout')
    const { width: w, height: h } = this
    const layout = this.arrangement.layout
    const W = this.superWidth
    const out = new Uint8ClampedArray(W * this.superHeight * 4)
    const outWords = new Uint32Array(out.buffer)
    for (let j = 0; j < layout.map.length; j++) {
      const gx = j % layout.cols
      const gy = (j / layout.cols) | 0
      const base = layout.map[j] * w * h
      const rot = layoutRotation(layout, j)
      for (let dy = 0; dy < h; dy++) {
        const row = (gy * h + dy) * W + gx * w
        for (let dx = 0; dx < w; dx++) {
          outWords[row + dx] = this.words[base + rotSource(dx, dy, w, rot)]
        }
      }
    }
    return out
  }

  // Composes the n×n sample block of a random arrangement starting at cell
  // (0, 0), exactly as displayed there (rotations applied). Together with
  // the seed this makes the export both a usable tile and a full recipe.
  composeRandomBlock(): { size: number; data: Uint8ClampedArray } {
    if (this.arrangement.kind !== 'random') throw new Error('composeRandomBlock: not random')
    const size = randomBlockSize(this.arrangement)
    if (size === undefined) throw new Error('composeRandomBlock: block misses variants')
    const { width: w, height: h } = this
    const W = size * w
    const out = new Uint8ClampedArray(W * size * h * 4)
    const outWords = new Uint32Array(out.buffer)
    for (let gy = 0; gy < size; gy++) {
      for (let gx = 0; gx < size; gx++) {
        const { v, rot } = randomCellAt(this.arrangement, gx, gy)
        const base = v * w * h
        for (let dy = 0; dy < h; dy++) {
          const row = (gy * h + dy) * W + gx * w
          for (let dx = 0; dx < w; dx++) {
            outWords[row + dx] = this.words[base + rotSource(dx, dy, w, rot)]
          }
        }
      }
    }
    return { size, data: out }
  }

  snapshot(): Uint8ClampedArray {
    return new Uint8ClampedArray(this.data)
  }

  restore(snapshot: Uint8ClampedArray): void {
    this.data.set(snapshot)
    this.revision++
  }
}
