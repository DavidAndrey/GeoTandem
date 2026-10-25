"""Schema migrations (F-2.17): every revision carries existing data along."""

import json
from typing import Any

import pytest
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Engine, inspect, text
from sqlalchemy.exc import IntegrityError

from geotandem.config import Settings
from geotandem.db import migrate
from geotandem.db.engine import make_engine
from geotandem.db.orm import Base


def _include(obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any) -> bool:
    if type_ == "table":
        return name in Base.metadata.tables
    return True


def test_orm_matches_migrations(settings: Settings) -> None:
    """The ORM and the migration chain describe the same schema."""
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"include_object": _include})
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_upgrade_from_e12_keeps_layers_and_attributes(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine, "0001")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO layer (id, name, title, description, kind, feature_count, source)"
                " VALUES (1, 'old', 'Alt', '', 'table', 0, '')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO layer_attribute"
                " (layer_id, name, position, data_type, label, description)"
                " VALUES (1, 'code', 0, 'integer', 'Code', '')"
            )
        )

    migrate.upgrade(engine)

    with engine.connect() as conn:
        layer = conn.execute(text("SELECT for_model, updated_at FROM layer")).one()
        attribute = conn.execute(
            text('SELECT label, for_model, "references" FROM layer_attribute')
        ).one()
    assert layer.for_model == 1 and layer.updated_at is not None
    assert tuple(attribute) == ("Code", 1, None)


def test_downgrade_to_e12_keeps_attributes(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO layer (id, name, title, description, kind, feature_count, source)"
                " VALUES (1, 'old', 'Alt', '', 'table', 0, '')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO layer_attribute"
                " (layer_id, name, position, data_type, label, description)"
                " VALUES (1, 'code', 0, 'integer', 'Code', '')"
            )
        )

    migrate.downgrade(engine, "0001")

    assert "import_run" not in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM layer_attribute")) == 1


def test_upgrade_to_e20_seeds_levels_and_keeps_accounts(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine, "0005")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password) VALUES ('anna', 'Anna', 'x', 'user', 'active', 0)"
            )
        )

    migrate.upgrade(engine)

    with engine.connect() as conn:
        assert conn.execute(text("SELECT username, level_id FROM app_user")).one() == ("anna", None)
        assert conn.scalar(text("SELECT count(*) FROM level")) == 3
        assert conn.scalar(text("SELECT count(*) FROM level_permission")) == 15


def test_a_deleted_level_clears_the_choice(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        level_id = conn.scalar(text("SELECT id FROM level WHERE name = 'Assistenz'"))
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password, level_id)"
                " VALUES ('anna', '', 'x', 'user', 'active', 0, :id)"
            ),
            {"id": level_id},
        )
        conn.execute(text("DELETE FROM level WHERE id = :id"), {"id": level_id})
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT level_id FROM app_user")) is None
        assert (
            conn.scalar(
                text("SELECT count(*) FROM level_permission WHERE level_id = :id"), {"id": level_id}
            )
            == 0
        )


def test_downgrade_from_e20_keeps_accounts(settings: Settings) -> None:
    engine = make_engine(settings)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_user (username, display_name, password_hash, role, status,"
                " must_change_password, level_id) VALUES ('anna', '', 'x', 'user', 'active', 0, 1)"
            )
        )

    migrate.downgrade(engine, "0005")

    assert "level" not in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT username FROM app_user")) == "anna"


# --- rows that hang on an account (batch rebuilds of app_user) ------------------

CHILDREN = {
    "app_user": "SELECT id, username FROM app_user",
    "auth_session": "SELECT id, user_id, token_hash FROM auth_session",
    "analysis_session": "SELECT id, owner_id, name FROM analysis_session",
    "saved_query": "SELECT id, owner_id, name FROM saved_query",
}


