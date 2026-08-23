// Save / load of Moyou pattern files: a square cell PNG with pattern
// metadata stored in a tEXt chunk. If the metadata is stripped (e.g. by an
// image host), the image still loads as a plain cell and only the pattern
// parameters are lost.

import { PatternParams } from './engine'
import { encodePng, readTextChunks } from './png'

export const METADATA_KEYWORD = 'moyou'

export type MoyouMetadata = {
  version: 1
  w: number
  h: number
  shift: number
  flipX: boolean
  flipY: boolean
}

export type LoadedPattern = {
  width: number
  height: number
  data: Uint8ClampedArray
  params: PatternParams | undefined
}

export const MAX_CELL_SIZE = 1024

export async function encodePatternPng(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  params: PatternParams
): Promise<Uint8Array> {
  const meta: MoyouMetadata = {
    version: 1,
    w: width,
    h: height,
    shift: params.shift,
    flipX: params.flipX,
    flipY: params.flipY
  }
  return encodePng(data, width, height, { [METADATA_KEYWORD]: JSON.stringify(meta) })
}

function parseMetadata(text: string | undefined): MoyouMetadata | undefined {
  if (text === undefined) return undefined
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return undefined
    const m = raw as Record<string, unknown>
    if (m.version !== 1) return undefined
    if (typeof m.w !== 'number' || typeof m.h !== 'number') return undefined
    return {
      version: 1,
      w: m.w,
      h: m.h,
      shift: typeof m.shift === 'number' ? m.shift : 0,
      flipX: m.flipX === true,
      flipY: m.flipY === true
    }
  } catch {
    return undefined
  }
}

// Decodes any browser-supported image file. PNG metadata is parsed from the
// raw bytes; pixels are decoded by the browser so re-saved / foreign PNGs
// load too.
export async function decodePatternFile(file: Blob): Promise<LoadedPattern> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const meta = parseMetadata(readTextChunks(bytes)[METADATA_KEYWORD])

  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  if (width > MAX_CELL_SIZE || height > MAX_CELL_SIZE) {
    bitmap.close()
    throw new Error(`画像が大きすぎます（最大 ${MAX_CELL_SIZE}×${MAX_CELL_SIZE} px）`)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const imageData = ctx.getImageData(0, 0, width, height)

  const params: PatternParams | undefined =
    meta !== undefined && meta.w === width && meta.h === height
      ? { shift: meta.shift, flipX: meta.flipX, flipY: meta.flipY }
      : undefined

  return { width, height, data: new Uint8ClampedArray(imageData.data), params }
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
