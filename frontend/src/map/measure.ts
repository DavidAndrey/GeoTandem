// Measuring on the map (design B10, plan E1.8 G2): geodesic, on the WGS84
// ellipsoid, with Karney's algorithms (GeographicLib). Pure; nothing here
// touches data, so no backend is involved and F-2.14 does not arise.
import { Geodesic } from 'geographiclib-geodesic'

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
  value.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits })

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
