"""每日编排：发现→补全→规范化→分诊→入库→渲染→审核队列→原子提交。"""
import argparse
import csv
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

from . import config
from .classify import ClassifyError, LLMClient, classify_or_degrade, translate_abstract
from .fetch import fetch_crossref, fetch_openalex
from .normalize import build_record, filter_new
from .render import load_papers, render_site

TZ = ZoneInfo("Asia/Shanghai")


def load_journals(path=config.JOURNALS_CSV):
    """读白名单，返回 (rows, 用于过滤的 ISSN 列表=印刷+电子并集)。"""
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    issns = {r["print_issn"] for r in rows if r["print_issn"]}
    issns |= {r["online_issn"] for r in rows if r["online_issn"]}
    return rows, sorted(issns)


def load_seen(data_dir):
    p = Path(data_dir) / "seen.jsonl"
    if not p.exists():
        return set()
    return {l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip()}


def append_line(path, line):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def write_review_queue(today, papers, data_dir):
    """当日 borderline/降级论文写入人工审核 markdown（GitHub Web UI 可直接裁决）。"""
    pend = [p for p in papers
            if p["first_seen_at"] == today and p["relevance"] == "borderline"]
    lines = [f"# 待人工确认 · {today}", "",
             "逐条点击 DOI 判断，裁决命令：", "```",
             "python -m app.resolve <doi> core|related|irrelevant [--subfield ...] [--note ...]",
             "```", ""]
    for p in pend:
        lines += [f"## {p.get('title_zh') or p['title_original']}",
                  f"- DOI: https://doi.org/{p['doi']}",
                  f"- 原标题: {p['title_original']}",
                  f"- 期刊: {p['journal_name']} · 语言: {p['lang']}",
                  f"- 收录理由: {p['inclusion_reason_zh']}",
                  f"- 摘要: {(p['abstract_original'] or '（暂缺）')[:400]}", ""]
    out = Path(data_dir) / "review-queue" / f"{today}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")


def git_commit(paths, message, push=False):
    """原子提交：所有路径 add 后一次 commit；push 供 CI 使用。"""
    subprocess.run(["git", "add", *paths], check=True, cwd=config.REPO_ROOT)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=config.REPO_ROOT).returncode
    if diff != 0:
        subprocess.run(["git", "-c", "user.name=cl-digest-bot",
                        "-c", "user.email=cl-digest-bot@users.noreply.github.com",
                        "commit", "-m", message], check=True, cwd=config.REPO_ROOT)
        if push:
            subprocess.run(["git", "push"], check=True, cwd=config.REPO_ROOT)


def run(lookback_days=14, today=None, do_classify=True, do_commit=True, push=False,
        data_dir=config.DATA_DIR, site_dir=config.SITE_DIR):
    today = today or datetime.now(TZ).date().isoformat()
    data_dir, site_dir = Path(data_dir), Path(site_dir)
    since = (datetime.fromisoformat(today) - timedelta(days=lookback_days)).date().isoformat()

    _, issns = load_journals()
    items = fetch_crossref(issns, since=since)
    if not items:
        raise RuntimeError(f"零结果告警：Crossref 返回 0 条（白名单 {len(issns)} 个 ISSN，"
                           f"since={since}）。流水线疑似故障，请检查 API 与过滤条件。")

    enrich = fetch_openalex([i["DOI"] for i in items if i.get("DOI")])
    records = []
    for it in items:
        rec = build_record(it, enrich.get((it.get("DOI") or "").lower()), first_seen=today)
        if rec:
            records.append(rec)

    new = filter_new(records, load_seen(data_dir))
    print(f"发现 {len(items)} 条 · 规范化 {len(records)} 条 · 新增 {len(new)} 条")

    if do_classify and new:
        lexicon = (config.DATA_DIR / "lexicon.md").read_text(encoding="utf-8")
        client = LLMClient()
        for rec in new:
            analysis, degraded = classify_or_degrade(
                rec["title_original"], rec["abstract_original"], lexicon, client)
            rec.update(analysis)
            rec["llm_model"] = "none" if degraded else client.model
            rec["generated_at"] = datetime.now(TZ).isoformat(timespec="seconds")
        # 今日精选：按阅读价值取前 5 篇（有摘要者），全文中译
        ranked = sorted(
            (r for r in new if r["abstract_original"]),
            key=lambda r: (-(r.get("worth_score") or 0), r["doi"]),
        )
        for rec in ranked[:5]:
            try:
                rec["abstract_zh"] = translate_abstract(rec["abstract_original"], client)
            except (ClassifyError, requests.RequestException) as e:
                print(f"WARN 精选翻译失败 {rec['doi']}: {e}")
    elif new:  # --no-classify 调试模式：全部置空待下轮补
        for rec in new:
            rec.update({"relevance": "borderline", "subfield": "interdisciplinary",
                        "worth_score": 0, "title_zh": None, "tldr_zh": None,
                        "inclusion_reason_zh": "跳过分诊（调试模式）"})

    for rec in new:
        line = json.dumps(rec, ensure_ascii=False)
        append_line(data_dir / f"papers-{today[:7]}.jsonl", line)
        append_line(data_dir / "seen.jsonl", rec["doi"])

    papers = load_papers(data_dir)
    render_site(papers, site_dir=site_dir)
    write_review_queue(today, papers, data_dir)

    if do_commit:
        git_commit([str(data_dir), str(site_dir)],
                   f"digest(cl): {today} 日报（新增 {len(new)} 篇）", push=push)
    print(f"完成：{today} 新增 {len(new)} 篇")


def main():
    ap = argparse.ArgumentParser(description="SSCI 刑法论文每日雷达")
    ap.add_argument("--lookback", type=int, default=14)
    ap.add_argument("--today", default=None, help="覆盖运行日期（YYYY-MM-DD，测试用）")
    ap.add_argument("--no-classify", action="store_true", help="跳过 LLM 分诊（调试）")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--push", action="store_true", help="commit 后 push（CI 用）")
    args = ap.parse_args()
    run(lookback_days=args.lookback, today=args.today, do_classify=not args.no_classify,
        do_commit=not args.no_commit, push=args.push)


if __name__ == "__main__":
    sys.exit(main())
