"""normalize 纯函数单元测试。"""
from app.normalize import clean_doi


def test_clean_doi_strips_url_prefix():
    assert clean_doi("https://doi.org/10.1093/oxresgr/rgaa014") == "10.1093/oxresgr/rgaa014"


def test_clean_doi_strips_doi_prefix_and_lowercases():
    assert clean_doi("DOI:10.X/Y") == "10.x/y"
    assert clean_doi("doi:10.1007/s12345-026-00123-4") == "10.1007/s12345-026-00123-4"


def test_clean_doi_rejects_invalid():
    assert clean_doi("not a doi") is None
    assert clean_doi("") is None
    assert clean_doi(None) is None


from app.normalize import parse_date, rebuild_abstract, strip_jats


def test_parse_date_full_and_partial():
    assert parse_date({"date-parts": [[2026, 8, 15]]}) == "2026-08-15"
    assert parse_date({"date-parts": [[2026, 8]]}) == "2026-08"
    assert parse_date({"date-parts": [[2026]]}) == "2026"
    assert parse_date({}) is None
    assert parse_date(None) is None


def test_rebuild_abstract_orders_by_position():
    inv = {"world": [2], "hello": [0], ",": [1]}
    assert rebuild_abstract(inv) == "hello , world"
    assert rebuild_abstract(None) is None
    assert rebuild_abstract({}) == ""


def test_strip_jats_removes_tags_and_unescapes():
    assert strip_jats("<p>A &amp; B</p>") == "A & B"
    assert strip_jats("Plain") == "Plain"


from app.normalize import build_record, detect_lang, filter_new

CROSSREF_ITEM = {
    "DOI": "10.1093/oxresgr/rgaa014",
    "title": ["Criminal Liability for Robots"],
    "author": [{"given": "A.", "family": "Author"}, {"name": "B. Author"}],
    "container-title": ["Some Journal"],
    "ISSN": ["0000-0000"],
    "issued": {"date-parts": [[2026, 8, 15]]},
    "published-print": {"date-parts": [[2026, 9]]},
    "abstract": "<p>We argue that <i>mens rea</i> matters.</p>",
}
OPENALEX_WORK = {
    "doi": "https://doi.org/10.1093/oxresgr/rgaa014",
    "language": "en",
    "abstract_inverted_index": {"We": [0], "argue": [1]},
}


def test_detect_lang_defaults_and_detects():
    assert detect_lang("Kriminalität und Schuld", None) in ("de", "other")
    assert detect_lang("", None) == "other"


def test_build_record_prefers_openalex_abstract():
    rec = build_record(CROSSREF_ITEM, OPENALEX_WORK, first_seen="2026-08-15")
    assert rec["doi"] == "10.1093/oxresgr/rgaa014"
    assert rec["abstract_original"] == "We argue"
    assert rec["abstract_source"] == "openalex"
    assert rec["lang"] == "en"
    assert rec["pub_date_online"] == "2026-08-15"
    assert rec["pub_date_issue"] == "2026-09"
    assert rec["authors"] == ["A. Author", "B. Author"]
    assert rec["relevance"] is None  # 待 classify 填充


def test_build_record_falls_back_to_crossref_abstract():
    rec = build_record(CROSSREF_ITEM, None, first_seen="2026-08-15")
    assert rec["abstract_original"] == "We argue that mens rea matters."
    assert rec["abstract_source"] == "crossref"
    assert rec["lang"] in ("en", "other")


def test_build_record_skips_no_title():
    item = dict(CROSSREF_ITEM, title=[])
    assert build_record(item, None, first_seen="x") is None


def test_filter_new():
    recs = [{"doi": "10.a/b"}, {"doi": "10.c/d"}]
    assert filter_new(recs, {"10.a/b"}) == [{"doi": "10.c/d"}]
