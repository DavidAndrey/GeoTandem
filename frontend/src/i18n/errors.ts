// The back end's codes in words (plan E1.9, L6): every code in
// error-codes.json has a message here, filled from its details. The back
// end's English text stays for logs and API clients; it shows only for a
// code this version does not know yet.
import { plural, t } from '@lingui/core/macro'
import { MIN_PASSWORD_LENGTH } from '../auth/rules'
import { formatNumber } from './locale'

export type Details = Record<string, unknown>

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))
const list = (value: unknown) =>
  Array.isArray(value) ? value.map((v) => `„${String(v)}"`).join(', ') : text(value)
const number = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : text(value))

type Words = (details: Details, count: number) => string

const MESSAGES: Record<string, Words> = {
  // Requests
  bad_request: () => t`Die Anfrage wurde abgelehnt.`,
  not_found: (d) => {
    const name = text(d.layer ?? d.session ?? d.query ?? d.import_id ?? d.run_id)
    return name ? t`„${name}" gibt es nicht (mehr).` : t`Das Gesuchte gibt es nicht (mehr).`
  },
  schema_violation: () => t`Die Anfrage hat nicht die erwartete Form.`,
  unknown_tool: () => t`Dieses Werkzeug gibt es nicht.`,
  busy: () =>
    t`Gerade sind zu viele Anfragen gleichzeitig unterwegs. Bitte gleich nochmals versuchen.`,
  request_too_large: (d) => {
    const mb = number(d.max_mb)
    return t`Die Anfrage ist grösser als ${mb} MB.`
  },
  upload_too_large: (d) => {
    const mb = number(d.max_mb)
    return t`Die Datei ist grösser als ${mb} MB.`
  },
  // Access
  not_authenticated: () =>
    t`Benutzername oder Passwort stimmt nicht, das Konto ist gesperrt, oder die Anmeldung ist abgelaufen.`,
  password_change_required: () => t`Bitte zuerst das Startpasswort ändern.`,
  forbidden: () => t`Dafür braucht es die Rolle Administrator.`,
  cross_origin: () => t`Anfragen von anderen Seiten werden nicht angenommen.`,
  setup_closed: () => t`Die Anwendung ist bereits eingerichtet.`,
  setup_token_invalid: () => t`Der Einrichtungscode stimmt nicht.`,
  too_many_attempts: () =>
    t`Zu viele fehlgeschlagene Anmeldungen. Bitte etwas warten und dann nochmals versuchen.`,
  invalid_username: () =>
    t`Ein Benutzername hat 2 bis 63 Zeichen: Kleinbuchstaben, Ziffern, „.", „_" und „-".`,
  username_taken: () => t`Diesen Benutzernamen gibt es schon.`,
  unknown_user: () => t`Dieses Konto gibt es nicht.`,
  last_admin: () =>
    t`Der letzte aktive Administrator kann nicht herabgestuft, gesperrt oder gelöscht werden.`,
  wrong_password: () => t`Das aktuelle Passwort stimmt nicht.`,
  password_too_short: () => {
    const min = number(MIN_PASSWORD_LENGTH)
    return t`Das Passwort braucht mindestens ${min} Zeichen.`
  },
  password_too_long: () => t`Das Passwort ist zu lang.`,
  password_common: () =>
    t`Dieses Passwort ist zu verbreitet: Es gehört zu den ersten, die ausprobiert werden, auch mit angehängten Zahlen oder Zeichen.`,
  password_pattern: () =>
    t`Das Passwort ist eine Tastaturreihe, eine Folge oder eine Wiederholung und leicht zu erraten.`,
  password_contains_name: () =>
    t`Das Passwort darf weder den Benutzernamen noch den Anzeigenamen noch «GeoTandem» enthalten.`,
  password_unchanged: () => t`Das neue Passwort muss sich vom alten unterscheiden.`,
  // Queries
  invalid_query: () => t`Die Abfrage kann so nicht ausgeführt werden.`,
  unknown_layer: (d) => {
    const layer = text(d.layer)
    return layer
      ? t`Den Layer „${layer}" gibt es nicht oder er ist nicht sichtbar.`
      : t`Ein Layer fehlt oder ist nicht sichtbar.`
  },
  unknown_attribute: (d) => {
    const attribute = text(d.attribute)
    return t`Das Feld „${attribute}" gibt es nicht.`
  },
  unsupported_operation: () => t`Diese Operation geht hier nicht.`,
  result_too_large: (d) => {
    const max = number(d.max_features)
    return t`Das Ergebnis hat mehr als ${max} Objekte. Bitte die Abfrage enger fassen.`
  },
  query_timeout: () => t`Die Abfrage hat zu lange gedauert und wurde abgebrochen.`,
  query_too_complex: () => t`Die Abfrage ist zu umfangreich.`,
  invalid_query_geometry: () =>
    t`Die gezeichnete Fläche ist ungültig, zum Beispiel weil sie sich selbst schneidet.`,
  name_clash: (d) => {
    const attribute = text(d.attribute)
    return t`Der Name „${attribute}" ist schon vergeben; bitte einen anderen Namen oder ein Präfix wählen.`
  },
  key_type_mismatch: () => t`Die beiden Schlüssel sind verschiedenen Typs (Text und Zahl).`,
  attribute_not_text: (d) => {
    const attribute = text(d.attribute)
    return t`Das Feld „${attribute}" ist kein Text.`
  },
  attribute_not_numeric: (d) => {
    const attribute = text(d.attribute)
    return t`Das Feld „${attribute}" ist keine Zahl.`
  },
  wrong_value_type: (d) => {
    const attribute = text(d.attribute)
    return d.expected === 'date'
      ? t`Das Feld „${attribute}" erwartet ein Datum.`
      : t`Der Wert passt nicht zum Feld „${attribute}".`
  },
  // Sessions and saved queries
  name_taken: () => t`Diesen Namen gibt es schon.`,
  state_too_large: () => t`Der Stand ist zu gross, um gespeichert zu werden.`,
  too_many_sessions: () =>
    t`Es sind schon so viele Sitzungen gespeichert wie erlaubt. Bitte zuerst eine löschen.`,
  too_many_saved_queries: () =>
    t`Es sind schon so viele Abfragen gespeichert wie erlaubt. Bitte zuerst eine löschen.`,
  conditions_only: () =>
    t`Eine gespeicherte Abfrage enthält Bedingungen auf einem Katalog-Layer; Puffer, Join und Aggregation gehören zu abgeleiteten Layern.`,
  not_owner: () =>
    t`Eine geteilte Abfrage ändert nur, wer sie gespeichert hat; bitte als eigene Kopie speichern.`,
  // Levels of model support
  level_count: (d) => {
    const min = number(d.min)
    const max = number(d.max)
    return t`Es braucht mindestens ${min} und höchstens ${max} Stufen.`
  },
  level_name_taken: (d) => {
    const name = text(d.name)
    return t`Zwei Stufen heissen „${name}"; jede braucht einen eigenen Namen.`
  },
  default_level_count: () => t`Genau eine Stufe muss voreingestellt sein.`,
  default_not_selectable: (d) => {
    const name = text(d.name)
    return t`Die voreingestellte Stufe „${name}" muss für Anwender wählbar sein.`
  },
  level_not_available: () => t`Diese Stufe steht nicht zur Wahl.`,
  // Model connections
  connection_name_taken: (d) => {
    const name = text(d.name)
    return t`Eine Anbindung „${name}" gibt es schon.`
  },
  default_not_enabled: () => t`Die voreingestellte Anbindung muss für Anwender freigegeben sein.`,
  default_connection_required: () =>
    t`Solange andere Anbindungen freigegeben sind, braucht es eine voreingestellte. Bitte zuerst eine andere voreinstellen.`,
  data_release_unconfirmed: () =>
    t`Datenfreigabe an eine externe Anbindung braucht eine ausdrückliche Bestätigung.`,
  connection_not_available: () => t`Diese Anbindung steht nicht zur Wahl.`,
  credentials_unreadable: () =>
    t`Der gespeicherte Zugangsschlüssel lässt sich nicht mehr öffnen (secret.key fehlt oder wurde ersetzt). Bitte neu eintragen.`,
  llm_invalid_url: () =>
    t`Die Adresse muss mit http:// oder https:// beginnen, einen Host nennen und darf keine Zugangsdaten enthalten.`,
  llm_unreachable: () => t`Das Modell ist nicht erreichbar.`,
  llm_timeout: () => t`Das Modell hat nicht rechtzeitig geantwortet.`,
  llm_redirect: () =>
    t`Die Adresse leitet weiter; Weiterleitungen werden nicht befolgt. Bitte die endgültige Adresse eintragen.`,
  llm_unauthorized: () => t`Der Zugangsschlüssel wurde abgelehnt.`,
  llm_not_found: () => t`Diese Adresse oder dieses Modell gibt es dort nicht.`,
  llm_rate_limited: () => t`Das Modell nimmt gerade keine weiteren Anfragen an.`,
  llm_server_error: () => t`Beim Modell ist ein Fehler aufgetreten.`,
  llm_rejected: () => t`Das Modell hat die Anfrage abgelehnt.`,
  llm_bad_response: () => t`Die Antwort des Modells hat nicht die erwartete Form.`,
  llm_model_missing: (d) => {
    const model = text(d.model)
    const offered = list(d.offered) || '–'
    return t`Das Modell „${model}" wird dort nicht angeboten. Angeboten: ${offered}.`
  },
  llm_schema_unsupported: () =>
    t`Das Modell liefert keine Antwort im verlangten JSON-Schema; für Direktabfragen ist es so nicht geeignet.`,
  llm_tools_unsupported: () =>
    t`Das Modell ruft keine Werkzeuge auf; für Werkzeugketten ist es so nicht geeignet.`,
  // Import: refusals
  unreadable_source: () => t`Die Datei kann so nicht gelesen werden.`,
  too_many_pending_imports: () =>
    t`Zu viele hochgeladene Dateien warten auf ihren Import. Bitte zuerst einen abschliessen.`,
  invalid_layer_name: (d) => {
    const name = text(d.name)
    return t`„${name}" ist kein gültiger Layername.`
  },
  layer_exists: (d) => {
    const layer = text(d.layer)
    return layer ? t`Einen Layer „${layer}" gibt es schon.` : t`Diesen Layernamen gibt es schon.`
  },
  unsupported_format: () =>
    t`Dieses Format wird nicht unterstützt. Möglich sind GeoJSON, Shapefile (als ZIP), GeoPackage, CSV und Excel.`,
  unreadable: () => t`Die Datei ist beschädigt oder hat ein anderes Format.`,
  unreadable_encoding: () => t`Die Datei lässt sich mit dieser Kodierung nicht lesen.`,
  too_slow: () => t`Das Lesen der Datei hat zu lange gedauert und wurde abgebrochen.`,
  too_large: () => t`Die Datei braucht zum Lesen mehr Speicher, als ein Import haben darf.`,
  no_layers: () => t`Die Datei enthält keinen Layer.`,
  empty: () => t`Die Datei enthält keine Zeilen.`,
  unknown_sublayer: (d) => {
    const sublayer = text(d.sublayer)
    return t`Die Datei hat keinen Layer und kein Tabellenblatt „${sublayer}".`
  },
  archive_too_many_entries: () => t`Das Archiv enthält zu viele Dateien.`,
  archive_encrypted: () => t`Das Archiv ist verschlüsselt und kann nicht gelesen werden.`,
  archive_nested: () => t`Das Archiv enthält ein weiteres Archiv; bitte dieses zuerst entpacken.`,
  archive_too_large: () => t`Das Archiv ist entpackt grösser als erlaubt.`,
  no_importable_rows: () => t`Keinem Datensatz lässt sich eine Geometrie zuordnen.`,
  no_geometry_in_source: () => t`Eine Tabelle braucht Koordinatenspalten oder einen Schlüssel.`,
  coordinates_not_numeric: (d) => {
    const column = text(d.column)
    return t`Die Spalte „${column}" enthält keine Zahlen.`
  },
  invalid_key_target: (d) => {
    const layer = text(d.layer)
    const attribute = text(d.attribute)
    return t`„${layer}.${attribute}" ist kein Feld eines Layers mit Geometrie.`
  },
  unknown_column: (d) => {
    const columns = list(d.columns)
    return t`Unbekannte Spalten: ${columns}.`
  },
  duplicate_attribute: (d) => {
    const name = text(d.name)
    return t`Den Feldnamen „${name}" gibt es zweimal.`
  },
  invalid_name: (d) => {
    const name = text(d.name)
    return t`„${name}" ist kein gültiger Name: Kleinbuchstaben, Ziffern und Unterstriche, am Anfang keine Ziffer.`
  },
  internal_error: () => t`Der Vorgang wurde unerwartet abgebrochen.`,
  interrupted: () => t`Die Anwendung wurde während des Imports beendet.`,
  // Import: findings
  stored_as_text: (d) => {
    const column = text(d.column)
    return t`Die Spalte „${column}" wird als Text gespeichert.`
  },
  times_as_text: (d) => {
    const column = text(d.column)
    return t`Die Spalte „${column}" enthält Uhrzeiten; sie werden als Text gespeichert.`
  },
  duplicate_header: (d) => {
    const columns = list(d.columns)
    return t`Gleich benannte Spalten werden mit einer Nummer unterschieden: ${columns}.`
  },
  ragged_rows: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Zeile hat eine andere Anzahl Felder als die Kopfzeile.`,
      other: `${count} Zeilen haben eine andere Anzahl Felder als die Kopfzeile.`,
    })
  },
  single_column: () =>
    t`Es wurde nur eine Spalte gefunden; vielleicht stimmt das Trennzeichen nicht.`,
  encoding_fallback: () => t`Die Datei ist nicht UTF-8; sie wurde als Windows-1252 gelesen.`,
  no_geo_reference_found: () =>
    t`Weder Koordinatenspalten noch ein passender Gebietsschlüssel wurden erkannt; bitte den Raumbezug wählen.`,
  no_rows: () => t`Die Datei enthält keine Datensätze.`,
  no_geometry: () => t`Kein Datensatz hat eine Geometrie.`,
  missing_geometry: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Datensatz hat keine Geometrie und wird nicht importiert.`,
      other: `${count} Datensätze haben keine Geometrie und werden nicht importiert.`,
    })
  },
  invalid_geometry: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Geometrie ist ungültig und wird repariert.`,
      other: `${count} Geometrien sind ungültig und werden repariert.`,
    })
  },
  mixed_geometry_types: () =>
    t`Die Datei mischt Geometrietypen; der Layer erhält einen allgemeinen Geometrietyp.`,
  crs_unknown: () => t`Das Koordinatensystem ist nicht erkennbar; bitte wählen.`,
  repaired: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Geometrie wurde repariert.`,
      other: `${count} Geometrien wurden repariert.`,
    })
  },
  rejected_rows: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Datensatz wurde nicht importiert.`,
      other: `${count} Datensätze wurden nicht importiert.`,
    })
  },
  ambiguous_key_target: (d, n) => {
    const layer = text(d.layer)
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Schlüsselwert kommt in „${layer}" mehrfach vor; das erste Objekt gilt.`,
      other: `${count} Schlüsselwerte kommen in „${layer}" mehrfach vor; das erste Objekt gilt.`,
    })
  },
  duplicate_keys: (_, n) => {
    const count = formatNumber(n)
    return plural(n, {
      one: `${count} Zeile wiederholt einen Schlüssel; sie teilt dessen Geometrie.`,
      other: `${count} Zeilen wiederholen einen Schlüssel; sie teilen dessen Geometrie.`,
    })
  },
}

