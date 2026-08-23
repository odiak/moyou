import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  Eraser,
  FilePlus2,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Grid3x3,
  Hand,
  Maximize,
  PaintBucket,
  Pen,
  Pipette,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  Arrangement,
  layoutArrangement,
  MAX_BRUSH_SIZE,
  packColor,
  PatternEngine,
  randomBlockSize,
  RandomArrangement,
  sameArrangement,
  SINGLE_LAYOUT
} from './lib/engine'
import { decodePatternFile, downloadBytes, encodeLayoutPng, encodeRandomPng } from './lib/moyouFile'
import { LayoutPanel } from './LayoutPanel'
import { CanvasApi, PatternCanvas, Tool } from './PatternCanvas'

const CELL_SIZES = [128, 256, 512]
const MAX_UNDO = 50

function createEngine(size: number): PatternEngine {
  const engine = new PatternEngine(size, size, layoutArrangement(SINGLE_LAYOUT))
  engine.fillAll(packColor(0xffffff))
  return engine
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function App() {
  const [engine, setEngine] = useState(() => createEngine(128))
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#1e66b8')
  const [brushSize, setBrushSize] = useState(4)
  const [shiftFrac, setShiftFrac] = useState(0)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)
  const [showGuides, setShowGuides] = useState(true)
  const [gridDivisions, setGridDivisions] = useState(0)
  const [highlightVariant, setHighlightVariant] = useState<number | null>(null)
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const [, setHistoryVersion] = useState(0)

  const undoRef = useRef<Uint8ClampedArray[]>([])
  const redoRef = useRef<Uint8ClampedArray[]>([])
  const canvasApiRef = useRef<CanvasApi | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pattern params live on the engine (the canvas render loop watches them)
  engine.params.shift = Math.round(shiftFrac * engine.superWidth)
  engine.params.flipX = flipX
  engine.params.flipY = flipY

  const bumpHistory = () => setHistoryVersion((v) => v + 1)

  const pushUndo = useCallback(() => {
    undoRef.current.push(engine.snapshot())
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift()
    redoRef.current = []
    bumpHistory()
  }, [engine])

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (prev === undefined) return
    redoRef.current.push(engine.snapshot())
    engine.restore(prev)
    bumpHistory()
  }, [engine])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (next === undefined) return
    undoRef.current.push(engine.snapshot())
    engine.restore(next)
    bumpHistory()
  }, [engine])

  // Restores the pre-stroke state without moving it to the redo stack (used
  // when a stroke turns out to be the start of a pinch gesture)
  const cancelStroke = useCallback(() => {
    const prev = undoRef.current.pop()
    if (prev === undefined) return
    engine.restore(prev)
    bumpHistory()
  }, [engine])

  const replaceEngine = useCallback(
    (next: PatternEngine, params?: { shift: number; flipX: boolean; flipY: boolean }) => {
      undoRef.current = []
      redoRef.current = []
      if (params !== undefined) {
        next.params = { ...params }
        setShiftFrac(next.superWidth > 0 ? params.shift / next.superWidth : 0)
        setFlipX(params.flipX)
        setFlipY(params.flipY)
      } else {
        setShiftFrac(0)
        setFlipX(false)
        setFlipY(false)
      }
      setHighlightVariant(null)
      setEngine(next)
      bumpHistory()
    },
    []
  )

  // Switches the variant arrangement. Variants keep their identity (cell A
  // stays cell A, new ones start as copies), so reshuffling a random
  // arrangement never scrambles which drawing belongs to which cell.
  const changeArrangement = useCallback(
    (arrangement: Arrangement) => {
      if (sameArrangement(arrangement, engine.arrangement)) return
      const next = new PatternEngine(engine.width, engine.height, arrangement)
      for (let v = 0; v < next.variantCount; v++) {
        next.cellData(v).set(engine.cellData(v % engine.variantCount))
      }
      // Undo snapshots stay valid as long as the buffer shape is unchanged
      if (next.data.length !== engine.data.length) {
        undoRef.current = []
        redoRef.current = []
      }
      setHighlightVariant((hl) => (hl !== null && hl < next.variantCount ? hl : null))
      setEngine(next)
      bumpHistory()
    },
    [engine]
  )

  // Non-periodic random arrangement: each cell is a pure function of
  // (seed, i, k), so the whole infinite pattern is reproducible from the
  // seed. Seeds whose origin block misses a variant are rejected so the
  // export (sample block + seed) always round-trips.
  const generateRandom = useCallback(
    (count: number, withRotation: boolean) => {
      for (;;) {
        const arr: RandomArrangement = {
          kind: 'random',
          seed: (Math.random() * 0x100000000) >>> 0,
          count,
          rotate: withRotation
        }
        if (randomBlockSize(arr) !== undefined) {
          changeArrangement(arr)
          return
        }
      }
    },
    [changeArrangement]
  )

  const savePattern = useCallback(async () => {
    let bytes: Uint8Array
    if (engine.arrangement.kind === 'random') {
      const block = engine.composeRandomBlock()
      bytes = await encodeRandomPng(
        block.data,
        block.size,
        engine.width,
        engine.height,
        engine.arrangement,
        engine.params
      )
    } else {
      bytes = await encodeLayoutPng(
        engine.composeSuperData(),
        engine.width,
        engine.height,
        engine.arrangement.layout,
        engine.params
      )
    }
    downloadBytes(bytes, `moyou-${timestamp()}.png`)
  }, [engine])

  const openFile = useCallback(
    async (file: Blob) => {
      try {
        const loaded = await decodePatternFile(file)
        const next = new PatternEngine(
          loaded.cellWidth,
          loaded.cellHeight,
          loaded.arrangement,
          loaded.data
        )
        replaceEngine(next, loaded.params)
      } catch (e) {
        alert(e instanceof Error ? e.message : 'ファイルを読み込めませんでした')
      }
    },
    [replaceEngine]
  )

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never treat IME composition keys as shortcuts
      if (e.isComposing || e.keyCode === 229) return
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (meta) return
      switch (e.key.toLowerCase()) {
        case 'p':
        case 'b':
          setTool('pen')
          break
        case 'e':
          setTool('eraser')
          break
        case 'f':
        case 'g':
          setTool('fill')
          break
        case 'i':
          setTool('eyedropper')
          break
        case 'h':
          setTool('pan')
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  // Drag & drop to open
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer?.files[0]
      if (file !== undefined) void openFile(file)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openFile])

  const toolButton = (t: Tool, icon: React.ReactNode, label: string) => (
    <button
      key={t}
      title={label}
      onClick={() => setTool(t)}
      className={`rounded-lg p-2 ${
        tool === t ? 'bg-sky-100 text-sky-700' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {icon}
    </button>
  )

  const toggleButton = (
    active: boolean,
    onClick: () => void,
    icon: React.ReactNode,
    label: string
  ) => (
    <button
      title={label}
      onClick={onClick}
      className={`rounded-lg p-2 ${
        active ? 'bg-sky-100 text-sky-700' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div className="relative h-full overflow-hidden bg-gray-200">
      <PatternCanvas
        engine={engine}
        tool={tool}
        color={color}
        brushSize={brushSize}
        showGuides={showGuides}
        gridDivisions={gridDivisions}
        highlightVariant={highlightVariant}
        onPickColor={(c) => {
          setColor(c)
          setTool('pen')
        }}
        onBeforeMutate={pushUndo}
        onCancelStroke={cancelStroke}
        apiRef={canvasApiRef}
      />

      {/* Header */}
      <div className="absolute top-3 left-3 right-3 flex items-center gap-1 rounded-xl bg-white/95 px-3 py-1.5 shadow-lg backdrop-blur">
        <div className="mr-2 flex items-baseline gap-1.5">
          <span className="text-lg font-bold tracking-wide text-gray-800">Moyou</span>
          <span className="hidden text-xs text-gray-400 sm:inline">by Kakeru</span>
        </div>
        <button
          title="新規作成"
          onClick={() => setNewDialogOpen(true)}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <FilePlus2 size={18} />
        </button>
        <button
          title="開く（PNG）"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <FolderOpen size={18} />
        </button>
        <button
          title="PNG として保存"
          onClick={() => void savePattern()}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <Download size={18} />
        </button>
        <div className="mx-1 h-6 w-px bg-gray-200" />
        <button
          title="元に戻す (⌘Z)"
          onClick={undo}
          disabled={undoRef.current.length === 0}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
        >
          <Undo2 size={18} />
        </button>
        <button
          title="やり直す (⇧⌘Z)"
          onClick={redo}
          disabled={redoRef.current.length === 0}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
        >
          <Redo2 size={18} />
        </button>
        <div className="flex-1" />
        <button
          title="縮小"
          onClick={() => canvasApiRef.current?.zoomBy(1 / 1.5)}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <ZoomOut size={18} />
        </button>
        <button
          title="拡大"
          onClick={() => canvasApiRef.current?.zoomBy(1.5)}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <ZoomIn size={18} />
        </button>
        <button
          title="表示をリセット"
          onClick={() => canvasApiRef.current?.resetView()}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        >
          <Maximize size={18} />
        </button>
      </div>

      {/* Tools */}
      <div className="absolute top-20 left-3 flex flex-col gap-1 rounded-xl bg-white/95 p-1.5 shadow-lg backdrop-blur">
        {toolButton('pen', <Pen size={20} />, 'ペン (P)')}
        {toolButton('eraser', <Eraser size={20} />, '消しゴム (E)')}
        {toolButton('fill', <PaintBucket size={20} />, '塗りつぶし (F)')}
        {toolButton('eyedropper', <Pipette size={20} />, 'スポイト (I)')}
        {toolButton('pan', <Hand size={20} />, '移動 (H / Space)')}
      </div>

      {/* Arrangement & variants */}
      <LayoutPanel
        engine={engine}
        highlightVariant={highlightVariant}
        onSelectLayout={(layout) => changeArrangement(layoutArrangement(layout))}
        onGenerateRandom={generateRandom}
        onSetHighlight={setHighlightVariant}
      />

      {/* Bottom bar */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white/95 px-4 py-2 shadow-lg backdrop-blur">
        <label className="flex items-center gap-2" title="色">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-8 cursor-pointer rounded-md border border-gray-200 bg-white p-0.5"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>太さ</span>
          <input
            type="range"
            min={1}
            max={MAX_BRUSH_SIZE}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-24 sm:w-32"
          />
          <span className="w-6 text-right tabular-nums">{brushSize}</span>
        </label>
        <div className="hidden h-6 w-px bg-gray-200 sm:block" />
        <label className="flex items-center gap-2 text-sm text-gray-600" title="行ごとの横ずらし">
          <span>ずらし</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={shiftFrac}
            onChange={(e) => setShiftFrac(Number(e.target.value))}
            className="w-24 sm:w-32"
          />
          <span className="w-10 text-right tabular-nums">
            {Math.round(shiftFrac * engine.superWidth)}px
          </span>
        </label>
        {toggleButton(
          flipX,
          () => setFlipX(!flipX),
          <FlipHorizontal2 size={18} />,
          '交互に左右反転'
        )}
        {toggleButton(flipY, () => setFlipY(!flipY), <FlipVertical2 size={18} />, '交互に上下反転')}
        {toggleButton(
          showGuides,
          () => setShowGuides(!showGuides),
          <Grid3x3 size={18} />,
          'セル境界のガイド'
        )}
        <label className="flex items-center gap-1.5 text-sm text-gray-600">
          <span>グリッド</span>
          {[2, 4, 8].map((n) => (
            <button
              key={n}
              title={`セルを${n}分割するグリッド（もう一度クリックで非表示）`}
              onClick={() => setGridDivisions(gridDivisions === n ? 0 : n)}
              className={`h-7 w-7 rounded-md border text-xs tabular-nums ${
                gridDivisions === n
                  ? 'border-sky-400 bg-sky-50 text-sky-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {n}
            </button>
          ))}
        </label>
        <div className="flex-1" />
        <span className="hidden text-xs text-gray-400 sm:inline">
          セル {engine.width}×{engine.height}px
          {engine.variantCount > 1 && `（${engine.variantCount}種）`}
        </span>
      </div>

      {/* New pattern dialog */}
      {newDialogOpen && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/30"
          onClick={() => setNewDialogOpen(false)}
        >
          <div
            className="w-72 rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-base font-bold text-gray-800">新しい模様</h2>
            <p className="mb-4 text-xs text-gray-500">
              セルのサイズを選んでください。現在の模様は破棄されます。
            </p>
            <div className="mb-4 flex gap-2">
              {CELL_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => {
                    replaceEngine(createEngine(size))
                    setNewDialogOpen(false)
                  }}
                  className="flex-1 rounded-lg border border-gray-200 py-2 text-sm text-gray-700 hover:border-sky-400 hover:bg-sky-50"
                >
                  {size}px
                </button>
              ))}
            </div>
            <button
              onClick={() => setNewDialogOpen(false)}
              className="w-full rounded-lg py-2 text-sm text-gray-500 hover:bg-gray-100"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file !== undefined) void openFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
