// Test data shaped like the backend's responses.
import type { Account, AttributeInfo, LayerInfo, Preview } from '../api/client'

export function attribute(patch: Partial<AttributeInfo> = {}): AttributeInfo {
  return {
    name: 'einwohner',
    data_type: 'integer',
    label: 'einwohner',
    description: '',
    unit: null,
    value_domain: null,
    value_domain_confirmed: true,
    for_model: true,
    references: null,
    ...patch,
  }
}

export function layer(patch: Partial<LayerInfo> = {}): LayerInfo {
  return {
    name: 'gemeinden',
    title: 'Gemeinden',
    description: '',
    kind: 'vector',
    geometry_type: 'Polygon',
    feature_count: 12,
    bbox_wgs84: null,
    source: 'sample:tandemtal',
    dataset_version: 'tandemtal-1',
    for_model: true,
    created_at: '2026-10-03T08:00:00',
    updated_at: '2026-10-03T08:00:00',
    attributes: [attribute()],
    ...patch,
  }
}

export function csvPreview(patch: Partial<Preview> = {}): Preview {
  return {
    format: 'csv',
    file_name: 'messstellen.csv',
    options: { encoding: 'cp1252', delimiter: ';', sublayer: null },
    sublayers: [],
    record_count: 21,
    layer_name: 'messstellen',
    title: 'messstellen',
    geometry_type: null,
    crs: null,
    crs_label: null,
    bbox: null,
    bbox_wgs84: null,
    columns: [
      column('Nr', 'nr', 'integer'),
      column('Höhe ü. M.', 'hoehe_ue_m', 'real'),
      column('E', 'e', 'real'),
      column('N', 'n', 'real'),
    ],
    xy: { x: 'E', y: 'N', crs: 2056 },
    keys: [],
    sample_rows: [{ nr: 1, hoehe_ue_m: 450.5, e: 2600000, n: 1200000 }],
    warnings: [{ code: 'encoding_fallback', message: 'Read as Windows-1252.' }],
    errors: [],
    ...patch,
  }
}

export function vectorPreview(patch: Partial<Preview> = {}): Preview {
  return csvPreview({
    format: 'shapefile',
    file_name: 'gemeinden.zip',
    options: { sublayer: 'gemeinden', encoding: 'UTF-8', delimiter: null },
    sublayers: ['gemeinden'],
    geometry_type: 'Polygon',
    crs: 2056,
    xy: null,
    warnings: [],
    columns: [column('gem_nr', 'gem_nr', 'integer'), column('name', 'name', 'text')],
    ...patch,
  })
}

function column(source_name: string, name: string, data_type: AttributeInfo['data_type']) {
  return {
    source_name,
    name,
    data_type,
    null_count: 0,
    distinct_count: 1,
    samples: [],
    value_domain: null,
  }
}

export function account(patch: Partial<Account> = {}): Account {
  return {
    id: 1,
    username: 'admin',
    display_name: 'Systemverwaltung',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: '2026-10-03T08:00:00',
    last_login_at: '2026-10-03T09:00:00',
    ...patch,
  }
}

/** Routes every signed-in page needs. */
export const signedIn = (patch: Partial<Account> = {}) => ({
  'GET /api/auth/me': account(patch),
  'GET /api/auth/setup': { needs_setup: false, sample_loaded: true },
})
