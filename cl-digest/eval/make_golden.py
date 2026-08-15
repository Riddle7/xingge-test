"""生成待标注 golden 集：python -m eval.make_golden --sample 150 [--seed 42]"""
import argparse
import json
import random
from pathlib import Path

from app.render import load_papers

EVAL_DIR = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=150)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--finalize", action="store_true",
                    help="标注完成后把 golden_todo.jsonl 定稿为 golden.jsonl")
    args = ap.parse_args()
    if args.finalize:
        todo = EVAL_DIR / "golden_todo.jsonl"
        todo.rename(EVAL_DIR / "golden.jsonl")
        print("已定稿 eval/golden.jsonl")
        return
    papers = load_papers()
    sample = random.Random(args.seed).sample(papers, min(args.sample, len(papers)))
    with open(EVAL_DIR / "golden_todo.jsonl", "w", encoding="utf-8") as f:
        for p in sample:
            f.write(json.dumps({
                "doi": p["doi"], "title_original": p["title_original"],
                "abstract_original": p["abstract_original"],
                "relevance": None,   # 人工填 core|related|borderline|irrelevant
                "subfield": None,    # 人工填（可留空）
            }, ensure_ascii=False) + "\n")
    print(f"已生成 eval/golden_todo.jsonl（{len(sample)} 条），请人工填写 relevance/subfield 后 "
          f"运行 --finalize")


if __name__ == "__main__":
    main()
