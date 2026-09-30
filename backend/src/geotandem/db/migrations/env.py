from alembic import context
from geoalchemy2 import alembic_helpers

from geotandem.db.orm import Base

target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):  # type: ignore[no-untyped-def]
    # Only the administrative schema is migrated; layer tables and the
    # SpatiaLite system tables are ignored.
    if type_ == "table":
        return name in target_metadata.tables
    return alembic_helpers.include_object(obj, name, type_, reflected, compare_to)


connection = context.config.attributes["connection"]
context.configure(
    connection=connection,
    target_metadata=target_metadata,
    render_as_batch=True,
    include_object=include_object,
    process_revision_directives=alembic_helpers.writer,
    render_item=alembic_helpers.render_item,
)
with context.begin_transaction():
    context.run_migrations()