def _seed_accounts_with_children(engine: Engine) -> None:
    """Two accounts, each with a login, a session and a saved query (revision 0005)."""
    with engine.begin() as conn:
        for n, name in enumerate(("anna", "beat"), start=1):
            conn.execute(
                text(
                    "INSERT INTO app_user (id, username, display_name, password_hash, role,"
                    " status, must_change_password) VALUES (:id, :name, '', 'x', 'user',"
                    " 'active', 0)"
                ),
                {"id": n, "name": name},
            )
            conn.execute(
                text(
                    "INSERT INTO auth_session (token_hash, user_id, expires_at)"
                    " VALUES (:token, :id, '2030-01-01 00:00:00')"
                ),
                {"token": f"{n:064d}", "id": n},
            )
            conn.execute(
                text(
                    "INSERT INTO analysis_session (id, owner_id, name, note, state_version,"
                    " state) VALUES (:sid, :id, 'Sitzung', '', 1, '{}')"
                ),
                {"sid": f"s{n}", "id": n},
            )
            conn.execute(
                text(
                    "INSERT INTO saved_query (id, owner_id, name, shared, state_version, state,"
                    " query, layers) VALUES (:qid, :id, 'Abfrage', 0, 1, '{}', :query, :layers)"
                ),
                {"qid": f"q{n}", "id": n, "query": '{"source": "s"}', "layers": '["s"]'},
            )


def _children(engine: Engine) -> dict[str, list[tuple[Any, ...]]]:
    with engine.connect() as conn:
        return {
            table: sorted(tuple(row) for row in conn.execute(text(sql)))
            for table, sql in CHILDREN.items()
        }


def test_migrations_keep_the_rows_of_every_account(settings: Settings) -> None:
    """0006 and 0007 rebuild app_user; on SQLite that must not delete or null the
    rows that refer to it (ON DELETE CASCADE / SET NULL)."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0005")
    _seed_accounts_with_children(engine)
    before = _children(engine)
    assert all(len(rows) == 2 for rows in before.values())

    migrate.upgrade(engine)
    assert _children(engine) == before

    with engine.begin() as conn:
        conn.execute(text("UPDATE app_user SET level_id = (SELECT min(id) FROM level)"))
    migrate.downgrade(engine, "0006")
    assert _children(engine) == before
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM app_user WHERE level_id IS NULL")) == 0

    migrate.downgrade(engine, "0005")
    assert _children(engine) == before
    migrate.upgrade(engine)
    assert _children(engine) == before


def test_a_migration_that_breaks_a_reference_fails(settings: Settings) -> None:
    """Keys are not enforced while migrating; the check afterwards still is."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0005")
    _seed_accounts_with_children(engine)
    with engine.connect() as conn:
        raw = conn.connection.driver_connection
        assert raw is not None
        raw.execute("PRAGMA foreign_keys = OFF")
        raw.execute("DELETE FROM app_user WHERE id = 2")
        raw.execute("PRAGMA foreign_keys = ON")
    with pytest.raises(RuntimeError, match="foreign key"):
        migrate.upgrade(engine, "0006")


