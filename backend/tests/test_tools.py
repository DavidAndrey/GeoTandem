import pytest
from pydantic import ValidationError

from geotandem.catalog import LayerInfo
from geotandem.data import DataBackend, Limits
from geotandem.engine import QueryError, QueryResult
from geotandem.tools import ToolContext, UnknownTool, default_registry
from geotandem.tools.builtin import LayerList


@pytest.fixture
def context(sample: DataBackend) -> ToolContext:
    return ToolContext(sample, Limits(max_features=1000, timeout_s=10))


def test_registry_describes_tools_with_json_schemas() -> None:
    descriptions = {d.name: d for d in default_registry().describe()}
    assert set(descriptions) == {"list_layers", "describe_layer", "run_query"}
    run_query = descriptions["run_query"]
    assert run_query.effect == "state"
    # The query-object schema is embedded, not re-described (single source).
    assert "QueryObject" in run_query.input_schema["$defs"]


def test_list_and_describe_layers(context: ToolContext) -> None:
    registry = default_registry()
    layers = registry.get("list_layers").call(context, {})
    assert isinstance(layers, LayerList)
    assert [layer.name for layer in layers.layers] == [
        "bevoelkerung", "gemeinden", "gewaesser", "schulen", "strassen",
    ]  # fmt: skip
    info = registry.get("describe_layer").call(context, {"layer": "schulen"})
    assert isinstance(info, LayerInfo)
    assert info.attributes[2].label == "Schülerzahl"


def test_run_query_tool_uses_the_engine(context: ToolContext) -> None:
    result = (
        default_registry()
        .get("run_query")
        .call(context, {"query": {"source": "schulen", "limit": 2}})
    )
    assert isinstance(result, QueryResult)
    assert len(result.features) == 2


def test_invalid_arguments_and_unknown_things_are_rejected(context: ToolContext) -> None:
    registry = default_registry()
    with pytest.raises(ValidationError):
        registry.get("run_query").call(context, {"query": {"source": "schulen", "sql": "x"}})
    with pytest.raises(QueryError):
        registry.get("describe_layer").call(context, {"layer": "nope"})
    with pytest.raises(UnknownTool):
        registry.get("drop_table")
