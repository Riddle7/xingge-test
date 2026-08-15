"""fetch HTTP 层测试（responses mock）。"""
import responses

from app import fetch


@responses.activate
def test_fetch_crossref_per_issn_with_cursor_and_dedup(monkeypatch):
    monkeypatch.setattr(fetch.time, "sleep", lambda _: None)
    # 第一个 ISSN：两页游标
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/1"}], "next-cursor": "CUR2"}},
    )
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/2"}], "next-cursor": None}},
    )
    # 第二个 ISSN：一页，含与第一个 ISSN 重复的 DOI（print/online 并集会撞）
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.A/2"}, {"DOI": "10.b/1"}], "next-cursor": None}},
    )
    items = fetch.fetch_crossref(["0000-0000", "1111-1111"], since="2026-08-01")
    assert [i["DOI"] for i in items] == ["10.a/1", "10.a/2", "10.b/1"]  # 大小写不敏感去重
    req = responses.calls[0].request
    assert "from-created-date%3A2026-08-01" in req.url or "from-created-date:2026-08-01" in req.url
    assert "type%3Ajournal-article" in req.url or "type:journal-article" in req.url
    assert "0000-0000" in req.url


@responses.activate
def test_fetch_openalex_chunks_and_keys_by_doi():
    responses.get(
        "https://api.openalex.org/works",
        json={"results": [{"doi": "https://doi.org/10.a/1", "language": "en"}]},
    )
    out = fetch.fetch_openalex(["10.a/1"])
    assert out["10.a/1"]["language"] == "en"


@responses.activate
def test_get_json_retries_on_500(monkeypatch):
    monkeypatch.setattr(fetch.time, "sleep", lambda _: None)  # 跳过退避等待
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", json={"ok": True})
    assert fetch._get_json("https://api.crossref.org/journals/x", {}) == {"ok": True}


@responses.activate
def test_fetch_openalex_splits_26_dois_into_two_batches(monkeypatch):
    monkeypatch.setattr(fetch.time, "sleep", lambda _: None)
    dois = [f"10.x/{i}" for i in range(26)]
    # 两个响应页：第一批 25 条，第二批 1 条
    responses.get(
        "https://api.openalex.org/works",
        json={"results": [{"doi": f"https://doi.org/{d}"} for d in dois[:25]]},
    )
    responses.get(
        "https://api.openalex.org/works",
        json={"results": [{"doi": f"https://doi.org/{d}"} for d in dois[25:]]},
    )
    out = fetch.fetch_openalex(dois)
    assert len(out) == 26
    # 每批请求携带的 doi 过滤不超过 25 个
    for call in responses.calls:
        filt = [kv for kv in call.request.url.split("filter=")[1].split("&")[0].split("%7C")]
        assert len(filt) <= 25