def test_a_rebuild_keeps_the_references_of_model_actions(settings: Settings) -> None:
    """Like 0006/0007 did to app_user, a later migration may rebuild app_user or
    model_action: the records keep their account and their thread (P6, compare_of)."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0005")
    _seed_accounts_with_children(engine)
    migrate.upgrade(engine)
    with engine.begin() as conn:
        for id, user, parent, compare in [(1, 1, None, None), (2, 1, 1, None), (3, 2, None, 1)]:
            conn.execute(
                text(
                    "INSERT INTO model_action (id, user_id, account, created_at, prompt,"
                    " prompt_hash, approach, status, parent_action_id, compare_of, level_id,"
                    " level_name, level_matrix, level_prompt_hash, connection_id,"
                    " connection_name, connection_model, connection_host,"
                    " connection_locality, profile_hash) VALUES (:id, :user, 'anna',"
                    " '2026-10-10 08:00:00', 'p', 'h', 'direct', 'proposed', :parent,"
                    " :compare, 1, 'Prüfen', '{}', 'h', 1, 'Lokal', 'm', 'localhost',"
                    " 'local', 'h')"
                ),
                {"id": id, "user": user, "parent": parent, "compare": compare},
            )
    actions = "SELECT id, user_id, parent_action_id, compare_of FROM model_action"
    with engine.connect() as conn:
        before = (_children(engine), sorted(tuple(r) for r in conn.execute(text(actions))))

    def rebuild(config: Config) -> None:
        operations = Operations(MigrationContext.configure(config.attributes["connection"]))
        for table in ("app_user", "model_action"):
            with operations.batch_alter_table(table, recreate="always"):
                pass

    migrate._run(engine, rebuild)

    with engine.connect() as conn:
        after = (_children(engine), sorted(tuple(r) for r in conn.execute(text(actions))))
    assert after == before


def test_touched_at_comes_and_goes_with_0010_and_keeps_the_records(settings: Settings) -> None:
    """WP70: the hand edit after a model action (``undo_blocked``) is its own
    revision; 0009 belongs to the tag e2.3 and stays as it was."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0009")
    assert "touched_at" not in {c["name"] for c in inspect(engine).get_columns("model_action")}
    with engine.begin() as conn:
        for id, parent in [(1, None), (2, 1)]:
            conn.execute(
                text(
                    "INSERT INTO model_action (id, account, created_at, prompt, prompt_hash,"
                    " approach, status, parent_action_id, level_id, level_name, level_matrix,"
                    " level_prompt_hash, connection_id, connection_name, connection_model,"
                    " connection_host, connection_locality, profile_hash) VALUES (:id, 'anna',"
                    " '2026-10-10 08:00:00', 'p', 'h', 'direct', 'applied', :parent, 1,"
                    " 'Prüfen', '{}', 'h', 1, 'Lokal', 'm', 'localhost', 'local', 'h')"
                ),
                {"id": id, "parent": parent},
            )
    rows = "SELECT id, parent_action_id, status FROM model_action ORDER BY id"
    with engine.connect() as conn:
        before = [tuple(r) for r in conn.execute(text(rows))]

    migrate.upgrade(engine)
    with engine.begin() as conn:
        untouched = "SELECT count(*) FROM model_action WHERE touched_at IS NULL"
        assert conn.scalar(text(untouched)) == 2
        conn.execute(text("UPDATE model_action SET touched_at = '2026-10-10 09:00:00'"))

    migrate.downgrade(engine, "0009")
    assert "touched_at" not in {c["name"] for c in inspect(engine).get_columns("model_action")}
    with engine.connect() as conn:
        assert [tuple(r) for r in conn.execute(text(rows))] == before


def test_steps_come_and_go_with_0011_and_keep_the_records(settings: Settings) -> None:
    """WP75: a chain's steps are a table of their own, its run time and its
    conversation two columns of the action; existing records are direct
    queries, with no steps and no run time. Steps go with their action."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0010")
    assert "model_action_step" not in inspect(engine).get_table_names()
    action = (
        "INSERT INTO model_action (id, account, created_at, prompt, prompt_hash, approach,"
        " status, level_id, level_name, level_matrix, level_prompt_hash, connection_id,"
        " connection_name, connection_model, connection_host, connection_locality,"
        " profile_hash) VALUES (:id, 'anna', '2026-10-11 08:00:00', 'p', 'h', :approach,"
        " 'proposed', 1, 'Prüfen', '{}', 'h', 1, 'Lokal', 'm', 'localhost', 'local', 'h')"
    )
    with engine.begin() as conn:
        conn.execute(text(action), {"id": 1, "approach": "direct"})
    rows = "SELECT id, approach, status FROM model_action ORDER BY id"
    with engine.connect() as conn:
        before = [tuple(r) for r in conn.execute(text(rows))]

    migrate.upgrade(engine)

    columns = {c["name"] for c in inspect(engine).get_columns("model_action")}
    assert {"run_ms", "turns", "level_prompt"} <= columns
    with engine.begin() as conn:
        assert tuple(conn.execute(text("SELECT run_ms, turns FROM model_action")).one()) == (
            0,
            None,
        )
        conn.execute(text(action), {"id": 2, "approach": "chain"})
        for position in (1, 2):
            conn.execute(
                text(
                    "INSERT INTO model_action_step (action_id, position, text, tool, arguments,"
                    " classes, cell, status, query) VALUES (2, :position, 'Schritt', 'filter',"
                    " '{}', '[\"query\"]', 'approve', 'planned', '{\"source\": \"schulen\"}')"
                ),
                {"position": position},
            )
        twice = text(
            "INSERT INTO model_action_step (action_id, position, text, tool, arguments, classes,"
            " cell, status, query) VALUES (2, 1, 's', 'filter', '{}', '[]', 'auto', 'planned',"
            " '{}')"
        )
        with pytest.raises(IntegrityError), conn.begin_nested():  # one step per position
            conn.execute(twice)
        conn.execute(text("DELETE FROM model_action WHERE id = 2"))
        assert conn.scalar(text("SELECT count(*) FROM model_action_step")) == 0

    migrate.downgrade(engine, "0010")
    assert "model_action_step" not in inspect(engine).get_table_names()
    assert not {"run_ms", "turns", "level_prompt"} & {
        c["name"] for c in inspect(engine).get_columns("model_action")
    }
    with engine.connect() as conn:
        assert [tuple(r) for r in conn.execute(text(rows))] == before
    migrate.upgrade(engine)


def test_re_plan_calls_come_and_go_with_0012(settings: Settings) -> None:
    """Security review #43: a chain's re-plans, one row each, counted for the
    request limit; rows go with their action, the records stay."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0011")
    assert "model_call" not in inspect(engine).get_table_names()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO model_action (id, account, created_at, prompt, prompt_hash,"
                " approach, status, level_id, level_name, level_matrix, level_prompt_hash,"
                " connection_id, connection_name, connection_model, connection_host,"
                " connection_locality, profile_hash) VALUES (1, 'anna', '2026-10-11 08:00:00',"
                " 'p', 'h', 'chain', 'running', 1, 'Prüfen', '{}', 'h', 1, 'Lokal', 'm',"
                " 'localhost', 'local', 'h')"
            )
        )

    migrate.upgrade(engine)

    assert "model_call" in inspect(engine).get_table_names()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO model_call (action_id, connection_id, called_at)"
                " VALUES (1, 1, '2026-10-11 08:01:00')"
            )
        )
        conn.execute(text("DELETE FROM model_action WHERE id = 1"))
        assert conn.scalar(text("SELECT count(*) FROM model_call")) == 0

    migrate.downgrade(engine, "0011")
    assert "model_call" not in inspect(engine).get_table_names()
    migrate.upgrade(engine)


