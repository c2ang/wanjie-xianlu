#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把万界仙录打包成「可复制 / 可分发」的几种文件。

产出（dist/）：
  1. wanjie-xianlu-v<版本>.zip        插件整包（解压即装，含说明）
  2. 资料包-万界仙录-v<版本>.jsonl     文档+实体+关联混排，供已装插件「导入资料库」
  3. 世界书-万界仙录-素材.json         252 条素材，SillyTavern 原生世界书（无需插件）
  4. 世界书-万界仙录-设定原文.json     1396 篇设定节选，同上（大文件，可选）
  5. 角色卡-万界仙录-设定助手.json     chara_card_v2，内嵌 character_book，单文件导入
  6. 导入说明.md / 发布清单.md
"""

import hashlib
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KN = os.path.join(ROOT, 'knowledge')
DIST = os.path.join(ROOT, 'dist')
VERSION = '1.2.0'

CAT_LABEL = {
    'female_cultivator': '女性修仙者',
    'female_deity': '女性神佛',
    'female_artifact_spirit': '女性器灵',
    'female_beast': '女性异兽',
}
QUALITY_LABEL = {
    'verified': '原文可证',
    'inferred': '原文可推',
    'adapted': '改编补全',
    'pending': '待核查',
    'conflict': '冲突',
}
REL_LABEL = {
    'spirit_of_artifact': '器灵所属法宝',
    'wields': '持有',
    'rides': '乘骑',
    'member_of': '所属',
}


def read_jsonl(p):
    out = []
    with open(p, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def load():
    idx = json.load(open(os.path.join(KN, 'index.json'), encoding='utf-8'))
    docs = read_jsonl(os.path.join(KN, 'documents', 'source_documents.jsonl'))
    ents, rels = [], []
    for rel in idx['entities']:
        ents += read_jsonl(os.path.join(KN, rel))
    rels = read_jsonl(os.path.join(KN, idx['relations']))
    return idx, docs, ents, rels


# ---------------------------------------------------------------- 世界书

def entry_schema(**kw):
    base = {
        'uid': 0, 'displayIndex': 0, 'comment': '', 'disable': False,
        'constant': False, 'selective': True, 'key': [], 'selectiveLogic': 0,
        'keysecondary': [], 'scanDepth': None, 'vectorized': False,
        'position': 0, 'role': None, 'depth': 4, 'order': 100, 'content': '',
        'useProbability': True, 'probability': 100, 'excludeRecursion': False,
        'preventRecursion': False, 'delayUntilRecursion': False,
        'sticky': None, 'cooldown': None, 'delay': None, 'addMemo': True,
        'matchPersonaDescription': False, 'matchCharacterDescription': False,
        'matchCharacterPersonality': False, 'matchCharacterDepthPrompt': False,
        'matchScenario': False, 'matchCreatorNotes': False,
        'group': '', 'groupOverride': False, 'groupWeight': 100,
        'caseSensitive': None, 'matchWholeWords': None,
        'useGroupScoring': None, 'ignoreBudget': False,
        'automationId': '', 'triggers': [],
    }
    base.update(kw)
    return base


def keys_for(name, aliases, extra=()):
    """世界书触发词：整名 + 按标点切出的片段（长标题也能命中）。"""
    import re
    keys = []
    for src in [name] + list(aliases or []) + list(extra):
        for seg in re.split(r'[（）()·、，,/／|｜\s]+', str(src)):
            seg = seg.strip()
            if 2 <= len(seg) <= 24 and seg not in keys:
                keys.append(seg)
    return keys[:6]


def entity_content(e, rel_by_src):
    cat = CAT_LABEL.get(e['type'], e['type'])
    lines = ['【万界仙录｜%s】%s' % (cat, e['name'])]
    bits = []
    if e.get('subtype'):
        bits.append('细分：%s' % e['subtype'])
    if e.get('quality'):
        bits.append('依据：%s' % QUALITY_LABEL.get(e['quality'], e['quality']))
    if bits:
        lines.append('｜'.join(bits))
    if e.get('summary'):
        lines.append('摘要：%s' % e['summary'])
    for k, v in (e.get('fields') or {}).items():
        if v:
            lines.append('%s：%s' % (k, str(v)[:200]))
    for r in rel_by_src.get(e['id'], []):
        label = r.get('target_entity_id') or r.get('target_label')
        if label:
            lines.append('%s：%s' % (REL_LABEL.get(r['relation_type'], r['relation_type']), label))
    if e.get('gender_basis'):
        lines.append('女性依据：%s' % e['gender_basis'])
    if e['type'] == 'female_artifact_spirit' and e.get('quality') == 'adapted':
        lines.append('（素材只提供法宝名与形制；器灵的女性形态、样貌、性格由模型补全。）')
    return '\n'.join(lines)


def doc_content(d, limit=900):
    body = d['content'].strip()
    if len(body) > limit:
        body = body[:limit].rstrip() + '…\n（节选；全文见插件资料库「%s」。）' % d['source_path']
    return '【万界仙录｜%s】%s\n%s' % (d.get('category', ''), d['title'], body)


def build_worldinfo(name, entries):
    out = {}
    for i, e in enumerate(entries):
        e['uid'] = i
        e['displayIndex'] = i
        out[str(i)] = e
    return {'entries': out, 'name': name}


def build_entity_worldinfo(ents, rels):
    rel_by_src = {}
    for r in rels:
        rel_by_src.setdefault(r['source_entity_id'], []).append(r)
    entries = []
    for e in ents:
        entries.append(entry_schema(
            comment='%s｜%s' % (CAT_LABEL.get(e['type'], e['type']), e['name']),
            key=keys_for(e['name'], e.get('aliases'), e.get('tags') or []),
            content=entity_content(e, rel_by_src),
        ))
    return build_worldinfo('万界仙录·素材', entries)


def build_doc_worldinfo(docs, limit=900):
    entries = []
    for d in docs:
        entries.append(entry_schema(
            comment='%s｜%s' % (d.get('category', ''), d['title']),
            key=keys_for(d['title'], []),
            content=doc_content(d, limit),
        ))
    return build_worldinfo('万界仙录·设定原文', entries)


# ---------------------------------------------------------------- 角色卡

def card_book(ents, docs, rels):
    rel_by_src = {}
    for r in rels:
        rel_by_src.setdefault(r['source_entity_id'], []).append(r)
    items = []
    for e in ents:
        items.append({
            'keys': keys_for(e['name'], e.get('aliases'), e.get('tags') or []),
            'content': entity_content(e, rel_by_src),
            'name': e['name'],
            'comment': '%s｜%s' % (CAT_LABEL.get(e['type'], e['type']), e['name']),
            'enabled': True, 'selective': True, 'secondary_keys': [],
            'constant': False, 'position': 'before_char', 'insertion_order': 100,
            'priority': 10, 'case_sensitive': None, 'extensions': {},
        })
    for d in docs:
        items.append({
            'keys': keys_for(d['title'], []),
            'content': doc_content(d, 700),
            'name': d['title'],
            'comment': '%s｜%s' % (d.get('category', ''), d['title']),
            'enabled': True, 'selective': True, 'secondary_keys': [],
            'constant': False, 'position': 'before_char', 'insertion_order': 100,
            'priority': 10, 'case_sensitive': None, 'extensions': {},
        })
    for i, it in enumerate(items):
        it['id'] = i
    return {
        'name': '万界仙录·设定助手', 'description': '',
        'scan_depth': 4, 'token_budget': 2048, 'recursive_scanning': False,
        'extensions': {}, 'entries': items,
    }


CARD_DESC = (
    '你是「万界仙录」的设定助手。你随身的书库里有一套修仙世界设定：女性修仙者、女性神佛、'
    '女性器灵、女性异兽四类素材，共 252 条；另有 1396 篇世界观/修炼/功法/物品/地理/妖兽原文节选。\n\n'
    '用法：用户说「给我一个器灵 / 来个元婴女修 / 找个妖族女修 / 抽个女菩萨」，'
    '你就从书库里取对应素材，写成可以直接开演的角色：姓名、身份、境界或品阶、外形、性情、说话方式、'
    '与用户角色的关系钩子。素材里标「改编补全」的条目（例如只给了法宝名的器灵），'
    '由你自行补全其女性形态——这是约定，不是虚构事实。\n\n'
    '规则：\n'
    '1. 不默认神佛、异兽都是女性；书里没写性别的，明说是你的加工。\n'
    '2. 法宝本体与器灵是两个东西：器灵是法宝里的魂灵，别把剑写成「她是一把剑」。\n'
    '3. 境界用书里的体系（练气→筑基→金丹→元婴→化神→炼虚→合体→大乘→渡劫…），不要自造。\n'
    '4. 先给「素材卡」再给「角色小传」，方便用户改。'
)

CARD_FIRST = (
    '（青灯下，一卷《万界仙录》自己翻到了中间。）\n\n'
    '「要哪一类？」\n'
    '· 女修 —— 模板型的多：圣女、魔女、师姐、女帝、散修、严厉长老\n'
    '· 神佛 —— 女娲、王母、观音一类，共 6 位\n'
    '· 器灵 —— 68 件具名法宝，器灵只给法宝名与形制，形象由我补\n'
    '· 异兽 —— 139 条，多是血脉与天赋，化形与否我会说明\n\n'
    '也可以直接说要求，比如「元婴期、木灵根、话少、剑修」。'
)

CARD_EXAMPLE = (
    '<START>\n{{user}}: 来个器灵\n'
    '{{char}}: 【素材】诛仙剑 · 神器·天道杀器（诛仙四剑之首）\n'
    '形制：剑长三尺六寸，剑身青灰，隐有血色暗纹；原文器灵注：混沌凶兽饕餮残魂所化，嗜杀成性。\n\n'
    '【角色】她叫「肆」，剑中残魂凝成的少女，赤足、发梢焦黑，笑起来有獠牙的影子。'
    '说话短促，像刃口擦过石头。认主条件：能在她剑下走过三招还不死。\n'
)


def build_card(ents, docs, rels):
    return {
        'spec': 'chara_card_v2', 'spec_version': '2.0',
        'data': {
            'name': '万界仙录·设定助手',
            'description': CARD_DESC,
            'personality': '博闻、冷静、偶尔毒舌；说到设定时会引用原文出处，不编造体系。',
            'scenario': '用户翻开《万界仙录》，想从书库里抽一个人物来写故事。',
            'first_mes': CARD_FIRST,
            'mes_example': CARD_EXAMPLE,
            'creator_notes': '自带世界书（character_book）：252 条四类素材 + 154 篇世界观/修炼体系节选。'
                             '完整 1396 篇 + 检索工具见「万界仙录」SillyTavern 插件。',
            'system_prompt': '你是设定助手，从 attached lorebook 取材；素材标注「改编补全」时由你补全女性形态。',
            'post_history_instructions': '',
            'alternate_greetings': [
                '（书页停在一张空白的人像上。）「先定一个吧——境界、性情，或者只给我一件法宝的名字。」',
            ],
            'character_book': card_book(ents, docs, rels),
            'tags': ['修仙', '设定库', '女性角色', '万界仙录'],
            'creator': '万界仙录',
            'character_version': VERSION,
            'extensions': {'talkativeness': '0.3', 'fav': False, 'world': '万界仙录·素材'},
        },
    }


# ---------------------------------------------------------------- 打包

README_TXT = """万界仙录 (Wanjie Xianlu) v{ver} —— 修仙资料库 SillyTavern 插件

