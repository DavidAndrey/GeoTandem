"""The v0 tools. Tool-chain steps (E2.5) join this registry as tools of the
form ``(QueryObject, arguments) → QueryObject``, so every chain stays
expressible as one query object (F-5.7)."""

from pydantic import BaseModel, Field

from geotandem.catalog import LayerInfo, get_layer, list_layers
from geotandem.engine import QueryResult, run_query
from geotandem.engine.errors import UnknownLayer
from geotandem.levels import OpClass
from geotandem.tools.registry import Tool, ToolContext, ToolRegistry
from geotandem_query import QueryObject


class NoArguments(BaseModel):
    pass


class LayerSummary(BaseModel):
    name: str
    title: str
    kind: str
    geometry_type: str | None
    feature_count: int


class LayerList(BaseModel):
    layers: list[LayerSummary]


class LayerName(BaseModel):
    layer: str = Field(description="Name of the layer, as returned by list_layers.")


class RunQueryArguments(BaseModel):
    query: QueryObject


def _list_layers(context: ToolContext, _: NoArguments) -> LayerList:
    return LayerList(
        layers=[
            LayerSummary.model_validate(info.model_dump())
            for info in list_layers(context.backend.engine, only=context.backend.layer_names())
        ]
    )


def _describe_layer(context: ToolContext, args: LayerName) -> LayerInfo:
    visible = args.layer in context.backend.layer_names()
    info = get_layer(context.backend.engine, args.layer) if visible else None
    if info is None:
        raise UnknownLayer(f"Unknown layer '{args.layer}'.", layer=args.layer)
    return info


def _run_query(context: ToolContext, args: RunQueryArguments) -> QueryResult:
    return run_query(args.query, context.backend, context.limits, context.unsupported)


def default_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="list_layers",
            description="List all layers with kind, geometry type and feature count.",
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
            output_model=LayerInfo,
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