def test_tokens_come_and_go_with_0014_and_keep_the_records(settings: Settings) -> None:
    """WP86: the tokens of a model action are two nullable columns; existing
    records have none."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0013")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO model_action (id, account, created_at, prompt, prompt_hash,"
                " approach, status, level_id, level_name, level_matrix, level_prompt_hash,"
                " connection_id, connection_name, connection_model, connection_host,"
                " connection_locality, profile_hash, latency_ms) VALUES (1, 'anna',"
                " '2026-10-24 08:00:00', 'p', 'h', 'direct', 'proposed', 1, 'Prüfen', '{}',"
                " 'h', 1, 'Lokal', 'm', 'localhost', 'local', 'h', 900)"
            )
        )

    migrate.upgrade(engine)

    tokens = "SELECT latency_ms, prompt_tokens, completion_tokens FROM model_action"
    with engine.begin() as conn:
        assert tuple(conn.execute(text(tokens)).one()) == (900, None, None)
        conn.execute(text("UPDATE model_action SET prompt_tokens = 10, completion_tokens = 2"))

    migrate.downgrade(engine, "0013")
    columns = {c["name"] for c in inspect(engine).get_columns("model_action")}
    assert "latency_ms" in columns and not {"prompt_tokens", "completion_tokens"} & columns
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM model_action")) == 1
    migrate.upgrade(engine)


def test_own_cases_come_and_go_with_0015(settings: Settings) -> None:
    """Plan E3, WP87: own cases in a table of their own, with the list's indexes
    and unique ids; a downgrade removes it and leaves the rest as it was."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0014")
    assert "eval_case" not in inspect(engine).get_table_names()

    migrate.upgrade(engine)

    indexes = {i["name"] for i in inspect(engine).get_indexes("eval_case")}
    assert indexes >= {"ix_eval_case_split", "ix_eval_case_origin", "ix_eval_case_data_state"}
    insert = text(
        "INSERT INTO eval_case (case_id, split, origin, data_state, body, created_at,"
        " updated_at) VALUES ('eigene-1', 'confirm', 'authored', 'sample', '{}',"
        " '2026-10-24 08:00:00', '2026-10-24 08:00:00')"
    )
    with engine.begin() as conn:
        conn.execute(insert)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(insert)

    migrate.downgrade(engine, "0014")
    assert "eval_case" not in inspect(engine).get_table_names()
    assert "model_action" in inspect(engine).get_table_names()
    migrate.upgrade(engine)


PRICES = ("price_input_per_mtok", "price_output_per_mtok", "price_currency")


