// The analysis state (CONTEXT.md "Analysezustand"): what the user built in
// the classic mode. It is translated into query objects by query.ts and never
// executed any other way (etappen E1.5: the interface edits the query object).
import type { Schemas } from '../api/client'

export type QueryObject = Schemas['QueryObject-Input']
export type Condition = NonNullable<QueryObject['where']>
export type Symbology = NonNullable<QueryObject['symbology']>
export type Column = NonNullable<QueryObject['columns']>[number]
export type AttributeJoin = Schemas['AttributeJoin']
export type Aggregate = Schemas['Aggregate']
export type GeoJSONGeometry = Schemas['GeoJSONGeometry']
export type Scalar = string | number | boolean
export type Id = string

// --- displayed layers (F-4.1) ---------------------------------------------------

/** A derived layer is a recipe, recomputed when shown (design decision; plan D7). */
export type Recipe =
  | { op: 'buffer'; layer: string; distance_m: number; onlyFiltered: boolean }
  | { op: 'join'; layer: string; join: AttributeJoin; keepUnmatched: boolean }
  | { op: 'aggregate'; layer: string; aggregate: Aggregate }

export type LayerSource =
  { kind: 'catalog'; layer: string } | { kind: 'derived'; name: string; recipe: Recipe }

export interface DisplayLayer {
  id: Id
  source: LayerSource
  visible: boolean
  /** 0..1 */
  opacity: number
  symbology: Symbology | null
}

// --- conditions (F-4.2 to F-4.4, design B2) -----------------------------------------

export type AttributeOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'between'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'in'

export interface AttributeRow {
  id: Id
  kind: 'attribute'
  not: boolean
  attr: string
  operator: AttributeOperator
  value: Scalar | null
  /** Numbers, or ISO dates "YYYY-MM-DD" for a date field (plan E1.8, G3). */
  min: number | string | null
  max: number | string | null
  values: Scalar[]
}

/** Relations to another layer; "outside" and "far" are negations (schema v1). */
export type SpatialOperator = 'in' | 'outside' | 'intersects' | 'contains' | 'near' | 'far'

export interface SpatialRow {
  id: Id
  kind: 'spatial'
  not: boolean
  operator: SpatialOperator
  layer: string
  distance_m: number | null
  /** Condition on the related layer's own attributes, e.g. "Anteil > 20 %". */
  filter: AttributeRow | null
}

/** Within a distance of one chosen feature (F-4.3 "Bezugsobjekt"). */
export interface ReferenceRow {
  id: Id
  kind: 'reference'
  not: boolean
  layer: string
  fid: number | null
  label: string
  distance_m: number
}

export interface Group {
  id: Id
  kind: 'group'
  op: 'and' | 'or'
  not: boolean
  children: Node[]
}

export type Row = AttributeRow | SpatialRow | ReferenceRow
export type Node = Group | Row

/** "Nur in: Ausschnitt / Fläche" (design B1, F-4.3). */
export type Restriction =
  | null
  | { kind: 'view'; bbox: [number, number, number, number] }
  | { kind: 'shape'; geometry: GeoJSONGeometry }

export interface Analysis {
  layers: DisplayLayer[]
  /** Id of the displayed layer the query is about: exactly one per session (design B1). */
  result: Id | null
  tree: Group
  restriction: Restriction
}

// --- saved queries (plan E1.7b) --------------------------------------------------------

/** The part of the analysis a saved query holds: result layer, conditions, restriction. */
export interface QueryPart {
  /** Catalog layer name (plan E1.7b, Q2). */
  result: string
  tree: Group
  restriction: Restriction
}

/** The saved query the current one came from (plan E1.7b, Q6; design C7 "gespeicherteAbfrage"). */
export interface QueryRef {
  id: string
  name: string
  mine: boolean
  shared: boolean
  /** The query part as saved, to tell whether it has changed since. */
  snapshot: string
}

// --- attribute table (F-8.2, design B8) -------------------------------------------------

export interface SortKey {
  attr: string
  dir: 'asc' | 'desc'
}

/** Column choice of one layer: an order and what is hidden, so new columns still appear. */
export interface ColumnChoice {
  order: string[]
  hidden: string[]
}

/** Saved with the session (design C7); changing columns or sort marks it unsaved. */
export interface TableState {
  /** Displayed layer whose tab is open; the result layer when null. */
  tab: Id | null
  mode: 'hits' | 'all'
  /** "nur aktueller Kartenausschnitt": display only, never a filter. */
  onlyView: boolean
  columns: Record<Id, ColumnChoice>
  sort: Record<Id, SortKey[]>
}
