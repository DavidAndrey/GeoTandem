"""Command line: ``geotandem <command>``."""

import argparse
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from geotandem.config import get_settings

if TYPE_CHECKING:
    from sqlalchemy import Engine

REPO_ROOT = Path(__file__).resolve().parents[3]


def _schema_export(args: argparse.Namespace) -> None:
    from geotandem_query.export import write

    print(write(args.dir))


def _sample_update(args: argparse.Namespace) -> None:
    from geotandem.sample.build import build, default_cache, fetch

    cache = args.cache or default_cache()
    if not args.offline:
        fetch(cache)
    print(build(cache)["version"])


def _sample_load(_: argparse.Namespace) -> None:
    from geotandem.data.spatialite import SpatiaLiteBackend
    from geotandem.db.bootstrap import bootstrap
    from geotandem.sample.load import load_sample

    settings = get_settings()
    backend = SpatiaLiteBackend(bootstrap(settings), settings.internal_crs)
    print(", ".join(load_sample(backend)) or "sample dataset already loaded")


def _serve(args: argparse.Namespace) -> None:
    import uvicorn

    uvicorn.run(
        "geotandem.app:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


def _openapi_export(_: argparse.Namespace) -> None:
    from geotandem.app import openapi_document

    print(openapi_document(), end="")


def _migrate(_: argparse.Namespace) -> None:
    from geotandem.db.bootstrap import bootstrap

    bootstrap(get_settings())


def _engine() -> "Engine":
    from geotandem.db.bootstrap import bootstrap

    return bootstrap(get_settings())


def _user_create(args: argparse.Namespace) -> None:
    from getpass import getpass

    from geotandem.auth import accounts

    if args.start_password:
        password, must_change = accounts.generate_password(), True
    else:
        password, must_change = getpass("Password: "), False
        if getpass("Repeat: ") != password:
            raise SystemExit("The passwords differ.")
    try:
        account = accounts.create(
            _engine(),
            args.username,
            password,
            args.role,
            display_name=args.display_name,
            must_change_password=must_change,
        )
    except accounts.AccountError as exc:
        raise SystemExit(exc.message) from None
    print(f"created {account.username} ({account.role})")
    if must_change:
        print(f"start password: {password}  (to be changed at first sign-in)")


def _user_reset(args: argparse.Namespace) -> None:
    from geotandem.auth import accounts

    try:
        password = accounts.reset_password(_engine(), args.username)
    except accounts.AccountError as exc:
        raise SystemExit(exc.message) from None
    print(f"start password: {password}  (to be changed at next sign-in)")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("alembic").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(prog="geotandem")
    commands = parser.add_subparsers(required=True)

    serve = commands.add_parser("serve", help="run the web application")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    serve.set_defaults(func=_serve)

    openapi = commands.add_parser("openapi").add_subparsers(required=True)
    openapi.add_parser("export", help="print the OpenAPI description").set_defaults(
        func=_openapi_export
    )

    migrate = commands.add_parser("migrate", help="create or upgrade the data core")
    migrate.set_defaults(func=_migrate)

    schema = commands.add_parser("schema").add_subparsers(required=True)
    export = schema.add_parser("export", help="write the query-object JSON schema")
    export.add_argument("--dir", type=Path, default=REPO_ROOT / "schema" / "query-object")
    export.set_defaults(func=_schema_export)

    sample = commands.add_parser("sample").add_subparsers(required=True)
    update = sample.add_parser(
        "update", help="download the sources (AGI Kanton Bern) and rebuild the sample files"
    )
    update.add_argument(
        "--offline", action="store_true", help="rebuild from the cached download, no network"
    )
    update.add_argument("--cache", type=Path, help="download cache (default ~/.cache/geotandem)")
    update.set_defaults(func=_sample_update)
    sample.add_parser("load", help="load the sample dataset").set_defaults(func=_sample_load)

    user = commands.add_parser("user", help="manage accounts (E1.4)").add_subparsers(required=True)
    create = user.add_parser("create", help="create an account, e.g. the first administrator")
    create.add_argument("username")
    create.add_argument("--role", choices=["admin", "user"], default="user")
    create.add_argument("--display-name", default="")
    create.add_argument(
        "--start-password",
        action="store_true",
        help="generate a password the user must change, instead of asking for one",
    )
    create.set_defaults(func=_user_create)
    reset = user.add_parser("reset-password", help="set a generated start password")
    reset.add_argument("username")
    reset.set_defaults(func=_user_reset)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
