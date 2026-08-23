import { useEffect, useRef } from 'react'
import {
  layoutRotation,
  packColor,
  PatternEngine,
  randomCellAt,
  TRANSPARENT,
  unpackColor
} from './lib/engine'

export type Tool = 'pen' | 'eraser' | 'fill' | 'eyedropper' | 'pan'

export type CanvasApi = {
  zoomBy: (factor: number) => void
  resetView: () => void
}

type Props = {
  engine: PatternEngine
  tool: Tool
  color: string
  brushSize: number
  showGuides: boolean
  // In-cell alignment grid: number of subdivisions per cell (0 = off)
  gridDivisions: number
  // Cells of this variant get an accent outline (visual aid only)
  highlightVariant: number | null
  onPickColor: (hex: string) => void
  onBeforeMutate: () => void
  onCancelStroke: () => void
  apiRef: React.RefObject<CanvasApi | null>
}

type View = { x: number; y: number; scale: number }

type Mode =
  | { type: 'stroke'; lastX: number; lastY: number }
  | { type: 'pan'; pointerId: number; startClientX: number; startClientY: number; startView: View }
  | {
      type: 'pinch'
      ids: [number, number]
      startDist: number
      startMidX: number
      startMidY: number
      startView: View
    }

const MAX_SCALE = 32

function colorToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b
}

