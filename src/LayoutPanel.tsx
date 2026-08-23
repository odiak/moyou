import { useEffect, useRef } from 'react'
import { Layout, LAYOUT_TEMPLATES, LayoutTemplate, PatternEngine, sameLayout } from './lib/engine'

const VARIANT_COLORS = ['#7dd3fc', '#fcd34d', '#6ee7b7', '#c4b5fd']
const VARIANT_LABELS = ['A', 'B', 'C', 'D']

type Props = {
  engine: PatternEngine
  highlightVariant: number | null
  onSelectTemplate: (template: LayoutTemplate) => void
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

export function LayoutPanel({ engine, highlightVariant, onSelectTemplate, onSetHighlight }: Props) {
  return (
    <div className="absolute top-20 right-3 flex flex-col gap-3 rounded-xl bg-white/95 p-3 shadow-lg backdrop-blur">
      <div>
        <div className="mb-1.5 text-xs font-medium text-gray-500">配置</div>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              title={t.label}
              onClick={() => onSelectTemplate(t)}
              className={`flex h-11 items-center justify-center rounded-lg border ${
                sameLayout(t.layout, engine.layout)
                  ? 'border-sky-400 bg-sky-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <TemplateDiagram layout={t.layout} />
            </button>
          ))}
        </div>
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
