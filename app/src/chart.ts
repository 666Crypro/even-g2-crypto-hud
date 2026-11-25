// 24h sparkline rendered to a PNG on a canvas. The SDK converts it to 4-bit greyscale for G2.
// Thick, high-contrast strokes only: hairlines vanish on the 576x288 green display.
export const CHART_W = 264
export const CHART_H = 136

export async function sparklinePng(values: number[], w = CHART_W, h = CHART_H): Promise<Uint8Array> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  if (values.length >= 2) {
    const min = Math.min(...values), max = Math.max(...values)
    const pad = 8
    const x = (i: number) => pad + (i / (values.length - 1)) * (w - pad * 2)
    const y = (v: number) => pad + (1 - (v - min) / (max - min || 1)) * (h - pad * 2 - 14)
    // dim area fill under the line
    ctx.beginPath()
    ctx.moveTo(x(0), h - 14)
    values.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.lineTo(x(values.length - 1), h - 14)
    ctx.closePath()
    ctx.fillStyle = '#0e0e0e'
    ctx.fill()
    // opening-price reference (dashed)
    ctx.setLineDash([4, 5])
    ctx.strokeStyle = '#6a6a6a'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(pad, y(values[0]))
    ctx.lineTo(w - pad, y(values[0]))
    ctx.stroke()
    ctx.setLineDash([])
    // price line
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.beginPath()
    values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))))
    ctx.stroke()
    // last-price dot
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(x(values.length - 1), y(values[values.length - 1]), 5, 0, Math.PI * 2)
    ctx.fill()
    // axis label
    ctx.fillStyle = '#9a9a9a'
    ctx.font = 'bold 12px sans-serif'
    ctx.fillText('24h', pad, h - 2)
  }
  const blob: Blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

export async function blankPng(w = CHART_W, h = CHART_H): Promise<Uint8Array> {
  return sparklinePng([], w, h)
}

/** RMS level of a PCM s16le chunk, 0..1, for the push-to-talk meter. */
export function pcmLevel(pcm: Uint8Array): number {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let sum = 0
  const n = Math.floor(pcm.byteLength / 2)
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  return n ? Math.min(1, Math.sqrt(sum / n) * 4) : 0
}
