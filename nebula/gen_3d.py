import json, math, random, itertools, sys

random.seed(42)

# 用法: python gen_3d.py <输入papers.json> <输出3d.json> <generatedAt>
IN_PATH = sys.argv[1] if len(sys.argv) > 1 else 'd:/trae/nebula/papers-2026-07.json'
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else 'd:/trae/nebula/papers-3d.json'
GENERATED_AT = sys.argv[3] if len(sys.argv) > 3 else '2026-08-06'

with open(IN_PATH, 'r', encoding='utf-8') as f:
    data = json.load(f)

papers = data['papers']
meta = data['meta']
topics = list(meta['topics'].keys())

# 议题颜色（与 HTML TOPIC_META 一致）
TOPIC_COLORS = {
    '罪刑各论（具体罪名教义学）': '#8b3a3a',
    '数字刑法与网络犯罪': '#4a6b8a',
    '归责理论': '#a2845e',
    '刑罚论与刑事政策': '#b8860b',
    '程序与实体交叉': '#5a5a8e',
    '行刑衔接与轻罪治理': '#5b7553',
    '贿赂犯罪': '#7a4a6b',
    '法益理论': '#3d7060',
    '刑法哲学与知识体系': '#8e8e93',
}
FALLBACK_PALETTE = ['#8b3a3a', '#4a6b8a', '#a2845e', '#b8860b', '#5a5a8e', '#5b7553', '#7a4a6b', '#3d7060', '#8e8e93']

# 为每个议题分配球面上的中心点
n_topics = len(topics)
topic_centers = {}
for i, t in enumerate(topics):
    # 黄金角分布球面
    phi = math.acos(1 - 2 * (i + 0.5) / n_topics)
    theta = math.pi * (1 + 5 ** 0.5) * (i + 0.5)
    r = 3.0
    topic_centers[t] = [
        r * math.sin(phi) * math.cos(theta),
        r * math.cos(phi),
        r * math.sin(phi) * math.sin(theta),
    ]

# 为每篇论文生成3D坐标（在其议题中心附近散布）
points = []
for p in papers:
    center = topic_centers.get(p['topic'], [0, 0, 0])
    # 在中心附近随机散布
    offset_r = random.uniform(0.5, 1.8)
    offset_theta = random.uniform(0, 2 * math.pi)
    offset_phi = random.uniform(0, math.pi)
    x = center[0] + offset_r * math.sin(offset_phi) * math.cos(offset_theta)
    y = center[1] + offset_r * math.sin(offset_phi) * math.sin(offset_theta)
    z = center[2] + offset_r * math.cos(offset_phi)
    points.append({
        'id': p['id'],
        'title': p['title'],
        'authors': p.get('authors', []),
        'journal': p.get('journal', ''),
        'topic': p['topic'],
        'theories': p.get('theories', []),
        'keywords': p.get('keywords', []),
        'stance': p.get('stance', ''),
        'summary': p.get('summary', ''),
        'novelty': p.get('novelty', 5),
        'position': [round(x, 4), round(y, 4), round(z, 4)],
        'cluster': topics.index(p['topic']) if p['topic'] in topics else 0,
    })

# 构建聚类信息
clusters = []
for i, t in enumerate(topics):
    cluster_papers = [p['id'] for p in points if p['cluster'] == i]
    center = topic_centers[t]
    clusters.append({
        'id': i,
        'name': t,
        'center': [round(center[0], 4), round(center[1], 4), round(center[2], 4)],
        'color': TOPIC_COLORS.get(t, FALLBACK_PALETTE[i % len(FALLBACK_PALETTE)]),
        'size': len(cluster_papers),
        'papers': cluster_papers,
    })

# 计算相似性边（基于共享理论关键词）
edges = []
for i, j in itertools.combinations(range(len(points)), 2):
    p1, p2 = points[i], points[j]
    # 共享理论
    t1 = set(p1.get('theories', []))
    t2 = set(p2.get('theories', []))
    shared_theories = t1 & t2
    # 共享关键词
    k1 = set(p1.get('keywords', []))
    k2 = set(p2.get('keywords', []))
    shared_keywords = k1 & k2

    similarity = len(shared_theories) * 0.3 + len(shared_keywords) * 0.2
    # 同议题加分
    if p1['cluster'] == p2['cluster']:
        similarity += 0.15

    if similarity >= 0.35:
        edges.append({
            'source': p1['id'],
            'target': p2['id'],
            'similarity': round(similarity, 3),
        })

# 按相似度排序，取前100条边
edges.sort(key=lambda e: -e['similarity'])
edges = edges[:100]

output = {
    'meta': {
        'total': len(papers),
        'embedModel': 'topic-based-heuristic',
        'reduceMethod': 'topic-center-scatter',
        'reduceDesc': 'Papers placed near topic centers on sphere with random offset',
        'simThreshold': 0.35,
        'generatedAt': GENERATED_AT,
    },
    'clusters': clusters,
    'points': points,
    'edges': edges,
}

with open(OUT_PATH, 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f'{OUT_PATH} generated: {len(points)} points, {len(clusters)} clusters, {len(edges)} edges')
for c in clusters:
    print(f"  Cluster {c['id']}: {c['name'][:16]} ({c['size']} papers, {c['color']})")
