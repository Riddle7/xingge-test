"""resolve 测试：更新记录并重渲染。"""
import json

from app.resolve import update_paper


def _write(tmp_path):
    rec = {"doi": "10.a/1", "title_original": "T", "relevance": "borderline",
           "subfield": "criminology", "journal_name": "J", "first_seen_at": "2026-08-15"}
    (tmp_path / "papers-2026-08.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    return rec


def test_update_paper_promotes_to_core(tmp_path):
    _write(tmp_path)
    update_paper("10.a/1", "core", subfield="criminal_law_core",
                 note="摘要实为教义学讨论", data_dir=tmp_path, site_dir=tmp_path / "site")
    line = (tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()[0]
    rec = json.loads(line)
    assert rec["relevance"] == "core" and rec["subfield"] == "criminal_law_core"
    assert rec["inclusion_reason_zh"] == "摘要实为教义学讨论"


def test_update_paper_missing_doi(tmp_path):
    _write(tmp_path)
    try:
        update_paper("10.z/9", "core", data_dir=tmp_path, site_dir=tmp_path / "site")
    except SystemExit:
        pass
    else:
        raise AssertionError("应报错退出")
