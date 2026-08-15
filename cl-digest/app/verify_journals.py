"""逐条核验 journals.csv 的 ISSN 是否能在 Crossref 解析：python -m app.verify_journals"""
import csv
import sys

import requests

from . import config


def main() -> int:
    with open(config.JOURNALS_CSV, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    bad = 0
    for row in rows:
        issn = row["issn_l"]
        try:
            r = requests.get(
                f"https://api.crossref.org/journals/{issn}",
                params={"mailto": config.MAILTO}, timeout=30,
            )
            if r.status_code == 200:
                title = r.json()["message"]["title"]
                print(f"OK   {issn}  {title}")
            else:
                bad += 1
                print(f"FAIL {issn}  {row['journal_name']}  HTTP {r.status_code}")
        except requests.RequestException as e:
            bad += 1
            print(f"FAIL {issn}  {row['journal_name']}  {e}")
    print(f"\n{len(rows)} 刊，{bad} 条核验失败")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
