import { useEffect, useRef, useState } from 'react'
import { Dices } from 'lucide-react'
import { Layout, LAYOUT_TEMPLATES, PatternEngine, sameLayout } from './lib/engine'

const VARIANT_COLORS = ['#7dd3fc', '#fcd34d', '#6ee7b7', '#c4b5fd']
const VARIANT_LABELS = ['A', 'B', 'C', 'D']

type Props = {
  engine: PatternEngine
  highlightVariant: number | null
  onSelectLayout: (layout: Layout) => void
  onGenerateRandom: (count: number, withRotation: boolean) => void
  onSetHighlight: (variant: number | null) => void
}

function TemplateDiagram({ layout }: { layout: Layout }) {
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(${layout.cols}, 1fr)`, width: layout.cols * 11 }}
    >
      {layout.map.map((v, j) => (
        <div
          key={j}
          className="flex items-center justify-center rounded-[2px] text-[7px] font-bold text-gray-700"
          style={{ backgroundColor: VARIANT_COLORS[v], height: 11 }}
        >
          {VARIANT_LABELS[v]}
        </div>
      ))}
    </div>
  )
}

// Live thumbnail of one variant cell
function VariantThumb({ engine, variant }: { engine: PatternEngine; variant: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    canvas.width = engine.width
    canvas.height = engine.height
    const ctx = canvas.getContext('2d')!
    let lastRevision = -1
    const draw = () => {
      if (engine.revision === lastRevision) return
      lastRevision = engine.revision
      ctx.putImageData(
        new ImageData(
          engine.cellData(variant) as Uint8ClampedArray<ArrayBuffer>,
          engine.width,
          engine.height
        ),
        0,
        0
      )
    }
    draw()
    const timer = setInterval(draw, 300)
    return () => clearInterval(timer)
  }, [engine, variant])

  return <canvas ref={ref} className="h-9 w-9 rounded-md bg-white" />
}

export function LayoutPanel({
  engine,
  highlightVariant,
  onSelectLayout,
  onGenerateRandom,
  onSetHighlight
}: Props) {
  const [randomCount, setRandomCount] = useState(2)
  const [randomRotate, setRandomRotate] = useState(true)
  const isRandom = engine.arrangement.kind === 'random'

  return (
    <div className="absolute top-20 right-3 flex w-40 flex-col gap-3 rounded-xl bg-white/95 p-3 shadow-lg backdrop-blur">
      <div>
        <div className="mb-1.5 text-xs font-medium text-gray-500">配置</div>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              title={t.label}
              onClick={() => onSelectLayout(t.layout)}
              className={`flex h-11 items-center justify-center rounded-lg border ${
                engine.arrangement.kind === 'layout' &&
                sameLayout(t.layout, engine.arrangement.layout)
                  ? 'border-sky-400 bg-sky-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <TemplateDiagram layout={t.layout} />
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium text-gray-500">ランダム配置</div>
        <div className="flex items-center gap-1.5">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              onClick={() => setRandomCount(n)}
              className={`h-7 w-7 rounded-md border text-xs tabular-nums ${
                randomCount === n
                  ? 'border-sky-400 bg-sky-50 text-sky-700'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {n}
            </button>
          ))}
          <span className="text-[10px] text-gray-400">種類</span>
        </div>
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={randomRotate}
            onChange={(e) => setRandomRotate(e.target.checked)}
            className="accent-sky-600"
          />
          回転も混ぜる
        </label>
        <button
          onClick={() => onGenerateRandom(randomCount, randomRotate)}
          title="ランダムに並べ直す（絵は変わりません）"
          className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border py-1.5 text-sm ${
            isRandom
              ? 'border-sky-400 bg-sky-50 text-sky-700'
              : 'border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <Dices size={16} />
          シャッフル
        </button>
      </div>
      {engine.variantCount > 1 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-gray-500">セル</div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: engine.variantCount }, (_, v) => (
              <button
                key={v}
                title={`${VARIANT_LABELS[v]} のセルをハイライト`}
                onClick={() => onSetHighlight(highlightVariant === v ? null : v)}
                className={`relative rounded-lg border p-0.5 ${
                  highlightVariant === v
                    ? 'border-sky-500 ring-2 ring-sky-300'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <VariantThumb engine={engine} variant={v} />
                <span
                  className="absolute -top-1.5 -left-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-gray-700"
                  style={{ backgroundColor: VARIANT_COLORS[v] }}
                >
                  {VARIANT_LABELS[v]}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 max-w-36 text-[10px] leading-tight text-gray-400">
            クリックで同じセルの位置をハイライト
          </p>
        </div>
      )}
    </div>
  )
}
