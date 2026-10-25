// The back end's codes in words (plan E1.9, L6): every code in
// error-codes.json has a message here, filled from its details. The back
// end's English text stays for logs and API clients; it shows only for a
// code this version does not know yet.
import { plural, t } from '@lingui/core/macro'
import { MIN_PASSWORD_LENGTH } from '../auth/rules'
import type { OpClass } from '../api/client'
import { classLabel, OP_CLASSES } from '../model/approval/governance'
import { formatNumber } from './locale'

export type Details = Record<string, unknown>

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))
const list = (value: unknown) =>
  Array.isArray(value) ? value.map((v) => `„${String(v)}"`).join(', ') : text(value)
const number = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : text(value))

type Words = (details: Details, count: number) => string

const isOpClass = (value: unknown): value is OpClass => OP_CLASSES.includes(value as OpClass)

const MESSAGES: Record<string, Words> = {
  // Requests
  bad_request: () => t`Die Anfrage wurde abgelehnt.`,
  not_found: (d) => {
    const name = text(d.layer ?? d.session ?? d.query ?? d.import_id ?? d.run_id)
    return name ? t`„${name}" gibt es nicht (mehr).` : t`Das Gesuchte gibt es nicht (mehr).`
  },
  schema_violation: () => t`Die Anfrage hat nicht die erwartete Form.`,
  unknown_tool: () => t`Dieses Werkzeug gibt es nicht.`,
  busy: (d) =>
    // ``running``: the account's previous prompt, an aborted one too, still holds the model.
    d.reason === 'running'
      ? t`Ihre vorige Anfrage ist beim Modell noch nicht zu Ende. Bitte gleich nochmals versuchen.`
      : t`Gerade sind zu viele Anfragen gleichzeitig unterwegs. Bitte gleich nochmals versuchen.`,
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
  session_required: () =>
    t`Das geht nur in einer angemeldeten Sitzung im Browser, nicht mit einem Zugangsschlüssel.`,
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
    // A query's limit (max_features), or a chain's stop with step, value and max.
    const max = number(d.max_features ?? d.max)
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
  default_level_deleted: (d) => {
    const name = text(d.name)
    return t`Die voreingestellte Stufe „${name}" kann nicht entfernt werden. Bitte zuerst eine andere voreinstellen und speichern.`
  },
  level_not_available: () => t`Diese Stufe steht nicht zur Wahl.`,
  class_not_allowed: (d) => {
    const level = text(d.level)
    // The class in the matrix's words (M7), not its key; another part as sent.
    const part = isOpClass(d.op_class) ? classLabel(d.op_class) : text(d.part)
    return t`Auf der Stufe „${level}" ist „${part}" nicht erlaubt.`
  },
  // Modus B: refusals of a model's answer (design M3) and the model routes
  model_query_invalid: () => t`Die Antwort des Modells ist keine gültige Abfrage.`,
  limit_exceeded: (d) => {
    // details.limit says what is counted; so far only conditions (MAX_CONDITIONS).
    const value = number(d.value)
    const max = number(d.max)
    return t`Die Abfrage hat ${value} Bedingungen; im Modus B sind höchstens ${max} möglich.`
  },
  not_representable: () =>
    t`Diese Abfrage lässt sich in den Bedienelementen nicht vollständig darstellen.`,
  step_limit: (d) => {
    const max = number(d.max)
    return t`Die Werkzeugkette braucht mehr als ${max} Schritte.`
  },
  not_implemented: () => t`Dieser Teil der Modellunterstützung ist noch nicht verfügbar.`,
  context_too_large: () =>
    t`Frage, Layer-Steckbrief und Verlauf sind zu lang für das Modell. Bitte ohne Bezug auf frühere Antworten fragen.`,
  stale_reference: (d) => {
    const layer = text(d.layer)
    return t`Die frühere Antwort nutzt den Layer „${layer}", den es nicht mehr gibt.`
  },
  model_unreadable: () => t`Die Antwort des Modells ist nicht lesbar.`,
  // Evaluation of model connections (plan E3)
  case_invalid: (d) => {
    const id = text(d.case_id)
    return id
      ? t`Der Prüffall „${id}" passt nicht: Das Format stimmt nicht, oder seine Referenzabfrage besteht die Prüfung nicht.`
      : t`Ein Prüffall passt nicht: Das Format stimmt nicht, oder seine Referenzabfrage besteht die Prüfung nicht.`
  },
  case_id_taken: (d) => {
    const id = text(d.case_id)
    return t`Einen Prüffall „${id}" gibt es schon.`
  },
  case_read_only: () =>
    t`Fälle des Startbestands lassen sich nicht ändern. Kopieren Sie den Fall in einen eigenen.`,
  case_stale: (d) => {
    const layer = text(d.layer)
    return t`Der Prüffall nutzt den Layer „${layer}", den es nicht mehr gibt oder den Sie nicht sehen. Bearbeiten Sie den Fall zuerst.`
  },
  no_cases: () =>
    t`Keiner der gewählten Prüffälle kann laufen: Keiner passt zur Auswahl, oder alle sind veraltet oder ungültig.`,
  action_not_eligible: (d) =>
    // ``touched`` and ``adjusted``: hand-corrected answers are not taken yet (decision 2).
    d.reason === 'touched' || d.decision === 'adjusted'
      ? t`Diese Antwort wurde von Hand korrigiert. Von Hand korrigierte Antworten werden vorerst nicht zum Prüffall.`
      : t`Nur eine angenommene oder automatisch angewendete, nicht zurückgenommene Direktabfrage wird zum Prüffall.`,
  run_busy: (d) => {
    const run = number(d.run)
    return t`Lauf #${run} läuft noch. Es läuft höchstens ein Lauf zugleich.`
  },
  external_not_confirmed: (d) => {
    const host = text(d.host)
    return t`Der Lauf würde an ${host} senden. Bestätigen Sie das zuerst.`
  },
  runs_not_comparable: () =>
    t`Diese Läufe lassen sich nicht gegenüberstellen: Sie haben andere Prüffälle, oder einer ist nicht vollständig.`,
  model_truncated: () =>
    t`Das Modell hat seine Antwort nicht beendet: Die Länge, die die Anbindung erlaubt, war aufgebraucht. Meist denkt das Modell zu lange, oder der Kontext ist zu klein.`,
  quota_exceeded: (d) => {
    const limit = number(d.limit)
    return t`Die ${limit} Anfragen pro Tag an diese Anbindung sind aufgebraucht. Die Grenze setzt ein Administrator.`
  },
  not_approved: () => t`Dieser Vorschlag ist nicht freigegeben.`,
  already_decided: () => t`Über diesen Vorschlag ist schon entschieden.`,
  nothing_to_undo: () => t`Hier gibt es nichts zurückzunehmen.`,
  nothing_to_compare: () =>
    t`Eine der beiden Antworten hat kein Ergebnis; es gibt nichts zu vergleichen.`,
  repeat_of_repeat: () =>
    t`Diese Antwort ist schon die Wiederholung einer anderen; verglichen wird mit dieser.`,
  undo_blocked: () =>
    t`Die Analyse wurde seither von Hand geändert; die Modelländerung lässt sich nicht mehr zurücknehmen.`,
  time_limit: (d) => {
    const max = number(d.max)
    return t`Die Werkzeugkette lief länger als ${max} Sekunden und wurde angehalten.`
  },
  export_too_large: (d) => {
    const max = number(d.max)
    return t`Der Export umfasst mehr als ${max} Einträge. Bitte den Zeitraum oder die Filter enger wählen.`
  },
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
  connection_not_available: (d) =>
    d.reason === 'none'
      ? t`Es ist keine Modellanbindung eingerichtet.`
      : t`Diese Anbindung steht nicht zur Wahl.`,
  api_key_bound_to_url: () =>
    t`Der gespeicherte Zugangsschlüssel geht nur an die bisherige Adresse. Für eine neue Adresse bitte den Schlüssel neu eintragen oder entfernen.`,
  request_limit_required: () =>
    t`Ist die Begrenzung eingeschaltet, braucht es die Zahl der Anfragen pro Tag.`,
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
  llm_quota_exhausted: () =>
    t`Das Guthaben beim Anbieter des Modells ist aufgebraucht. Eine Administratorin oder ein Administrator muss es aufladen.`,
  llm_server_error: () => t`Beim Modell ist ein Fehler aufgetreten.`,
  llm_rejected: () => t`Das Modell hat die Anfrage abgelehnt.`,
  llm_bad_response: () => t`Die Antwort des Modells hat nicht die erwartete Form.`,
  llm_model_missing: (d) => {
    const model = text(d.model)
    return t`Das Modell „${model}" wird dort nicht angeboten.`
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
