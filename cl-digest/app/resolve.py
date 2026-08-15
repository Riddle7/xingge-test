"""人工裁决：python -m app.resolve <doi> core|related|irrelevant [--subfield S] [--note N]"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config
from .render import load_papers, render_site

TZ = ZoneInfo("Asia/Shanghai")


def update_paper(doi, relevance, subfield=None, note=None,
                 data_dir=config.DATA_DIR, site_dir=config.SITE_DIR):
    """在 papers-*.jsonl 中原地更新该 DOI 的裁决结果并重渲染站点。"""
    if relevance not in config.RELEVANCE_TIERS + ("irrelevant",):
        raise SystemExit(f"relevance 须为 {config.RELEVANCE_TIERS + ('irrelevant',)}")
    if subfield and subfield not in config.SUBFIELDS:
        raise SystemExit(f"subfield 须为 {config.SUBFIELDS}")
    for f in sorted(Path(data_dir).glob("papers-*.jsonl")):
        lines = f.read_text(encoding="utf-8").splitlines()
        hit = False
        for i, line in enumerate(lines):
            rec = json.loads(line)
            if rec["doi"] == doi:
                rec["relevance"] = relevance
                if subfield:
                    rec["subfield"] = subfield
                if note:
                    rec["inclusion_reason_zh"] = note
                rec["resolved_at"] = datetime.now(TZ).isoformat(timespec="seconds")
                lines[i] = json.dumps(rec, ensure_ascii=False)
                hit = True
                break
        if hit:
            f.write_text("\n".join(lines) + "\n", encoding="utf-8")
            render_site(load_papers(data_dir), site_dir=site_dir)
            print(f"已裁决 {doi} → {relevance}，站点已重渲染")
            return
    raise SystemExit(f"未找到 DOI: {doi}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("doi")
    ap.add_argument("relevance", choices=list(config.RELEVANCE_TIERS) + ["irrelevant"])
    ap.add_argument("--subfield", default=None)
    ap.add_argument("--note", default=None, help="覆盖收录理由（人工说明）")
    ap.add_argument("--no-commit", action="store_true")
    args = ap.parse_args()
    update_paper(args.doi, args.relevance, args.subfield, args.note)
    if not args.no_commit:
        from .daily import git_commit
        git_commit([str(config.DATA_DIR), str(config.SITE_DIR)],
                   f"digest(cl): 人工裁决 {args.doi} → {args.relevance}")


if __name__ == "__main__":
    sys.exit(main())
