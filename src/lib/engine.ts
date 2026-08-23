// Moyou's drawing engine: a single square cell buffer with a torus wrap
// mapping from world coordinates to cell coordinates. Brush mask, stroke
// stamping and packing helpers are adapted from kakeru's
// packages/paint-core/src/engine.ts, with the tile system removed.

export const MAX_BRUSH_SIZE = 64

export type PatternParams = {
  // Horizontal shift in cell pixels applied per vertical repeat (brick /
  // half-drop patterns)
  shift: number
  // Mirror every other column / row of cells
  flipX: boolean
  flipY: boolean
}

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

export class CellEngine {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
  readonly words: Uint32Array
  params: PatternParams = { shift: 0, flipX: false, flipY: false }
  // Incremented on every mutation; used by the renderer to know when to
  // re-upload the cell to its canvas
  revision = 0

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = width
    this.height = height
    if (data !== undefined) {
      if (data.length !== width * height * 4) throw new Error('CellEngine: invalid data length')
      this.data = data
    } else {
      this.data = new Uint8ClampedArray(width * height * 4)
    }
    this.words = new Uint32Array(this.data.buffer, this.data.byteOffset, width * height)
  }

  // World coordinates → cell coordinates (torus wrap with shift and
  // alternating mirror)
  mapPoint(wx: number, wy: number): [number, number] {
    const { width: w, height: h } = this
    const { shift, flipX, flipY } = this.params
    const k = floorDiv(wy, h)
    let cy = wy - k * h
    const xs = wx - k * shift
    const i = floorDiv(xs, w)
    let cx = xs - i * w
    if (flipX && mod(i, 2) === 1) cx = w - 1 - cx
    if (flipY && mod(k, 2) === 1) cy = h - 1 - cy
    return [cx, cy]
  }

  readWorldPixel(wx: number, wy: number): number {
    const [cx, cy] = this.mapPoint(wx, wy)
    return this.words[cy * this.width + cx]
  }

  private writeWorldPixel(wx: number, wy: number, packed: number): void {
    const [cx, cy] = this.mapPoint(wx, wy)
    this.words[cy * this.width + cx] = packed
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
  // so that adjacency across cell seams (including shift and mirror) is
  // exactly what the user sees; visited tracking is per cell pixel, so it
  // always terminates (the cell is finite).
  fillAtWorld(wx: number, wy: number, packed: number): void {
    const { width: w, height: h } = this
    const [sx, sy] = this.mapPoint(wx, wy)
    const target = this.words[sy * w + sx]
    if (target === packed) return

    const visited = new Uint8Array(w * h)
    const stack: number[] = [wx, wy]
    while (stack.length > 0) {
      const y = stack.pop()!
      const x = stack.pop()!
      const [cx, cy] = this.mapPoint(x, y)
      const idx = cy * w + cx
      if (visited[idx]) continue
      if (this.words[idx] !== target) continue
      visited[idx] = 1
      this.words[idx] = packed
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1)
    }
    this.revision++
  }

  snapshot(): Uint8ClampedArray {
    return new Uint8ClampedArray(this.data)
  }

  restore(snapshot: Uint8ClampedArray): void {
    this.data.set(snapshot)
    this.revision++
  }
}
