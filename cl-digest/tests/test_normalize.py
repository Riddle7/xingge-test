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
