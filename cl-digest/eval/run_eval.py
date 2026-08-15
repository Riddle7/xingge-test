"""golden 回归：python -m eval.run_eval [--enforce]（需 LLM_API_KEY，逐条重新分诊）。"""
import argparse
import json
import sys
from pathlib import Path

from app import config
from app.classify import LLMClient, classify_or_degrade
from app.render import load_papers

EVAL_DIR = Path(__file__).resolve().parent
GOLDEN = EVAL_DIR / "golden.jsonl"


def compute_metrics(preds, golds):
    """逐档 precision/recall：pred=X 中 gold=X 为 TP；gold 非标定档不计入该档分母。"""
    gold_by_doi = {g["doi"]: g for g in golds}
    metrics = {}
    for tier in ("core", "related", "borderline"):
        tp = sum(1 for p in preds
                 if p["relevance"] == tier and gold_by_doi[p["doi"]]["relevance"] == tier)
        pred_n = sum(1 for p in preds if p["relevance"] == tier)
        gold_n = sum(1 for g in golds if g["relevance"] == tier)
        metrics[tier] = {"precision": tp / pred_n if pred_n else None,
                         "recall": tp / gold_n if gold_n else None,
                         "pred_n": pred_n, "gold_n": gold_n}
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enforce", action="store_true",
                    help="core precision < 0.90 时以非零码退出（CI 门禁）")
    args = ap.parse_args()
    if not GOLDEN.exists():
        sys.exit("eval/golden.jsonl 不存在：先 make_golden --sample 150 并人工标注")
    golds = [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    papers = {p["doi"]: p for p in load_papers()}
    lexicon = (config.DATA_DIR / "lexicon.md").read_text(encoding="utf-8")
    client = LLMClient()
    preds = []
    degraded_n = 0
    for g in golds:
        p = papers.get(g["doi"])
        if not p:
            print(f"WARN 论文库中无 {g['doi']}，跳过")
            continue
        analysis, degraded = classify_or_degrade(
            p["title_original"], p["abstract_original"], lexicon, client)
        if degraded:
            degraded_n += 1
        preds.append({"doi": g["doi"], **{k: analysis[k] for k in ("relevance", "subfield")}})
    if degraded_n:
        print(f"WARN {degraded_n}/{len(preds)} 条分诊失败已降级 borderline，指标受污染，"
              f"请检查 LLM_API_KEY/网络后重跑")
    m = compute_metrics(preds, golds)
    print(json.dumps(m, ensure_ascii=False, indent=2))
    if args.enforce:
        cp = m["core"]["precision"]
        if cp is None:
            sys.exit("core 预测数为 0，precision 未定义，不达标")
        if cp < 0.90:
            sys.exit("core precision < 0.90，不达标")


if __name__ == "__main__":
    main()
