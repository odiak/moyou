// Save / load of Moyou pattern files: a PNG of the repeating unit (or, for
// random arrangements, a sample block that contains every variant) with
// pattern metadata in a tEXt chunk. If the metadata is stripped (e.g. by an
// image host), the image still works as a plain seamless tile — a random
// pattern degrades to the periodic repetition of its sample block.

import {
  Arrangement,
  Layout,
  layoutArrangement,
  layoutRotation,
  layoutVariantCount,
  PatternParams,
  randomCellAt,
  RandomArrangement,
  rotSource,
  SINGLE_LAYOUT
} from './engine'
import { encodePng, readTextChunks } from './png'

export const METADATA_KEYWORD = 'moyou'

export type LoadedPattern = {
  cellWidth: number
  cellHeight: number
  arrangement: Arrangement
  // variantCount * cellWidth * cellHeight * 4 bytes
  data: Uint8ClampedArray
  params: PatternParams | undefined
}

export const MAX_CELL_SIZE = 1024
export const MAX_IMAGE_SIZE = 4096

function paramsMeta(params: PatternParams) {
  return { shift: params.shift, flipX: params.flipX, flipY: params.flipY }
}

// Versions: 1 = single cell, 2 = variant grid, 3 = grid with rotations,
// 4 = random arrangement (image is a sample block, seed is the recipe)
export async function encodeLayoutPng(
  superData: Uint8ClampedArray,
  cellWidth: number,
  cellHeight: number,
  layout: Layout,
  params: PatternParams
): Promise<Uint8Array> {
  const hasRot = layout.rot !== undefined && layout.rot.some((r) => (r & 3) !== 0)
  const meta = {
    version: hasRot ? 3 : 2,
    w: cellWidth,
    h: cellHeight,
    ...paramsMeta(params),
    cols: layout.cols,
    rows: layout.rows,
    map: layout.map,
    ...(hasRot ? { rot: layout.rot!.map((r) => r & 3) } : {})
  }
  return encodePng(superData, layout.cols * cellWidth, layout.rows * cellHeight, {
    [METADATA_KEYWORD]: JSON.stringify(meta)
  })
}

export async function encodeRandomPng(
  blockData: Uint8ClampedArray,
  blockSize: number,
  cellWidth: number,
  cellHeight: number,
  arr: RandomArrangement,
  params: PatternParams
): Promise<Uint8Array> {
  const meta = {
    version: 4,
    w: cellWidth,
    h: cellHeight,
    ...paramsMeta(params),
    block: blockSize,
    seed: arr.seed,
    count: arr.count,
    rotate: arr.rotate
  }
  return encodePng(blockData, blockSize * cellWidth, blockSize * cellHeight, {
    [METADATA_KEYWORD]: JSON.stringify(meta)
  })
}

type ParsedMetadata = {
  w: number
  h: number
  arrangement: Arrangement
  // Grid dimensions of the stored image, and the variant/rotation at each
  // grid position (how to slice the image back into variant buffers)
  gridCols: number
  gridRows: number
  cellAt: (gx: number, gy: number) => { v: number; rot: number }
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
    const base = { w: m.w, h: m.h, params }
    if (m.version === 1) {
      return {
        ...base,
        arrangement: layoutArrangement(SINGLE_LAYOUT),
        gridCols: 1,
        gridRows: 1,
        cellAt: () => ({ v: 0, rot: 0 })
      }
    }
    if ((m.version === 2 || m.version === 3) && isValidLayout(m.cols, m.rows, m.map)) {
      const layout: Layout = { cols: m.cols as number, rows: m.rows as number, map: m.map }
      if (isValidRot(m.rot, layout.map.length)) layout.rot = m.rot
      return {
        ...base,
        arrangement: layoutArrangement(layout),
        gridCols: layout.cols,
        gridRows: layout.rows,
        cellAt: (gx, gy) => {
          const g = gy * layout.cols + gx
          return { v: layout.map[g], rot: layoutRotation(layout, g) }
        }
      }
    }
    if (m.version === 4) {
      const { block, seed, count } = m
      if (typeof block !== 'number' || !Number.isInteger(block) || block < 1 || block > 8) {
        return undefined
      }
      if (typeof seed !== 'number' || !Number.isInteger(seed)) return undefined
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 16) {
        return undefined
      }
      const arr: RandomArrangement = {
        kind: 'random',
        seed: seed >>> 0,
        count,
        rotate: m.rotate === true
      }
      return {
        ...base,
        arrangement: arr,
        gridCols: block,
        gridRows: block,
        cellAt: (gx, gy) => randomCellAt(arr, gx, gy)
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function arrangementVariantCount(arrangement: Arrangement): number {
  return arrangement.kind === 'layout' ? layoutVariantCount(arrangement.layout) : arrangement.count
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
    meta.gridCols * meta.w === width &&
    meta.gridRows * meta.h === height

  if (!structureValid) {
    if (width > MAX_CELL_SIZE || height > MAX_CELL_SIZE) {
      throw new Error(`画像が大きすぎます（最大 ${MAX_CELL_SIZE}×${MAX_CELL_SIZE} px）`)
    }
    return {
      cellWidth: width,
      cellHeight: height,
      arrangement: layoutArrangement(SINGLE_LAYOUT),
      data: new Uint8ClampedArray(image.data),
      params: undefined
    }
  }

  // Slice the stored image back into variant buffers (undoing each
  // position's rotation). Duplicate grid positions of the same variant just
  // overwrite each other (they are identical in files we wrote ourselves).
  const { w, h } = meta
  const data = new Uint8ClampedArray(arrangementVariantCount(meta.arrangement) * w * h * 4)
  const dataWords = new Uint32Array(data.buffer)
  const imageWords = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height)
  for (let gy = 0; gy < meta.gridRows; gy++) {
    for (let gx = 0; gx < meta.gridCols; gx++) {
      const { v, rot } = meta.cellAt(gx, gy)
      const base = v * w * h
      for (let dy = 0; dy < h; dy++) {
        const row = (gy * h + dy) * width + gx * w
        for (let dx = 0; dx < w; dx++) {
          dataWords[base + rotSource(dx, dy, w, rot)] = imageWords[row + dx]
        }
      }
    }
  }
  return { cellWidth: w, cellHeight: h, arrangement: meta.arrangement, data, params: meta.params }
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
