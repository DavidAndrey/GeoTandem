// Measuring on the map (design B10, plan E1.8 G2): geodesic, on the WGS84
// ellipsoid, with Karney's algorithms (GeographicLib). Pure; nothing here
// touches data, so no backend is involved and F-2.14 does not arise.
import { Geodesic } from 'geographiclib-geodesic'
import { formatNumber } from '../i18n/locale'

/** [latitude, longitude] in degrees. */
export type LatLng = [number, number]

const wgs84 = Geodesic.WGS84

/** Length of the line through ``points``, in metres. */
export function lengthOf(points: LatLng[]): number {
  if (points.length < 2) return 0
  const line = wgs84.Polygon(true)
  for (const [lat, lng] of points) line.AddPoint(lat, lng)
  return line.Compute(false, true).perimeter
}

/** Area and perimeter of the polygon through ``points`` (closed back to the first), in m² and m. */
export function areaOf(points: LatLng[]): { area: number; perimeter: number } {
  if (points.length < 3) return { area: 0, perimeter: lengthOf(points) }
  const polygon = wgs84.Polygon(false)
  for (const [lat, lng] of points) polygon.AddPoint(lat, lng)
  const result = polygon.Compute(false, true)
  return { area: Math.abs(result.area ?? 0), perimeter: result.perimeter }
}

const number = (value: number, digits: number) =>
  formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** "850 m", "12.35 km" (Swiss number format). */
export function formatLength(meters: number): string {
  if (meters < 1000) return `${number(meters, meters < 10 ? 1 : 0)} m`
  return `${number(meters / 1000, meters < 100_000 ? 2 : 1)} km`
}

/** "850 m²", "3.20 ha", "12.4 km²". */
export function formatArea(squareMeters: number): string {
  if (squareMeters < 10_000) return `${number(squareMeters, 0)} m²`
  if (squareMeters < 1_000_000) return `${number(squareMeters / 10_000, 2)} ha`
  return `${number(squareMeters / 1_000_000, squareMeters < 100_000_000 ? 2 : 1)} km²`
}

// --- drawing ----------------------------------------------------------------

export interface Drawing {
  points: LatLng[]
  cursor: LatLng | null
  /** A double click finished it; the next click starts a new one. */
  done: boolean
  /** Escape on an empty drawing ends measuring. */
  exit: boolean
}

export type DrawingAction =
  | { type: 'add'; point: LatLng }
  | { type: 'move'; point: LatLng }
  | { type: 'finish' }
  | { type: 'escape' }

/** Clicks, pointer moves, double click and Escape while measuring. */
export function reduceDrawing(state: Drawing, action: DrawingAction): Drawing {
  switch (action.type) {
    case 'add': {
      // A double click to finish also clicks twice at the same spot: one point.
      const last = state.points.at(-1)
      if (!state.done && last && last[0] === action.point[0] && last[1] === action.point[1])
        return state
      return {
        ...state,
        points: state.done ? [action.point] : [...state.points, action.point],
        done: false,
      }
    }
    case 'move':
      return { ...state, cursor: action.point }
    case 'finish':
      return { ...state, done: true }
    case 'escape':
      return { ...state, points: [], done: false, exit: state.points.length === 0 }
  }
}