// Why one row of an import was rejected (design D7: the table of rejected rows).
const REASONS: Record<string, () => string> = {
  outside_crs: () => t`Koordinaten ausserhalb des Koordinatensystems`,
  missing_coordinates: () => t`keine Koordinaten`,
  missing_geometry: () => t`keine Geometrie`,
  invalid_geometry: () => t`ungültige Geometrie`,
  missing_key: () => t`kein Schlüsselwert`,
  key_not_found: () => t`Schlüssel ohne Treffer im Ziel-Layer`,
}

export const rejectReason = (code: string) => REASONS[code]?.() ?? code

/** The codes this interface can word; a test holds them against error-codes.json. */
export const KNOWN_CODES = [...new Set([...Object.keys(MESSAGES), ...Object.keys(REASONS)])]

/** A code in words. ``fallback`` (the back end's English) only for an unknown code. */
export function errorText(code: string, details: Details = {}, fallback?: string): string {
  // A refused file names its reason as a code of its own.
  if (
    code === 'unreadable_source' &&
    typeof details.reason === 'string' &&
    MESSAGES[details.reason]
  )
    return errorText(details.reason, details)
  const words = MESSAGES[code]
  if (words) return words(details, typeof details.count === 'number' ? details.count : 0)
  return fallback ?? t`Unerwarteter Fehler (${code}).`
}

/** An import finding or failure (design D6, D7) in words. */
export function messageText(message: {
  code: string
  message: string
  column?: string | null
  count?: number | null
  details?: Details
}): string {
  const details: Details = { ...message.details }
  if (message.column) details.column = message.column
  if (typeof message.count === 'number') details.count = message.count
  return errorText(message.code, details, message.message)
}