export function PatternCanvas(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Everything the event handlers need, kept in refs so listeners can be
  // attached once
  const propsRef = useRef(props)
  propsRef.current = props

  const viewRef = useRef<View>({ x: 0, y: 0, scale: 4 })
  const modeRef = useRef<Mode | null>(null)
  const pointersRef = useRef(new Map<number, { clientX: number; clientY: number }>())
  const spaceHeldRef = useRef(false)

  useEffect(() => {
    const container = containerRef.current!
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    // The super cell (variant arrangement) rendered as one image; each
    // variant gets its own small canvas so it can be drawn rotated
    const superCanvas = document.createElement('canvas')
    const superCtx = superCanvas.getContext('2d')!
    let variantImages: ImageData[] = []
    let variantCanvases: HTMLCanvasElement[] = []
    let uploadedEngine: PatternEngine | null = null
    let uploadedRevision = -1

    let cssW = 0
    let cssH = 0
    let dpr = window.devicePixelRatio || 1

    const minScale = (): number => {
      const { engine } = propsRef.current
      return Math.max(cssW / (engine.superWidth * 48), cssH / (engine.superHeight * 48), 1 / 16)
    }

    const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(minScale(), s))

    const resetView = () => {
      const { engine } = propsRef.current
      const view = viewRef.current
      // Fit roughly five cells across (independent of super cell size, so
      // large random blocks don't start zoomed way out)
      const target = Math.min(cssW / (engine.width * 5), cssH / (engine.height * 5))
      view.scale = clampScale(Math.min(8, Math.max(0.5, target)))
      view.x = engine.superWidth / 2 - cssW / (2 * view.scale)
      view.y = engine.superHeight / 2 - cssH / (2 * view.scale)
    }

    const zoomAt = (px: number, py: number, factor: number) => {
      const view = viewRef.current
      const newScale = clampScale(view.scale * factor)
      const wx = view.x + px / view.scale
      const wy = view.y + py / view.scale
      view.x = wx - px / newScale
      view.y = wy - py / newScale
      view.scale = newScale
    }

    props.apiRef.current = {
      zoomBy: (factor) => zoomAt(cssW / 2, cssH / 2, factor),
      resetView: () => resetView()
    }

    let renderedOnce = false
    const resize = () => {
      const rect = container.getBoundingClientRect()
      cssW = rect.width
      cssH = rect.height
      dpr = window.devicePixelRatio || 1
      const pw = Math.max(1, Math.round(cssW * dpr))
      const ph = Math.max(1, Math.round(cssH * dpr))
      // Assigning width/height clears the canvas even with unchanged values,
      // so only do it on an actual change, and force a re-render then
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
        renderedOnce = false
      }
    }

    const render = () => {
      const { engine, showGuides, highlightVariant } = propsRef.current
      const view = viewRef.current
      const { width: w, height: h, arrangement } = engine
      const layout = arrangement.kind === 'layout' ? arrangement.layout : null
      const randomArr = arrangement.kind === 'random' ? arrangement : null
      const W = engine.superWidth
      const H = engine.superHeight
      const { shift, flipX, flipY } = engine.params

      // Upload the variant buffers to the super cell canvas if they changed
      if (uploadedEngine !== engine) {
        superCanvas.width = W
        superCanvas.height = H
        variantImages = []
        variantCanvases = []
        for (let v = 0; v < engine.variantCount; v++) {
          variantImages.push(
            new ImageData(engine.cellData(v) as Uint8ClampedArray<ArrayBuffer>, w, h)
          )
          const vc = document.createElement('canvas')
          vc.width = w
          vc.height = h
          variantCanvases.push(vc)
        }
        uploadedEngine = engine
        uploadedRevision = -1
      }
      if (uploadedRevision !== engine.revision) {
        for (let v = 0; v < engine.variantCount; v++) {
          variantCanvases[v].getContext('2d')!.putImageData(variantImages[v], 0, 0)
        }
        if (layout !== null) {
          superCtx.setTransform(1, 0, 0, 1, 0, 0)
          superCtx.clearRect(0, 0, W, H)
          for (let j = 0; j < layout.map.length; j++) {
            const gx = j % layout.cols
            const gy = (j / layout.cols) | 0
            const rot = layoutRotation(layout, j)
            if (rot === 0) {
              superCtx.drawImage(variantCanvases[layout.map[j]], gx * w, gy * h)
            } else {
              superCtx.save()
              superCtx.translate(gx * w + w / 2, gy * h + h / 2)
              superCtx.rotate((rot * Math.PI) / 2)
              superCtx.drawImage(variantCanvases[layout.map[j]], -w / 2, -h / 2)
              superCtx.restore()
            }
          }
        }
        uploadedRevision = engine.revision
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, cssW, cssH)
      ctx.imageSmoothingEnabled = false

      const s = view.scale
      const highlightRects: number[] = []
      const k0 = Math.floor(view.y / H)
      const k1 = Math.floor((view.y + cssH / s) / H)
      for (let k = k0; k <= k1; k++) {
        const rowShift = k * shift
        const i0 = Math.floor((view.x - rowShift) / W)
        const i1 = Math.floor((view.x + cssW / s - rowShift) / W)
        const sy0 = Math.round((k * H - view.y) * s)
        const sy1 = Math.round(((k + 1) * H - view.y) * s)
        const fy = flipY && mod(k, 2) === 1
        for (let i = i0; i <= i1; i++) {
          const x0 = i * W + rowShift
          const sx0 = Math.round((x0 - view.x) * s)
          const sx1 = Math.round((x0 + W - view.x) * s)
          const fx = flipX && mod(i, 2) === 1
          const dw = sx1 - sx0
          const dh = sy1 - sy0
          if (randomArr !== null) {
            // Random arrangement: each cell is drawn individually with its
            // hash-chosen variant and rotation
            const { v, rot } = randomCellAt(randomArr, i, k)
            if (!fx && !fy && rot === 0) {
              ctx.drawImage(variantCanvases[v], sx0, sy0, dw, dh)
            } else {
              ctx.save()
              ctx.translate(sx0 + dw / 2, sy0 + dh / 2)
              ctx.scale(fx ? -1 : 1, fy ? -1 : 1)
              ctx.rotate((rot * Math.PI) / 2)
              ctx.drawImage(variantCanvases[v], -dw / 2, -dh / 2, dw, dh)
              ctx.restore()
            }
            if (highlightVariant === v) {
              highlightRects.push((x0 - view.x) * s, (k * H - view.y) * s)
            }
            continue
          }
          if (!fx && !fy) {
            ctx.drawImage(superCanvas, sx0, sy0, dw, dh)
          } else {
            ctx.save()
            ctx.translate(fx ? sx1 : sx0, fy ? sy1 : sy0)
            ctx.scale(fx ? -1 : 1, fy ? -1 : 1)
            ctx.drawImage(superCanvas, 0, 0, dw, dh)
            ctx.restore()
          }
          if (highlightVariant !== null && layout !== null) {
            const { cols, rows, map } = layout
            for (let j = 0; j < map.length; j++) {
              if (map[j] !== highlightVariant) continue
              const gx = j % cols
              const gy = (j / cols) | 0
              // Mirrored instances show this grid cell at the mirrored spot
              const dgx = fx ? cols - 1 - gx : gx
              const dgy = fy ? rows - 1 - gy : gy
              highlightRects.push((x0 + dgx * w - view.x) * s, (k * H + dgy * h - view.y) * s)
            }
          }
        }
      }

      // In-cell alignment grid: subdivides every cell into gridDivisions
      // parts so edge ports can be drawn at consistent positions across
      // variants. Cell midlines are slightly stronger (edge midpoints are
      // the natural connection points). Hidden when too dense on screen,
      // and follows the cell-boundary guides toggle.
      const grid = propsRef.current.gridDivisions
      if (showGuides && grid > 0 && (w / grid) * s >= 8) {
        const stepX = w / grid
        const stepY = h / grid
        const nx = (W / w) * grid
        const ny = (H / h) * grid
        for (const midPass of [false, true]) {
          ctx.strokeStyle = midPass ? 'rgba(0, 0, 0, 0.16)' : 'rgba(0, 0, 0, 0.07)'
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let k = k0; k <= k1; k++) {
            const rowShift = k * shift
            const yTop = Math.max(0, (k * H - view.y) * s)
            const yBottom = Math.min(cssH, ((k + 1) * H - view.y) * s)
            const i0 = Math.floor((view.x - rowShift) / W)
            const i1 = Math.floor((view.x + cssW / s - rowShift) / W)
            for (let m = 1; m < ny; m++) {
              if (m % grid === 0) continue // cell boundary, drawn by guides
              if ((m % grid === grid / 2) !== midPass) continue
              const y = (k * H + m * stepY - view.y) * s
              ctx.moveTo(0, y)
              ctx.lineTo(cssW, y)
            }
            for (let i = i0; i <= i1; i++) {
              for (let m = 1; m < nx; m++) {
                if (m % grid === 0) continue
                if ((m % grid === grid / 2) !== midPass) continue
                const x = (i * W + rowShift + m * stepX - view.x) * s
                ctx.moveTo(x, yTop)
                ctx.lineTo(x, yBottom)
              }
            }
          }
          ctx.stroke()
        }
      }

      if (showGuides) {
        // Super cell boundaries
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let k = k0; k <= k1 + 1; k++) {
          const y = (k * H - view.y) * s
          ctx.moveTo(0, y)
          ctx.lineTo(cssW, y)
        }
        for (let k = k0; k <= k1; k++) {
          const rowShift = k * shift
          const yTop = Math.max(0, (k * H - view.y) * s)
          const yBottom = Math.min(cssH, ((k + 1) * H - view.y) * s)
          const i0 = Math.floor((view.x - rowShift) / W)
          const i1 = Math.floor((view.x + cssW / s - rowShift) / W) + 1
          for (let i = i0; i <= i1; i++) {
            const x = (i * W + rowShift - view.x) * s
            ctx.moveTo(x, yTop)
            ctx.lineTo(x, yBottom)
          }
        }
        ctx.stroke()

        // Inner cell boundaries (lighter)
        if (layout !== null && (layout.cols > 1 || layout.rows > 1)) {
          const { cols, rows } = layout
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)'
          ctx.beginPath()
          for (let k = k0; k <= k1; k++) {
            for (let r = 1; r < rows; r++) {
              const y = (k * H + r * h - view.y) * s
              ctx.moveTo(0, y)
              ctx.lineTo(cssW, y)
            }
            if (cols > 1) {
              const rowShift = k * shift
              const yTop = Math.max(0, (k * H - view.y) * s)
              const yBottom = Math.min(cssH, ((k + 1) * H - view.y) * s)
              const i0 = Math.floor((view.x - rowShift) / W)
              const i1 = Math.floor((view.x + cssW / s - rowShift) / W)
              for (let i = i0; i <= i1; i++) {
                for (let c = 1; c < cols; c++) {
                  const x = (i * W + rowShift + c * w - view.x) * s
                  ctx.moveTo(x, yTop)
                  ctx.lineTo(x, yBottom)
                }
              }
            }
          }
          ctx.stroke()
        }
      }

      if (highlightRects.length > 0) {
        ctx.strokeStyle = 'rgba(2, 132, 199, 0.9)'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let r = 0; r < highlightRects.length; r += 2) {
          ctx.rect(highlightRects[r] + 1, highlightRects[r + 1] + 1, w * s - 2, h * s - 2)
        }
        ctx.stroke()
      }
    }

    // Render loop: re-renders only when something visible changed. Driven by
    // setInterval rather than requestAnimationFrame so it also works in
    // throttled/background tabs; the actual render only runs on change.
    let last: {
      engine: PatternEngine | null
      revision: number
      shift: number
      flipX: boolean
      flipY: boolean
      x: number
      y: number
      scale: number
      guides: boolean
      grid: number
      highlight: number | null
      w: number
      h: number
      dpr: number
    } = {
      engine: null,
      revision: -1,
      shift: 0,
      flipX: false,
      flipY: false,
      x: 0,
      y: 0,
      scale: 0,
      guides: false,
      grid: 0,
      highlight: null,
      w: 0,
      h: 0,
      dpr: 0
    }

    let needsResetView = true
    const tick = () => {
      const { engine, showGuides, gridDivisions, highlightVariant } = propsRef.current
      if (engine !== last.engine) {
        resize()
        needsResetView = true
      }
      if (needsResetView) {
        if (cssW === 0 || cssH === 0) return
        resetView()
        needsResetView = false
      }
      const view = viewRef.current
      const p = engine.params
      if (
        renderedOnce &&
        engine === last.engine &&
        engine.revision === last.revision &&
        p.shift === last.shift &&
        p.flipX === last.flipX &&
        p.flipY === last.flipY &&
        view.x === last.x &&
        view.y === last.y &&
        view.scale === last.scale &&
        showGuides === last.guides &&
        gridDivisions === last.grid &&
        highlightVariant === last.highlight &&
        cssW === last.w &&
        cssH === last.h &&
        dpr === last.dpr
      ) {
        return
      }
      render()
      renderedOnce = true
      last = {
        engine,
        revision: engine.revision,
        shift: p.shift,
        flipX: p.flipX,
        flipY: p.flipY,
        x: view.x,
        y: view.y,
        scale: view.scale,
        guides: showGuides,
        grid: gridDivisions,
        highlight: highlightVariant,
        w: cssW,
        h: cssH,
        dpr
      }
    }

    resize()
    tick()
    const renderTimer = setInterval(tick, 16)

    const observer = new ResizeObserver(() => resize())
    observer.observe(container)

    // ---- input handling ----

    const canvasPos = (e: { clientX: number; clientY: number }): [number, number] => {
      const rect = canvas.getBoundingClientRect()
      return [e.clientX - rect.left, e.clientY - rect.top]
    }

    const worldPos = (e: { clientX: number; clientY: number }): [number, number] => {
      const [px, py] = canvasPos(e)
      const view = viewRef.current
      return [Math.floor(view.x + px / view.scale), Math.floor(view.y + py / view.scale)]
    }

    const updateCursor = () => {
      const { tool } = propsRef.current
      const panning = modeRef.current?.type === 'pan' || modeRef.current?.type === 'pinch'
      if (panning) canvas.style.cursor = 'grabbing'
      else if (tool === 'pan' || spaceHeldRef.current) canvas.style.cursor = 'grab'
      else canvas.style.cursor = 'crosshair'
    }
    updateCursor()

    const startPinch = () => {
      const entries = [...pointersRef.current.entries()]
      if (entries.length < 2) return
      const [[id1, p1], [id2, p2]] = entries
      const view = viewRef.current
      modeRef.current = {
        type: 'pinch',
        ids: [id1, id2],
        startDist: Math.max(10, Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY)),
        startMidX: (p1.clientX + p2.clientX) / 2,
        startMidY: (p1.clientY + p2.clientY) / 2,
        startView: { ...view }
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
      const p = propsRef.current

      if (e.pointerType === 'touch' && pointersRef.current.size === 2) {
        // A second finger: the first finger's stroke (if any) was accidental
        if (modeRef.current?.type === 'stroke') p.onCancelStroke()
        startPinch()
        updateCursor()
        return
      }
      if (pointersRef.current.size > 1) return

      const pan = e.button === 1 || p.tool === 'pan' || spaceHeldRef.current
      if (pan) {
        modeRef.current = {
          type: 'pan',
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startView: { ...viewRef.current }
        }
        updateCursor()
        return
      }
      if (e.button !== 0) return

      const [wx, wy] = worldPos(e)
      if (p.tool === 'pen' || p.tool === 'eraser') {
        p.onBeforeMutate()
        const packed = p.tool === 'eraser' ? TRANSPARENT : packColor(colorToNumber(p.color))
        p.engine.stroke([wx, wy, wx, wy], p.brushSize, packed)
        modeRef.current = { type: 'stroke', lastX: wx, lastY: wy }
      } else if (p.tool === 'fill') {
        p.onBeforeMutate()
        p.engine.fillAtWorld(wx, wy, packColor(colorToNumber(p.color)))
      } else if (p.tool === 'eyedropper') {
        const packed = p.engine.readWorldPixel(wx, wy)
        const { color, alpha } = unpackColor(packed)
        if (alpha > 0) {
          p.onPickColor('#' + color.toString(16).padStart(6, '0'))
        }
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const tracked = pointersRef.current.get(e.pointerId)
      if (tracked !== undefined) {
        tracked.clientX = e.clientX
        tracked.clientY = e.clientY
      }
      const mode = modeRef.current
      if (mode === null) return
      const p = propsRef.current
      const view = viewRef.current

      if (mode.type === 'stroke') {
        if (tracked === undefined) return
        const [wx, wy] = worldPos(e)
        if (wx === mode.lastX && wy === mode.lastY) return
        const packed = p.tool === 'eraser' ? TRANSPARENT : packColor(colorToNumber(p.color))
        p.engine.stroke([mode.lastX, mode.lastY, wx, wy], p.brushSize, packed)
        mode.lastX = wx
        mode.lastY = wy
      } else if (mode.type === 'pan') {
        if (e.pointerId !== mode.pointerId) return
        view.x = mode.startView.x - (e.clientX - mode.startClientX) / mode.startView.scale
        view.y = mode.startView.y - (e.clientY - mode.startClientY) / mode.startView.scale
      } else {
        const p1 = pointersRef.current.get(mode.ids[0])
        const p2 = pointersRef.current.get(mode.ids[1])
        if (p1 === undefined || p2 === undefined) return
        const dist = Math.max(10, Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY))
        const midX = (p1.clientX + p2.clientX) / 2
        const midY = (p1.clientY + p2.clientY) / 2
        const newScale = clampScale(mode.startView.scale * (dist / mode.startDist))
        const rect = canvas.getBoundingClientRect()
        // Keep the world point that was under the initial midpoint anchored
        // to the current midpoint
        const anchorWX = mode.startView.x + (mode.startMidX - rect.left) / mode.startView.scale
        const anchorWY = mode.startView.y + (mode.startMidY - rect.top) / mode.startView.scale
        view.scale = newScale
        view.x = anchorWX - (midX - rect.left) / newScale
        view.y = anchorWY - (midY - rect.top) / newScale
      }
    }

    const onPointerUpOrCancel = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId)
      const mode = modeRef.current
      if (mode === null) return
      if (mode.type === 'pinch') {
        if (mode.ids.includes(e.pointerId)) {
          const remaining = [...pointersRef.current.entries()][0]
          if (remaining !== undefined) {
            const [, pos] = remaining
            modeRef.current = {
              type: 'pan',
              pointerId: remaining[0],
              startClientX: pos.clientX,
              startClientY: pos.clientY,
              startView: { ...viewRef.current }
            }
          } else {
            modeRef.current = null
          }
        }
      } else if (mode.type === 'pan') {
        if (mode.pointerId === e.pointerId) modeRef.current = null
      } else {
        modeRef.current = null
      }
      updateCursor()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const view = viewRef.current
      const [px, py] = canvasPos(e)
      if (e.ctrlKey || e.metaKey) {
        zoomAt(px, py, Math.exp(-e.deltaY * 0.01))
      } else {
        view.x += e.deltaX / view.scale
        view.y += e.deltaY / view.scale
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const target = e.target as HTMLElement | null
        if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'BUTTON')) return
        spaceHeldRef.current = true
        updateCursor()
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false
        updateCursor()
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUpOrCancel)
    canvas.addEventListener('pointercancel', onPointerUpOrCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      clearInterval(renderTimer)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUpOrCancel)
      canvas.removeEventListener('pointercancel', onPointerUpOrCancel)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cursor follows the selected tool
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.style.cursor = props.tool === 'pan' ? 'grab' : 'crosshair'
  }, [props.tool])

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
    </div>
  )
}
