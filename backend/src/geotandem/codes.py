"""Every code the application sends in an error body or an import message.

The code is the contract: the interface words it in the user's language from
the code and its ``details`` (plan E1.9, L6), the model will read it (F-5.9).
The English ``message`` next to it is for logs and API clients. A code raised
anywhere must be listed here; ``tests/test_codes.py`` checks both ways, and
``geotandem codes export`` writes the list for the interface.
"""

import json

CODES: dict[str, str] = {
    # Requests
    "bad_request": "The request is not acceptable as sent.",
    "not_found": "The thing asked for does not exist or is not visible.",
    "schema_violation": "The body does not match the schema; details.errors lists where.",
    "unknown_tool": "No tool of that name is registered.",
    "busy": "Too many requests of this kind at once; try again shortly.",
    "request_too_large": "The request exceeds details.max_mb.",
    "upload_too_large": "The uploaded file exceeds details.max_mb.",
    # Access
    "not_authenticated": "Not signed in, or the sign-in failed.",
    "password_change_required": "The start password must be changed first.",
    "forbidden": "The account's role does not allow this.",
    "cross_origin": "Requests from other sites are not accepted.",
    "setup_closed": "The application is already set up.",
    "setup_token_invalid": "The setup code is wrong.",
    "too_many_attempts": "Too many failed sign-ins; wait and try again.",
    "invalid_username": "A username has 2 to 63 lower-case letters, digits, '.', '_', '-'.",
    "username_taken": "The username is taken.",
    "unknown_user": "No account of that name.",
    "last_admin": "The last active administrator cannot be demoted, locked or deleted.",
    "wrong_password": "The current password is wrong.",
    "password_too_short": "The password is shorter than the minimum.",
    "password_too_long": "The password is longer than the maximum.",
    "password_common": "The password is among the commonly used ones.",
    "password_pattern": "The password is a keyboard row, a sequence or a repetition.",
    "password_contains_name": "The password contains the username, display name or product.",
    "password_unchanged": "The new password is the old one.",
    # Queries (the engine)
    "invalid_query": "The query cannot run as written.",
    "unknown_layer": "The layer does not exist or is hidden from the account.",
    "unknown_attribute": "The attribute does not exist on the layer.",
    "unsupported_operation": "The operation does not apply here or the backend lacks it.",
    "result_too_large": "More features than max_features would leave the server.",
    "query_timeout": "The query ran longer than query_timeout_s.",
    "query_too_complex": "The query exceeds the complexity limits.",
    "invalid_query_geometry": "A geometry in the query is malformed or invalid.",
    "name_clash": "A joined, computed or aggregated attribute takes a used name.",
    "key_type_mismatch": "The join keys differ in type.",
    "attribute_not_text": "A text condition on an attribute that is not text.",
    "attribute_not_numeric": "A metric over an attribute that is not numeric.",
    "wrong_value_type": "A condition's value does not fit the attribute's type.",
    # Sessions and saved queries
    "name_taken": "A session or query of that name exists; details.existing is its id.",
    "state_too_large": "The saved state is larger than allowed.",
    "too_many_sessions": "The account has the most sessions allowed.",
    "too_many_saved_queries": "The account has the most saved queries allowed.",
    "conditions_only": "A saved query holds conditions on a catalog layer only.",
    "not_owner": "Only the owner changes a shared query.",
    # Levels of model support
    "level_count": "There must be details.min to details.max levels.",
    "level_name_taken": "Two levels share the name details.name.",
    "default_level_count": "Exactly one level must be the default.",
    "default_not_selectable": "The default level must be selectable by users.",
    "level_not_available": "The level does not exist or users may not choose it.",
    "class_not_allowed": "The level does not allow a part of the action (details.part).",
    # Model connections: administration and choice
    "connection_name_taken": "A connection of that name exists (details.name).",
    "default_not_enabled": "The default connection must be enabled for users.",
    "default_connection_required": "Another enabled connection must become the default first.",
    "data_release_unconfirmed": "Data contents to an external connection need confirmation.",
    "connection_not_available": "The connection is not offered: unknown or disabled.",
    "credentials_unreadable": "A stored API key cannot be opened with this secret.key.",
    "api_key_bound_to_url": "The stored API key goes only to its own address (C8).",
    # Model connections: why a call brought no answer (details.cause, verbatim)
    "llm_invalid_url": "The base URL is not http(s) with a host, or carries credentials.",
    "llm_unreachable": "The model endpoint could not be reached.",
    "llm_timeout": "The model did not answer within the timeout.",
    "llm_redirect": "The endpoint redirected; redirects are not followed.",
    "llm_unauthorized": "The endpoint refused the credentials.",
    "llm_not_found": "The endpoint or the model does not exist.",
    "llm_rate_limited": "The endpoint limits requests; retried and gave up.",
    "llm_server_error": "The endpoint failed (HTTP 5xx).",
    "llm_rejected": "The endpoint rejected the request (HTTP 4xx).",
    "llm_bad_response": "The endpoint's answer is not a valid response.",
    # Connection test: what a reachable endpoint cannot do (C12)
    "llm_model_missing": "The endpoint does not offer the model (details.model).",
    "llm_schema_unsupported": "The answer to a JSON-schema request did not fit the schema.",
    "llm_tools_unsupported": "The model did not call the offered tool.",
    # Import: refusals (details.reason of unreadable_source) and the run
    "unreadable_source": "The file cannot be read as given; details.reason says why.",
    "too_many_pending_imports": "Too many uploaded files wait for their import.",
    "invalid_layer_name": "Not a valid layer name.",
    "layer_exists": "A layer of that name exists.",
    "unsupported_format": "The file format is not supported.",
    "unreadable": "The file is damaged or of another format.",
    "unreadable_encoding": "The file cannot be decoded with the chosen encoding.",
    "too_slow": "Reading the file took too long and was stopped.",
    "too_large": "Reading the file needs more memory than an import may use.",
    "no_layers": "The file contains no layer.",
    "empty": "The file contains no rows.",
    "unknown_sublayer": "The file has no layer or sheet of that name.",
    "archive_too_many_entries": "The archive has too many entries.",
    "archive_encrypted": "The archive is encrypted.",
    "archive_nested": "The archive contains another archive.",
    "archive_too_large": "The archive unpacks to more than allowed.",
    "no_importable_rows": "No record could be given a geometry.",
    "no_geometry_in_source": "A table needs coordinate columns or an area key.",
    "coordinates_not_numeric": "A coordinate column does not hold numbers.",
    "invalid_key_target": "The area key is not an attribute of a geometry layer.",
    "unknown_column": "The decisions name columns the file does not have.",
    "duplicate_attribute": "Two fields would get the same attribute name.",
    "invalid_name": "Not a valid identifier (layer or field name).",
    "internal_error": "The import or copy stopped unexpectedly.",
    "interrupted": "The application stopped during the import.",
    # Import: findings in the preview and the run
    "stored_as_text": "A column is stored as text (details.source_type).",
    "times_as_text": "A column with times of day is stored as text.",
    "duplicate_header": "Columns named alike are told apart by a number.",
    "ragged_rows": "Rows with another number of fields than the header.",
    "single_column": "Only one column; the delimiter may be wrong.",
    "encoding_fallback": "Not UTF-8; read as Windows-1252.",
    "no_geo_reference_found": "No coordinate columns or area key recognised.",
    "no_rows": "The file contains no records.",
    "no_geometry": "No record has a geometry.",
    "missing_geometry": "Records without geometry are not imported.",
    "invalid_geometry": "Invalid geometries will be repaired.",
    "mixed_geometry_types": "The file mixes geometry types.",
    "crs_unknown": "The coordinate reference system is not identifiable.",
    "repaired": "Geometries were repaired.",
    "rejected_rows": "Records were not imported.",
    "ambiguous_key_target": "Key values occur more than once in the target layer.",
    "duplicate_keys": "Rows repeat a key and share a geometry.",
    # Import: why one row was rejected (RejectedRow.reason; also missing_geometry,
    # invalid_geometry above)
    "outside_crs": "The row's coordinates lie outside the coordinate system.",
    "missing_coordinates": "The row has no coordinates.",
    "missing_key": "The row has no key value.",
    "key_not_found": "The row's key matches no feature of the target layer.",
}


def export() -> str:
    """The list for the interface (``frontend/error-codes.json``)."""
    return json.dumps(dict(sorted(CODES.items())), indent=2, ensure_ascii=False) + "\n"
