"""Command line: ``geotandem <command>``."""

import argparse
import logging
from pathlib import Path

from geotandem.config import get_settings

REPO_ROOT = Path(__file__).resolve().parents[3]


def _schema_export(args: argparse.Namespace) -> None:
    from geotandem_query.export import write

    print(write(args.dir))


def _sample_generate(_: argparse.Namespace) -> None:
    from geotandem.sample.generate import generate

    print(generate()["version"])


def _sample_load(_: argparse.Namespace) -> None:
    from geotandem.data.spatialite import SpatiaLiteBackend
    from geotandem.db.bootstrap import bootstrap
    from geotandem.sample.load import load_sample

    settings = get_settings()
    backend = SpatiaLiteBackend(bootstrap(settings), settings.internal_crs)
    print(", ".join(load_sample(backend)) or "sample dataset already loaded")


def _migrate(_: argparse.Namespace) -> None:
    from geotandem.db.bootstrap import bootstrap

    bootstrap(get_settings())


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(prog="geotandem")
    commands = parser.add_subparsers(required=True)

    migrate = commands.add_parser("migrate", help="create or upgrade the data core")
    migrate.set_defaults(func=_migrate)

    schema = commands.add_parser("schema").add_subparsers(required=True)
    export = schema.add_parser("export", help="write the query-object JSON schema")
    export.add_argument("--dir", type=Path, default=REPO_ROOT / "schema" / "query-object")
    export.set_defaults(func=_schema_export)

    sample = commands.add_parser("sample").add_subparsers(required=True)
    sample.add_parser("generate", help="regenerate the sample files").set_defaults(
        func=_sample_generate
    )
    sample.add_parser("load", help="load the sample dataset").set_defaults(func=_sample_load)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
