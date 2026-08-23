// Minimal PNG encoder for RGBA8 images, using CompressionStream.
// Adapted from kakeru's packages/paint-core/src/png.ts, with tEXt chunk
// support added for Moyou metadata. Decoding of arbitrary PNGs is done via
// the browser (createImageBitmap) elsewhere; this module only needs to
// extract text chunks from raw bytes.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

let crcTable: Uint32Array | undefined

function getCrcTable(): Uint32Array {
  if (crcTable !== undefined) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function deflate(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  void writer.write(input)
  void writer.close()

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

// keyword must be Latin-1; text must be ASCII-safe (we only store JSON)
function makeTextChunk(keyword: string, text: string): Uint8Array {
  const data = new Uint8Array(keyword.length + 1 + text.length)
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i) & 0xff
  data[keyword.length] = 0
  for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff
  return data
}

export async function encodePng(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  texts: Record<string, string> = {}
): Promise<Uint8Array> {
  if (data.length !== width * height * 4) throw new Error('encodePng: invalid data length')

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // compression, filter, interlace = 0

  // Raw scanlines with filter byte 0 at the start of each row
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw.set(
      new Uint8Array(data.buffer, data.byteOffset + y * width * 4, width * 4),
      y * (1 + width * 4) + 1
    )
  }
  const idat = await deflate(raw)

  const chunks = [new Uint8Array(PNG_SIGNATURE), makeChunk('IHDR', ihdr)]
  for (const [keyword, text] of Object.entries(texts)) {
    chunks.push(makeChunk('tEXt', makeTextChunk(keyword, text)))
  }
  chunks.push(makeChunk('IDAT', idat), makeChunk('IEND', new Uint8Array(0)))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// Scans a PNG file for tEXt chunks and returns them as keyword → text.
// Returns an empty object for non-PNG input.
export function readTextChunks(bytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return result
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )
    const dataStart = offset + 8
    if (dataStart + length > bytes.length) break
    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataStart + length)
      const sep = data.indexOf(0)
      if (sep > 0) {
        let keyword = ''
        for (let i = 0; i < sep; i++) keyword += String.fromCharCode(data[i])
        let text = ''
        for (let i = sep + 1; i < data.length; i++) text += String.fromCharCode(data[i])
        result[keyword] = text
      }
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  return result
}