【一、装插件（想要检索工具、随机抽取、面板时用）】
1. 解压本包，把整个 wanjie-xianlu 文件夹放到：
   <SillyTavern>/public/scripts/extensions/third-party/
   最终路径应为 .../third-party/wanjie-xianlu/manifest.json
2. 刷新酒馆页面（Ctrl+F5），扩展面板里会出现「万界仙录」。
3. 打开面板 → 设置 → 点「导入内置资料包」（约 10 秒）。
4. 首页显示 1396 篇原文 / 252 条素材 / 318 条关联，即成。
5. 设置页有「自检」按钮，跑一遍确认工具与命令都注册上了。

【二、不装插件，只想用世界书（任何酒馆都能导入）】
在世界书面板点「导入」，选：
  · 世界书-万界仙录-素材.json      252 条四类素材（推荐）
  · 世界书-万界仙录-设定原文.json  1396 篇设定节选（大，按需）

【三、角色卡（单文件，导入即用）】
角色卡-万界仙录-设定助手.json —— 内嵌世界书，导入后直接开聊抽角色。

【四、给制卡器 / 别的程序调用（对接/ 目录）】
· 对接/制卡器调用规范.md      接口与参数、返回值、抽卡流程、错误处理
· 对接/制卡器提示词.md        可直接粘给模型的提示词（三种接法）
· 对接/schemas/*.json         5 个 Function Tool 的 OpenAI 格式定义与返回 Schema
· 对接/pick_random.py         离线随机抽取 CLI（算法与插件一致，同 seed 结果相同）
· 对接/效果样例.md            一次随机取素材的实际输出（背景骨架 + 待模型补清单）
用法示例：
  python 对接/pick_random.py --category female_cultivator --count 3 --seed 42
  python 对接/pick_random.py --combo female_cultivator:1,female_artifact_spirit:2

【说明】
资料整理自 I:\\Desktop\\dsh杂\\xiuxian-main（1396 篇 Markdown 设定百科），
已转成结构化 JSONL：原文 1396 篇 / 四类素材 252 条 / 关联 318 条。
素材质量标注：原文可证 31、原文可推 7、待核查 149、改编补全 68。
「待核查」默认不参与抽取；器灵类素材按约定只给法宝名与形制。
单次抽取 1–10 条；同 seed + 同资料包 = 同结果。
"""


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:16]


def make_zip(path, idx):
    plugin = os.path.join(ROOT, 'plugin')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr('安装说明.txt', README_TXT.format(ver=VERSION))
        for base, _, files in os.walk(plugin):
            for fn in files:
                full = os.path.join(base, fn)
                rel = os.path.relpath(full, plugin)
                z.write(full, os.path.join('wanjie-xianlu', rel))
        kn_files = ['index.json'] + idx['entities'] + [idx['documents'], idx['relations'], idx.get('pools', 'indexes/surface_pools.json')]
        for rel in kn_files:
            z.write(os.path.join(KN, rel), os.path.join('wanjie-xianlu', 'knowledge', rel))
        # 对接文档与工具契约：给制卡器/第三方调用方
        extra = [
            ('schemas/xianlu-tools.openai.json', '对接/schemas/xianlu-tools.openai.json'),
            ('schemas/xianlu-tools.meta.json', '对接/schemas/xianlu-tools.meta.json'),
            ('schemas/xianlu-result.schema.json', '对接/schemas/xianlu-result.schema.json'),
            ('schemas/xianlu-enums.json', '对接/schemas/xianlu-enums.json'),
            ('docs/制卡器调用规范.md', '对接/制卡器调用规范.md'),
            ('docs/制卡器提示词.md', '对接/制卡器提示词.md'),
            ('tools/pick_random.py', '对接/pick_random.py'),
            ('docs/效果样例.md', '对接/效果样例.md'),
        ]
        for src_rel, arc in extra:
            full = os.path.join(ROOT, src_rel)
            if os.path.exists(full):
                z.write(full, arc)
    return path


def main():
    idx, docs, ents, rels = load()
    os.makedirs(DIST, exist_ok=True)
    made = []

    # 1 插件整包
    zp = os.path.join(DIST, 'wanjie-xianlu-v%s.zip' % VERSION)
    make_zip(zp, idx)
    made.append((zp, '插件整包，解压到 third-party 即装'))

    # 2 资料包（混排 JSONL）
    pk = os.path.join(DIST, '资料包-万界仙录-v%s.jsonl' % VERSION)
    with open(pk, 'w', encoding='utf-8', newline='\n') as f:
        for rec in docs:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        for rec in ents:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        for rec in rels:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    made.append((pk, '给已装插件用：面板「资料库管理 → 导入文件」'))

    # 3 世界书（素材）
    wi = build_entity_worldinfo(ents, rels)
    wp = os.path.join(DIST, '世界书-万界仙录-素材.json')
    json.dump(wi, open(wp, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    made.append((wp, '%d 条四类素材，任何酒馆可导入' % len(ents)))

    # 4 世界书（设定原文）
    wi2 = build_doc_worldinfo(docs)
    wp2 = os.path.join(DIST, '世界书-万界仙录-设定原文.json')
    json.dump(wi2, open(wp2, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    made.append((wp2, '%d 篇设定节选（大文件）' % len(docs)))

    # 5 角色卡
    core_docs = [d for d in docs if str(d.get('source_file','')).startswith(('01-','02-'))]
    card = build_card(ents, core_docs, rels)
    cp = os.path.join(DIST, '角色卡-万界仙录-设定助手.json')
    json.dump(card, open(cp, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False, indent=1)
    made.append((cp, '单文件角色卡，内嵌 %d 条世界书' % len(card['data']['character_book']['entries'])))

    # 6 说明 + 清单
    rp = os.path.join(DIST, '导入说明.md')
    open(rp, 'w', encoding='utf-8', newline='\n').write(
        '# 万界仙录 v%s · 分发说明\n\n' % VERSION
        + '三种用法，任选：\n\n'
        + '## 1. 装插件（完整能力：检索工具 / 随机抽取 / 面板 / 自检）\n\n'
        + '1. 解压 `wanjie-xianlu-v%s.zip`，把 `wanjie-xianlu` 整个文件夹放进\n' % VERSION
        + '   `<SillyTavern>/public/scripts/extensions/third-party/`\n'
        + '   （最终路径 `.../third-party/wanjie-xianlu/manifest.json`）\n'
        + '2. `Ctrl+F5` 刷新 → 扩展面板出现「万界仙录」→ 设置 → **导入内置资料包**\n'
        + '3. 设置页点 **自检**，看到「各项通过」即可\n\n'
        + '## 2. 只导入世界书（不装插件也行）\n\n'
        + '世界书面板 → 导入 → 选 `世界书-万界仙录-素材.json`（252 条）；需要设定原文再导 `世界书-万界仙录-设定原文.json`（1396 条，较大）。\n\n'
        + '## 3. 单文件角色卡\n\n'
        + '角色面板 → 导入 → 选 `角色卡-万界仙录-设定助手.json`，内嵌世界书，导入即用。\n\n'
        + '## 4. 给已装插件的人更新资料\n\n'
        + '面板「资料库管理 → 导入文件」选 `资料包-万界仙录-v%s.jsonl`（覆盖式导入，先清空再导更稳）。\n\n' % VERSION
        + '## 数据\n\n'
        + '- 原文 %d 篇 / 四类素材 %d 条 / 关联 %d 条\n' % (len(docs), len(ents), len(rels))
        + '- 质量：原文可证 31、原文可推 7、改编补全 68、待核查 149\n'
        + '- 素材分类：女修 24 / 神佛 6 / 器灵 86 / 异兽 139\n'
        + '- 来源：`I:\\Desktop\\dsh杂\\xiuxian-main`（1396 篇 Markdown 设定百科）\n'
    )
    made.append((rp, '三种用法说明'))

    lines = ['# 发布清单 v%s' % VERSION, '', '| 文件 | 大小 | 用途 | sha256 前16位 |', '| --- | --- | --- | --- |']
    for p, note in made:
        lines.append('| %s | %.1f KB | %s | `%s` |' % (
            os.path.basename(p), os.path.getsize(p) / 1024, note, sha(p)))
    mp = os.path.join(DIST, '发布清单.md')
    open(mp, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    made.append((mp, '本清单'))

    for p, note in made:
        print('%-46s %8.1f KB  %s' % (os.path.basename(p), os.path.getsize(p) / 1024, note))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
