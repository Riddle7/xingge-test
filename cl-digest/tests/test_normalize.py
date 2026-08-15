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
