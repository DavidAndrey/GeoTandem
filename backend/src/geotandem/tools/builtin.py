"""The v0 tools. Tool-chain steps (E2.5) join this registry as tools of the
form ``(QueryObject, arguments) → QueryObject``, so every chain stays
expressible as one query object (F-5.7)."""

from pydantic import BaseModel, Field

from geotandem.catalog import LayerProfile, model_profile
from geotandem.engine import QueryResult, run_query
from geotandem.engine.errors import UnknownLayer
from geotandem.levels import OpClass
from geotandem.tools.registry import Tool, ToolContext, ToolRegistry
from geotandem_query import QueryObject


class NoArguments(BaseModel):
    pass


class LayerSummary(BaseModel):
    """A layer as the model first meets it: no counts, nothing from the rows (S1)."""

    name: str
    title: str
    description: str | None
    kind: str
    geometry_type: str | None


class LayerList(BaseModel):
    layers: list[LayerSummary]


class LayerName(BaseModel):
    layer: str = Field(description="Name of the layer, as returned by list_layers.")


class RunQueryArguments(BaseModel):
    query: QueryObject


def _profiles(context: ToolContext) -> list[LayerProfile]:
    """The layer profile of the account the tools run as (plan E2.2, S3)."""
    return model_profile(context.backend.engine, context.backend.layer_names()).layers


def _list_layers(context: ToolContext, _: NoArguments) -> LayerList:
    return LayerList(
        layers=[
            LayerSummary(
                name=p.name,
                title=p.title,
                description=p.description,
                kind=p.kind,
                geometry_type=p.geometry_type,
            )
            for p in _profiles(context)
        ]
    )


def _describe_layer(context: ToolContext, args: LayerName) -> LayerProfile:
    found = next((p for p in _profiles(context) if p.name == args.layer), None)
    if found is None:
        raise UnknownLayer(f"Unknown layer '{args.layer}'.", layer=args.layer)
    return found


def _run_query(context: ToolContext, args: RunQueryArguments) -> QueryResult:
    return run_query(args.query, context.backend, context.limits, context.unsupported)


def default_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="list_layers",
            description="List the layers you may use, with title, kind and geometry type.",
            input_model=NoArguments,
            output_model=LayerList,
            effect="read",
            op_class=OpClass.CATALOG,
            handler=_list_layers,
        )
    )
    registry.register(
        Tool(
            name="describe_layer",
            description="Describe one layer: attributes with label, type, unit and value domain.",
            input_model=LayerName,
            output_model=LayerProfile,
            effect="read",
            op_class=OpClass.CATALOG,
            handler=_describe_layer,
        )
    )
    registry.register(
        Tool(
            name="run_query",
            description="Run a query object and return the result as GeoJSON.",
            input_model=RunQueryArguments,
            output_model=QueryResult,
            effect="state",
            op_class=OpClass.QUERY,
            handler=_run_query,
        )
    )
    return registry
