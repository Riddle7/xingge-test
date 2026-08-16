"""daily 编排测试：fake fetch/classify，tmp 目录，不 commit。"""
import json

import app.daily as daily
from app import config


def _fake_fetch(monkeypatch):
    item = {"DOI": "10.a/1", "title": ["T"], "author": [], "container-title": ["J"],
            "ISSN": ["0000-0000"], "issued": {"date-parts": [[2026, 8, 15]]},
            "abstract": "<p>We argue mens rea matters.</p>"}
    monkeypatch.setattr(daily, "fetch_crossref", lambda issns, since, until=None: [item])
    monkeypatch.setattr(daily, "fetch_openalex", lambda dois: {})


def _fake_classify(monkeypatch):
    def fake(title, abstract, lexicon, client):
        return {"relevance": "core", "subfield": "criminal_law_core", "worth_score": 9,
                "title_zh": "中题", "tldr_zh": "导读", "inclusion_reason_zh": "理由"}, False
    monkeypatch.setattr(daily, "classify_or_degrade", fake)
    monkeypatch.setattr(daily, "translate_abstract",
                        lambda abstract, client: "全文中译示例。")


def test_run_end_to_end(tmp_path, monkeypatch):
    _fake_fetch(monkeypatch)
    _fake_classify(monkeypatch)
    daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    papers = json.loads((tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert papers["relevance"] == "core" and papers["title_zh"] == "中题"
    assert papers["worth_score"] == 9 and papers["abstract_zh"] == "全文中译示例。"
    seen = (tmp_path / "seen.jsonl").read_text(encoding="utf-8").splitlines()
    assert "10.a/1" in seen
    assert (tmp_path / "site" / "day" / "2026-08-15.html").exists()
    assert (tmp_path / "review-queue" / "2026-08-15.md").exists()  # 空队列也留痕


def test_run_dedups_seen(tmp_path, monkeypatch):
    _fake_fetch(monkeypatch)
    _fake_classify(monkeypatch)
    daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    daily.run(lookback_days=14, today="2026-08-16", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    lines = (tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1  # 第二次运行无新增


def test_run_writes_borderline_to_review_queue(tmp_path, monkeypatch):
    _fake_fetch(monkeypatch)

    def fake_borderline(title, abstract, lexicon, client):
        return {"relevance": "borderline", "subfield": "criminology", "title_zh": "边界题",
                "tldr_zh": None, "inclusion_reason_zh": "疑似纯犯罪学"}, False
    monkeypatch.setattr(daily, "classify_or_degrade", fake_borderline)
    daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    queue = (tmp_path / "review-queue" / "2026-08-15.md").read_text(encoding="utf-8")
    assert "doi.org/10.a/1" in queue
    assert "边界题" in queue
    assert "python -m app.resolve" in queue
    # 日页折叠区也应有该 borderline 条目
    day = (tmp_path / "site" / "day" / "2026-08-15.html").read_text(encoding="utf-8")
    assert "边界题" in day


def test_run_zero_results_alarm(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "fetch_crossref", lambda issns, since, until=None: [])
    monkeypatch.setattr(daily, "fetch_openalex", lambda dois: {})
    try:
        daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
                  data_dir=tmp_path, site_dir=tmp_path / "s")
    except RuntimeError as e:
        assert "零结果" in str(e)
    else:
        raise AssertionError("应触发零结果告警")
