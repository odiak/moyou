// Save / load of Moyou pattern files: the super cell (the arrangement of
// cell variants that actually repeats) as a PNG with pattern metadata in a
// tEXt chunk. If the metadata is stripped (e.g. by an image host), the
// image still loads as a plain single cell and only the pattern structure
// is lost.

import {
  Layout,
  layoutRotation,
  layoutVariantCount,
  PatternParams,
  rotSource,
  SINGLE_LAYOUT
} from './engine'
import { encodePng, readTextChunks } from './png'

export const METADATA_KEYWORD = 'moyou'

export type MoyouMetadata = {
  // 2 = variant grid, 3 = adds per-position rotations
  version: 2 | 3
  // Per-cell size; the image itself is (cols * w) × (rows * h)
  w: number
  h: number
  shift: number
  flipX: boolean
  flipY: boolean
  cols: number
  rows: number
  map: number[]
  rot?: number[]
}

export type LoadedPattern = {
  cellWidth: number
  cellHeight: number
  layout: Layout
  // variantCount * cellWidth * cellHeight * 4 bytes
  data: Uint8ClampedArray
  params: PatternParams | undefined
}

export const MAX_CELL_SIZE = 1024
export const MAX_IMAGE_SIZE = 4096

export async function encodePatternPng(
  superData: Uint8ClampedArray,
  cellWidth: number,
  cellHeight: number,
  layout: Layout,
  params: PatternParams
): Promise<Uint8Array> {
  const hasRot = layout.rot !== undefined && layout.rot.some((r) => (r & 3) !== 0)
  const meta: MoyouMetadata = {
    version: hasRot ? 3 : 2,
    w: cellWidth,
    h: cellHeight,
    shift: params.shift,
    flipX: params.flipX,
    flipY: params.flipY,
    cols: layout.cols,
    rows: layout.rows,
    map: layout.map,
    ...(hasRot ? { rot: layout.rot!.map((r) => r & 3) } : {})
  }
  return encodePng(superData, layout.cols * cellWidth, layout.rows * cellHeight, {
    [METADATA_KEYWORD]: JSON.stringify(meta)
  })
}

type ParsedMetadata = {
  w: number
  h: number
  layout: Layout
  params: PatternParams
}

function isValidLayout(cols: unknown, rows: unknown, map: unknown): map is number[] {
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || cols > 8) return false
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 8) return false
  if (!Array.isArray(map) || map.length !== cols * rows) return false
  return map.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 16)
}

function isValidRot(rot: unknown, length: number): rot is number[] {
  return (
    Array.isArray(rot) &&
    rot.length === length &&
    rot.every((r) => typeof r === 'number' && Number.isInteger(r) && r >= 0 && r < 4)
  )
}

function parseMetadata(text: string | undefined): ParsedMetadata | undefined {
  if (text === undefined) return undefined
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return undefined
    const m = raw as Record<string, unknown>
    if (typeof m.w !== 'number' || typeof m.h !== 'number') return undefined
    const params: PatternParams = {
      shift: typeof m.shift === 'number' ? m.shift : 0,
      flipX: m.flipX === true,
      flipY: m.flipY === true
    }
    if (m.version === 1) {
      return { w: m.w, h: m.h, layout: SINGLE_LAYOUT, params }
    }
    if ((m.version === 2 || m.version === 3) && isValidLayout(m.cols, m.rows, m.map)) {
      const layout: Layout = { cols: m.cols as number, rows: m.rows as number, map: m.map }
      if (isValidRot(m.rot, layout.map.length)) layout.rot = m.rot
      return { w: m.w, h: m.h, layout, params }
    }
    return undefined
  } catch {
    return undefined
  }
}

// Decodes any browser-supported image file. PNG metadata is parsed from the
// raw bytes; pixels are decoded by the browser so re-saved / foreign PNGs
// load too (as a plain single cell).
export async function decodePatternFile(file: Blob): Promise<LoadedPattern> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const meta = parseMetadata(readTextChunks(bytes)[METADATA_KEYWORD])

  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  if (width > MAX_IMAGE_SIZE || height > MAX_IMAGE_SIZE) {
    bitmap.close()
    throw new Error(`画像が大きすぎます（最大 ${MAX_IMAGE_SIZE}×${MAX_IMAGE_SIZE} px）`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const image = ctx.getImageData(0, 0, width, height)

  const structureValid =
    meta !== undefined &&
    meta.w <= MAX_CELL_SIZE &&
    meta.h <= MAX_CELL_SIZE &&
    meta.layout.cols * meta.w === width &&
    meta.layout.rows * meta.h === height

  if (!structureValid) {
    if (width > MAX_CELL_SIZE || height > MAX_CELL_SIZE) {
      throw new Error(`画像が大きすぎます（最大 ${MAX_CELL_SIZE}×${MAX_CELL_SIZE} px）`)
    }
    return {
      cellWidth: width,
      cellHeight: height,
      layout: SINGLE_LAYOUT,
      data: new Uint8ClampedArray(image.data),
      params: undefined
    }
  }

  // Slice the super cell image back into variant buffers (undoing each
  // position's rotation). Duplicate grid positions of the same variant just
  // overwrite each other (they are identical in files we wrote ourselves).
  const { w, h, layout } = meta
  const data = new Uint8ClampedArray(layoutVariantCount(layout) * w * h * 4)
  const dataWords = new Uint32Array(data.buffer)
  const imageWords = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height)
  for (let j = 0; j < layout.map.length; j++) {
    const gx = j % layout.cols
    const gy = (j / layout.cols) | 0
    const base = layout.map[j] * w * h
    const rot = layoutRotation(layout, j)
    for (let dy = 0; dy < h; dy++) {
      const row = (gy * h + dy) * width + gx * w
      for (let dx = 0; dx < w; dx++) {
        dataWords[base + rotSource(dx, dy, w, rot)] = imageWords[row + dx]
      }
    }
  }
  return { cellWidth: w, cellHeight: h, layout, data, params: meta.params }
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
