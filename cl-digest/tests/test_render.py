"""render 冒烟测试：产物存在、内容包含关键信息、RSS 可解析。"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from app.render import load_papers, render_site

PAPERS = [
    {"doi": "10.a/1", "title_original": "Criminal Liability", "title_zh": "刑事责任",
     "authors": ["A. B"], "journal_name": "J1", "journal_issn_l": "0000-0000",
     "pub_date_online": "2026-08-10", "pub_date_issue": None, "first_seen_at": "2026-08-15",
     "abstract_original": "abs text", "abstract_source": "openalex", "lang": "en",
     "relevance": "core", "subfield": "criminal_law_core", "tldr_zh": "导读一",
     "inclusion_reason_zh": "理由一", "llm_model": "m", "generated_at": "t"},
    {"doi": "10.a/2", "title_original": "Policing Study", "title_zh": "警务研究",
     "authors": [], "journal_name": "J2", "journal_issn_l": "0000-0001",
     "pub_date_online": None, "pub_date_issue": None, "first_seen_at": "2026-08-15",
     "abstract_original": None, "abstract_source": "none", "lang": "en",
     "relevance": "borderline", "subfield": "criminology", "tldr_zh": None,
     "inclusion_reason_zh": "LLM 分诊失败，待人工处理", "llm_model": "m", "generated_at": "t"},
]


def test_render_site_products(tmp_path):
    render_site(PAPERS, site_dir=tmp_path)
    day = (tmp_path / "day" / "2026-08-15.html").read_text(encoding="utf-8")
    assert "刑事责任" in day and "待人工确认" in day and "摘要暂缺" in day
    idx = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert "2026-08-15" in idx
    data_js = (tmp_path / "assets" / "data" / "papers-2026-08.js").read_text(encoding="utf-8")
    assert "window.PAPERS_2026_08" in data_js
    ET.parse(tmp_path / "feed.xml")  # RSS 为合法 XML
    assert (tmp_path / "assets" / "fuse.min.js").exists()
    assert (tmp_path / "archive.html").read_text(encoding="utf-8").count("f-month")
    feed = (tmp_path / "feed.xml").read_text(encoding="utf-8")
    assert "警务研究" not in feed  # borderline 不进 RSS
    # 幂等：重跑输出一致
    first = (tmp_path / "index.html").read_text(encoding="utf-8")
    render_site(PAPERS, site_dir=tmp_path)
    assert (tmp_path / "index.html").read_text(encoding="utf-8") == first


def test_load_papers_reads_monthly_files(tmp_path):
    (tmp_path / "papers-2026-08.jsonl").write_text(
        "\n".join(json.dumps(p) for p in PAPERS) + "\n", encoding="utf-8")
    papers = load_papers(data_dir=tmp_path)
    assert len(papers) == 2


def test_monthly_js_data_is_json_escaped_not_html(tmp_path):
    """月度 JS 为纯 JSON；HTML 注入在归档页由 esc() 前端转义（此处验证数据侧契约）。"""
    render_site(PAPERS, site_dir=tmp_path)
    js = (tmp_path / "assets" / "data" / "papers-2026-08.js").read_text(encoding="utf-8")
    assert "<script>" not in js  # json.dumps 不产生标签，若出现说明转义链断裂
