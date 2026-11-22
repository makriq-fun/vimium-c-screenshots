/**
 * Pure helpers for planning a stitched screenshot.
 *
 * They intentionally do not touch the DOM, so that they can be compiled and tested on Node.js.
 * All coordinates are CSS pixels; a "tile" is one `tabs.captureVisibleTab` capture.
 */

export interface ShotRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ShotSize {
  w: number
  h: number
}

export interface ShotTile {
  x: number
  y: number
}

/**
 * Returns scroll offsets along one axis which cover `[start, start + size)`.
 * The first offset is clamped to the scrollable range; the final tile may be clamped
 * to `maxScroll`, in which case it overlaps previous tiles (the canvas is clipped anyway).
 */
export const planAxis = (start: number, size: number, viewport: number, maxScroll: number): number[] => {
  const end = start + size, out: number[] = []
  let pos = start < 0 ? 0 : start > maxScroll ? maxScroll : start
  out.push(pos)
  if (!(viewport > 0) || !(size > 0)) { return out }
  const step = Math.max(1, viewport)
  for (let n = 0; n < 4096; n++) {
    if (pos + viewport >= end - 0.5) { break }
    const next = Math.min(maxScroll, pos + step)
    if (next <= pos + 0.5) { break }
    out.push(pos = next)
  }
  return out
}

/**
 * Plans a two-dimensional grid of viewport positions which covers `rect`.
 * Returns null when the number of tiles exceeds `maxTiles`, so the caller can report an error.
 */
export const planTiles = (rect: ShotRect, viewport: ShotSize, maxScrollX: number, maxScrollY: number
    , maxTiles: number): ShotTile[] | null => {
  if (!(rect.w > 0) || !(rect.h > 0) || !(viewport.w > 0) || !(viewport.h > 0)) { return null }
  const xs = planAxis(rect.x, rect.w, viewport.w, maxScrollX)
  const ys = planAxis(rect.y, rect.h, viewport.h, maxScrollY)
  if (xs.length * ys.length > maxTiles) { return null }
  const tiles: ShotTile[] = []
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x, y })
    }
  }
  return tiles
}

/** Device-pixel size of the stitched image, or null when a browser canvas limit would be exceeded. */
export const calcOutputSize = (w: number, h: number, scaleX: number, scaleY: number
    , maxSide: number, maxPixels: number): ShotSize | null => {
  if (!(w > 0) || !(h > 0) || !(scaleX > 0) || !(scaleY > 0)) { return null }
  const outW = Math.max(1, Math.round(w * scaleX)), outH = Math.max(1, Math.round(h * scaleY))
  if (outW > maxSide || outH > maxSide || outW * outH > maxPixels) { return null }
  return { w: outW, h: outH }
}