def test_prompt_profile_and_prices_come_and_go_with_0017(settings: Settings) -> None:
    """Plan E3, WP91: a connection that was there gets today's prompt and no
    price; the table's check keeps the three prices together; a model action
    asked before keeps no profile (null: the default); a downgrade removes the
    five columns and keeps the rows."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0016")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO llm_connection (id, name, base_url, model, temperature,"
                " timeout_s, reasoning_effort, enabled, is_default, may_receive_data,"
                " marked_external) VALUES (1, 'Ollama', 'http://127.0.0.1:11434/v1',"
                " 'qwen3:8b', 0, 120, 'none', 1, 1, 1, 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO model_action (id, account, created_at, prompt, prompt_hash,"
                " approach, status, level_id, level_name, level_matrix, level_prompt_hash,"
                " connection_id, connection_name, connection_model, connection_host,"
                " connection_locality, profile_hash) VALUES (1, 'anna',"
                " '2026-10-25 08:00:00', 'p', 'h', 'direct', 'proposed', 1, 'Prüfen', '{}',"
                " 'h', 1, 'Ollama', 'qwen3:8b', '127.0.0.1', 'local', 'h')"
            )
        )

    migrate.upgrade(engine)

    with engine.connect() as conn:
        assert conn.scalar(text("SELECT prompt_profile FROM model_action")) is None

    row = "SELECT prompt_profile, " + ", ".join(PRICES) + " FROM llm_connection"
    with engine.connect() as conn:
        profile, *prices = conn.execute(text(row)).one()
    assert json.loads(profile) == {
        "examples": "standard",
        "placement": "P0",
        "output": "constrained",
    }
    assert prices == [None, None, None]
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("UPDATE llm_connection SET price_currency = 'CHF'"))
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE llm_connection SET price_input_per_mtok = 1, price_output_per_mtok = 2,"
                " price_currency = 'CHF'"
            )
        )

    migrate.downgrade(engine, "0016")
    columns = {c["name"] for c in inspect(engine).get_columns("llm_connection")}
    assert "model" in columns and not {"prompt_profile", *PRICES} & columns
    assert "prompt_profile" not in {c["name"] for c in inspect(engine).get_columns("model_action")}
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM llm_connection")) == 1
        assert conn.scalar(text("SELECT count(*) FROM model_action")) == 1
    migrate.upgrade(engine)


def test_runs_and_answers_come_and_go_with_0016(settings: Settings) -> None:
    """Plan E3, WP90: a run and its answers in two tables, one answer per case,
    point and seed; a downgrade removes both and keeps the own cases."""
    engine = make_engine(settings)
    migrate.upgrade(engine, "0015")
    assert not {"eval_run", "eval_answer"} & set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO eval_case (case_id, split, origin, data_state, body, created_at,"
                " updated_at) VALUES ('eigene-1', 'confirm', 'authored', 'sample', '{}',"
                " '2026-10-24 08:00:00', '2026-10-24 08:00:00')"
            )
        )

    migrate.upgrade(engine, "0016")

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO eval_run (id, status, scope, data_state, request, label, cases,"
                " points, prices, connection_ids, case_set_hash, reference, progress_total,"
                " started_by, started_at) VALUES (1, 'done', 'quick', 'sample', '{}', '{}',"
                " '[]', '[]', '[null]', ',1,', 'h', 0, 5, 'admin', '2026-10-25 08:00:00')"
            )
        )
    answer = text(
        "INSERT INTO eval_answer (run_id, case_id, point, connection_id, block, seed,"
        " verdict, flags, only_answer, only_reference) VALUES (1, 'eigene-1', 0, 1, 1, 1,"
        " 'pass', '[]', '[]', '[]')"
    )
    with engine.begin() as conn:
        conn.execute(answer)
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(answer)
    with engine.connect() as conn:
        progress, silently = conn.execute(
            text("SELECT progress_done, silently_wrong FROM eval_run, eval_answer")
        ).one()
    assert (progress, silently) == (0, 0)  # the server defaults
    indexes = {i["name"] for i in inspect(engine).get_indexes("eval_run")}
    assert "ix_eval_run_status" in indexes

    migrate.downgrade(engine, "0015")
    assert not {"eval_run", "eval_answer"} & set(inspect(engine).get_table_names())
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT case_id FROM eval_case")) == "eigene-1"
    migrate.upgrade(engine)
