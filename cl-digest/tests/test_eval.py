"""eval 测试：指标计算。"""
from eval.run_eval import compute_metrics


def test_compute_metrics_core_precision():
    preds = [
        {"doi": "1", "relevance": "core", "subfield": "criminal_law_core"},
        {"doi": "2", "relevance": "core", "subfield": "criminology"},
        {"doi": "3", "relevance": "related", "subfield": "criminology"},
    ]
    golds = [
        {"doi": "1", "relevance": "core", "subfield": "criminal_law_core"},
        {"doi": "2", "relevance": "borderline", "subfield": "criminology"},
        {"doi": "3", "relevance": "related", "subfield": "criminology"},
    ]
    m = compute_metrics(preds, golds)
    # core 预测 2，命中 1 → precision 0.5；gold core 1，命中 1 → recall 1.0
    assert m["core"]["precision"] == 0.5
    assert m["core"]["recall"] == 1.0
