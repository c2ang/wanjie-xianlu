#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 docs/效果样例.md —— 复用 pick_random.py 的算法，保证与插件一致。

用法（在 wanjie-xianlu 目录下）：
    PYTHONIOENCODING=utf-8 python tools/make_samples.py
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pick_random as pr  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'knowledge')
OUT = os.path.join(ROOT, 'docs', '效果样例.md')

CAT_LABEL = {
    'female_cultivator': '女性修仙者',
    'female_artifact_spirit': '女性器灵',
    'female_beast': '女性异兽',
    'female_deity': '女性神佛',
}

JOBS = [
    ('female_cultivator', 42, 3, {'allow_pending': False}),
    ('female_artifact_spirit', 7, 2, {'allow_pending': False}),
    ('female_beast', 11, 2, {'allow_pending': False}),
    ('female_deity', 5, 1, {'allow_pending': True}),
]


def main():
    ents = pr.load_entities(DATA)
    pools = pr.load_pools(DATA)

    lines = [
        '# 效果样例：插件一次「随机取素材」给制卡器什么',
        '',
        '> 由 `tools/pick_random.py` 生成，算法与酒馆内插件逐项一致（`verify_cli_parity` 守护）。seed 固定即可复现。',
        '> 插件给的是**背景骨架**：门派、身份、境界、灵根、主修功法由资料库随机配对并回溯原文；姓名、性格、经历留给模型。',
        '',
        '对照口径：下面每一格都能直接塞进角色卡的 `description` / `scenario`；',
        '`personality`、`first_mes`、`mes_example` 必须由模型另写，不能当成资料库事实。',
        '',
    ]

    total = 0
    for idx, (cat, seed, count, extra) in enumerate(JOBS, 1):
        allow_pending = bool(extra.get('allow_pending'))
        params = {
            'category': cat, 'count': count, 'keyword': '', 'tags': [],
            'realm': '', 'realm_min': '', 'realm_max': '', 'race': '', 'bloodline': '',
            'grade': '', 'artifact_type': '', 'species': '', 'habitat': '', 'domain': '',
            'sect': '', 'can_transform': False,
            'allow_pending': allow_pending, 'allow_adaptation': True,
            'exclude_ids': [], 'include_deprecated': False,
        }
        settings = {'allowPending': allow_pending, 'allowAdaptation': True, 'recentWindow': 20}
        pool = [e for e in ents if pr.hard_filter(e, params, settings)]
        pool.sort(key=lambda x: x['id'])
        rand = pr.mulberry32(seed)
        weights = [pr.score(e, params) for e in pool]
        picked = pr.sample_weighted(pool, weights, min(count, len(pool)), rand)

        lines.append('## %d、%s（seed=%s × %d 条，候选 %d）' % (idx, CAT_LABEL[cat], seed, min(count, len(pool)), len(pool)))
        lines.append('')
        if not picked:
            lines.append('（本次无候选）')
            lines.append('')
        for e in picked:
            total += 1
            r = pr.entity_to_result(e, 'standard', 3200, seed, pools)
            bg = r.get('background') or {}
            fields = bg.get('fields') or {}
            prov = bg.get('provenance') or {}
            lines.append('### %s（%s · %s）' % (r.get('name'), r.get('category_label'), r.get('quality_label')))
            lines.append('')
            lines.append('| 背景骨架 | 值 | 来源 |')
            lines.append('| --- | --- | --- |')
            for k, v in fields.items():
                src = prov.get(k)
                if isinstance(src, list):
                    src_text = '原文 %s' % src[0]
                elif src == 'entity':
                    src_text = '原文'
                elif src is None:
                    src_text = '—'
                else:
                    src_text = '资料库随机配对'
                lines.append('| %s | %s | %s |' % (k, str(v).replace('|', '｜'), src_text))
            lines.append('')
            lines.append('- 留给模型写：%s' % '、'.join(bg.get('to_be_authored') or []))
            lines.append('- 摘要：%s' % (r.get('summary') or '').replace('|', '｜'))
            if r.get('material_note'):
                lines.append('- 诚实标注：%s' % r['material_note'])
            lines.append('')
            lines.append('```json')
            lines.append(json.dumps({'id': r['id'], 'name': r['name'], 'category': r['category'],
                                     'background': bg}, ensure_ascii=False, indent=2))
            lines.append('```')
            lines.append('')

    lines.append('## 怎么用这三行字')
    lines.append('')
    lines.append('1. 制卡器调 `xianlu_generate`（或离线 `pick_random.py --combo "女性修仙者:2,女性器灵:1"`）拿到 `background.fields`。')
    lines.append('2. `fields` 写进卡片的 `description` / `scenario`；`personality`、`first_mes`、`mes_example` 由模型写。')
    lines.append('3. `to_be_authored` 里的项必须模型补，不能当资料库事实；`provenance` 标 `library` 的表示是随机配对，不是原文独有设定。')
    lines.append('')

    io.open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
    print('wrote %s (%d 条样例)' % (OUT, total))


if __name__ == '__main__':
    main()
