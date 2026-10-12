"""A code's label written for the code is read as the code (testplan E-2)."""

from typing import Any

import pytest

from geotandem.catalog import AttributeProfile, LayerProfile, ModelProfile
from geotandem.model.labels import as_codes
from geotandem_query import QueryObject, canonical_json


def layer(name: str, **codes: dict[str, str]) -> LayerProfile:
    attributes = [
        AttributeProfile(name=attr, type="text", label=attr, codes=values)
        for attr, values in codes.items()
    ]
    attributes.append(AttributeProfile(name="name", type="text", label="Name"))
    return LayerProfile(name=name, title=name, kind="vector", attributes=attributes)


PROFILE = ModelProfile(
    layers=[
        layer(
            "haltestellen",
            verkehrsmittel={"bahn": "Bahn", "bus": "Bus"},
            kategorie={"I": "I", "II": "II"},
        ),
        layer(
            "schulen",
            typ={"primar": "Primarstufe", "sekundar": "Sekundarstufe I"},
            ambiguous={"a": "x", "b": "X"},
        ),
    ],
    hash="",
    size_chars=0,
    tokens_estimate=0,
)


def query(source: str, where: dict[str, Any]) -> QueryObject:
    return QueryObject.model_validate({"source": source, "where": where})


def eq(attr: str, value: Any, cmp: str = "eq") -> dict[str, Any]:
    return {"op": "compare", "attr": attr, "cmp": cmp, "value": value}


@pytest.mark.parametrize(
    ("written", "read"),
    [
        ("Bahn", "bahn"),  # the label, which here is the code in another case
        ("BAHN", "bahn"),
        ("bahn", "bahn"),  # a code stays
    ],
)
def test_a_label_or_a_code_in_another_case_becomes_the_code(written: str, read: str) -> None:
    found = as_codes(query("haltestellen", eq("verkehrsmittel", written)), PROFILE)
    assert found.where == query("haltestellen", eq("verkehrsmittel", read)).where


def test_a_label_unlike_its_code_becomes_the_code() -> None:
    found = as_codes(query("schulen", eq("typ", "Primarstufe", "ne")), PROFILE)
    assert found.where == query("schulen", eq("typ", "primar", "ne")).where


@pytest.mark.parametrize("written", ["sekundarstufe_i", "Sekundarstufe-I", "sekundarstufe  i"])
def test_words_joined_otherwise_are_the_same_label(written: str) -> None:
    found = as_codes(query("schulen", eq("typ", written)), PROFILE)
    assert found.where == query("schulen", eq("typ", "sekundar")).where


def test_each_value_of_a_list_is_read() -> None:
    written = {"op": "in", "attr": "verkehrsmittel", "values": ["Bahn", "bus", "Tram"]}
    found = as_codes(query("haltestellen", written), PROFILE)
    assert (
        found.where == query("haltestellen", {**written, "values": ["bahn", "bus", "Tram"]}).where
    )


def test_a_relation_filter_is_read_against_the_related_layer() -> None:
    def where(value: str) -> dict[str, Any]:
        return {
            "op": "and",
            "args": [
                eq("typ", "Primarstufe"),
                {
                    "op": "not",
                    "arg": {
                        "op": "related",
                        "layer": "haltestellen",
                        "predicate": "dwithin",
                        "distance_m": 500,
                        "where": eq("verkehrsmittel", value),
                    },
                },
            ],
        }

    found = as_codes(query("schulen", where("Bahn")), PROFILE)
    expected = query("schulen", where("bahn")).model_dump(mode="json")
    expected["where"]["args"][0]["value"] = "primar"
    assert found == QueryObject.model_validate(expected)


@pytest.mark.parametrize(
    ("source", "where"),
    [
        ("haltestellen", eq("verkehrsmittel", "Zug")),  # no code, no label: checked as before
        ("schulen", eq("ambiguous", "x")),  # two codes match ignoring case
        ("haltestellen", eq("name", "Bahn")),  # no code list
        ("haltestellen", eq("kategorie", "ii", "lt")),  # an order means something else
        (
            "haltestellen",
            {"op": "text_match", "attr": "verkehrsmittel", "text": "Bahn", "mode": "contains"},
        ),
        ("schulen", eq("verkehrsmittel", "Bahn")),  # an attribute of another layer
    ],
)
def test_anything_else_stays_as_written(source: str, where: dict[str, Any]) -> None:
    written = query(source, where)
    assert as_codes(written, PROFILE) is written


def test_a_query_without_conditions_stays() -> None:
    written = QueryObject.model_validate({"source": "schulen"})
    assert as_codes(written, PROFILE) is written


def test_the_rewritten_query_keeps_its_other_fields() -> None:
    written = QueryObject.model_validate(
        {"source": "haltestellen", "output": "map", "where": eq("verkehrsmittel", "Bus")}
    )
    found = as_codes(written, PROFILE)
    assert canonical_json(found) == canonical_json(
        written.model_copy(
            update={"where": query("haltestellen", eq("verkehrsmittel", "bus")).where}
        )
    )
