"""fetch HTTP 层测试（responses mock）。"""
from urllib.parse import unquote

import responses

from app import fetch


@responses.activate
def test_fetch_crossref_paginates_with_cursor():
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/1"}], "next-cursor": "CUR2"}},
    )
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/2"}], "next-cursor": None}},
    )
    items = fetch.fetch_crossref(["0000-0000"], since="2026-08-01")
    assert [i["DOI"] for i in items] == ["10.a/1", "10.a/2"]
    # 过滤条件组装正确（req.url 为 URL 编码形式，先解码再断言）
    url = unquote(responses.calls[0].request.url)
    assert "from-created-date:2026-08-01" in url
    assert "type:journal-article" in url
    assert "0000-0000" in url


@responses.activate
def test_fetch_openalex_chunks_and_keys_by_doi():
    responses.get(
        "https://api.openalex.org/works",
        json={"results": [{"doi": "https://doi.org/10.a/1", "language": "en"}]},
    )
    out = fetch.fetch_openalex(["10.a/1"])
    assert out["10.a/1"]["language"] == "en"


@responses.activate
def test_get_json_retries_on_500():
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", json={"ok": True})
    assert fetch._get_json("https://api.crossref.org/journals/x", {}) == {"ok": True}
