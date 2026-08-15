"""HTTP 抓取层：Crossref 发现 + OpenAlex 补全。带重试与礼貌池 mailto。"""
import time

import requests

from . import config
from .normalize import clean_doi


def _get_json(url, params, tries=3, timeout=30):
    """GET JSON，指数退避重试。"""
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if i == tries - 1:
                raise
            time.sleep(2**i)


def fetch_crossref(issns, since, until=None):
    """逐 ISSN 拉取新论文（Crossref 多 ISSN OR 与日期过滤组合会丢结果，不可用），
    游标分页，按 DOI 去重后返回 message.items 列表。

    注：Crossref 中综述与论文同为 type=journal-article，无需额外 type 区分。
    """
    seen = set()
    items = []
    for issn in issns:
        flt = f"issn:{issn},from-created-date:{since},type:journal-article"
        if until:
            flt += f",until-created-date:{until}"
        cursor = "*"
        while True:
            js = _get_json(
                "https://api.crossref.org/works",
                {"filter": flt, "rows": 200, "cursor": cursor, "mailto": config.MAILTO},
            )
            msg = js.get("message", {})
            batch = msg.get("items", [])
            for it in batch:
                doi = (it.get("DOI") or "").lower()
                if doi and doi not in seen:
                    seen.add(doi)
                    items.append(it)
            cursor = msg.get("next-cursor")
            if not cursor or not batch:
                break
    return items


def fetch_openalex(dois):
    """按 DOI 批量取 OpenAlex work（25 个/次），返回 {规范doi: work}。缺失 DOI 不在结果中。"""
    out = {}
    for i in range(0, len(dois), 25):
        chunk = dois[i : i + 25]
        js = _get_json(
            "https://api.openalex.org/works",
            {
                "filter": "doi:" + "|".join(chunk),
                "select": "doi,language,authorships,primary_location,abstract_inverted_index",
                "per-page": 50,
                "mailto": config.MAILTO,
            },
        )
        for w in js.get("results", []):
            doi = clean_doi(w.get("doi"))
            if doi:
                out[doi] = w
    return out
