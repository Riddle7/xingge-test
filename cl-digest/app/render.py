"""渲染层：全量重建 digest/ 静态站点（日页/首页/归档/RSS/月度数据）。"""
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from feedgen.feed import FeedGenerator
from jinja2 import Environment, FileSystemLoader

from . import config

_LEAN_KEYS = ("doi", "relevance", "subfield", "journal_name", "first_seen_at",
              "title_zh", "title_original", "tldr_zh")


def load_papers(data_dir=config.DATA_DIR):
    """读取全部 papers-*.jsonl，按 first_seen_at 降序。"""
    papers = []
    for f in sorted(Path(data_dir).glob("papers-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                papers.append(json.loads(line))
    papers.sort(key=lambda p: (p.get("first_seen_at") or "", p.get("doi")), reverse=True)
    return papers


def _month(p):
    return (p.get("first_seen_at") or "")[:7]


def _lean(p):
    """归档页数据精简字段：t=标题 j=期刊 tl=导读 d=日期。"""
    return {"doi": p["doi"], "relevance": p["relevance"], "subfield": p["subfield"],
            "j": p["journal_name"], "d": p["first_seen_at"],
            "t": p.get("title_zh") or p["title_original"], "tl": p.get("tldr_zh")}


def _write_feed(papers, site_dir):
    fg = FeedGenerator()
    fg.title("SSCI 刑法论文每日雷达")
    site = config.SITE_URL or "https://github.com/Riddle7/xingge-test"
    fg.id(site)
    fg.link(href=site, rel="alternate")
    fg.subtitle("SSCI 期刊 · 刑法语义筛选 · 每日更新")
    for p in [x for x in papers if x["relevance"] in ("core", "related")][:30]:
        fe = fg.add_entry()
        fe.id(f"https://doi.org/{p['doi']}")
        fe.title(p.get("title_zh") or p["title_original"])
        fe.link(href=f"https://doi.org/{p['doi']}")
        fe.description(p.get("tldr_zh") or "")
        d = p.get("first_seen_at") or "1970-01-01"
        fe.pubDate(datetime.fromisoformat(d).replace(tzinfo=timezone.utc))
    fg.rss_file(str(site_dir / "feed.xml"))


def render_site(papers, site_dir=config.SITE_DIR):
    """全量重建站点目录（无关记录不展示）。"""
    site_dir = Path(site_dir)
    visible = [p for p in papers if p.get("relevance") not in (None, "irrelevant")]
    env = Environment(loader=FileSystemLoader(config.TEMPLATES_DIR), autoescape=True)
    env.globals["base"] = ""

    # 静态资产
    (site_dir / "assets" / "data").mkdir(parents=True, exist_ok=True)
    for f in config.STATIC_DIR.iterdir():
        shutil.copy(f, site_dir / "assets" / f.name)

    # 月度数据 JS（供归档页按需加载）
    months = sorted({_month(p) for p in visible}, reverse=True)
    for m in months:
        rows = [_lean(p) for p in visible if _month(p) == m]
        js = f"window.PAPERS_{m.replace('-', '_')} = {json.dumps(rows, ensure_ascii=False)};"
        (site_dir / "assets" / "data" / f"papers-{m}.js").write_text(js, encoding="utf-8")

    # 日页
    (site_dir / "day").mkdir(parents=True, exist_ok=True)
    day_tpl = env.get_template("day.html")
    for d in sorted({p["first_seen_at"] for p in visible}, reverse=True):
        ps = [p for p in visible if p["first_seen_at"] == d]
        (site_dir / "day" / f"{d}.html").write_text(day_tpl.render(
            base="../", date=d,
            core=[p for p in ps if p["relevance"] == "core"],
            related=[p for p in ps if p["relevance"] == "related"],
            borderline=[p for p in ps if p["relevance"] == "borderline"],
        ), encoding="utf-8")

    # 首页：最近 7 个日期，每天最多列 5 条 core+related
    days = []
    for d in sorted({p["first_seen_at"] for p in visible}, reverse=True)[:7]:
        ps = [p for p in visible if p["first_seen_at"] == d]
        days.append({"date": d,
                     "core": sum(1 for p in ps if p["relevance"] == "core"),
                     "related": sum(1 for p in ps if p["relevance"] == "related"),
                     "borderline": sum(1 for p in ps if p["relevance"] == "borderline"),
                     "top": [p for p in ps if p["relevance"] in ("core", "related")][:5]})
    (site_dir / "index.html").write_text(
        env.get_template("index.html").render(days=days), encoding="utf-8")

    # 归档页
    (site_dir / "archive.html").write_text(env.get_template("archive.html").render(
        months=months, subfields=list(config.SUBFIELDS)), encoding="utf-8")

    _write_feed(visible, site_dir)
