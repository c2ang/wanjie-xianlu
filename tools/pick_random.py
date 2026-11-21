#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""万界仙录 · 离线抽取 CLI

在酒馆之外按需抽素材（制卡器、批处理、脚本都可调用），算法与插件
`WJL_Controller.generate` 完全一致：同样的资料包 + 同样的参数 + 同样的
seed，得到的 ID 序列与插件返回的完全相同（见 tools/verify_cli_parity.mjs）。

用法示例
--------
    # 抽 3 位女修，可复现
    python tools/pick_random.py --category female_cultivator --count 3 --seed 42

    # 一次要「1 女修 + 2 器灵 + 1 异兽」（组合抽取，共用一个随机流）
    python tools/pick_random.py --combo female_cultivator:1,female_artifact_spirit:2,female_beast:1

    # 带硬性条件
    python tools/pick_random.py --category female_cultivator \
        --realm-min 金丹 --realm-max 化神 --tags 剑修 --detail complete

    # 只要名字
    python tools/pick_random.py --category female_artifact_spirit --count 5 --names-only

输出：默认打印 JSON（payload 结构与插件 Function Tool 返回值一致）；--format md
输出可直接粘进提示词的精简文本；--out 写入文件。
"""

import argparse
import io
import json
import math
import re
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_DATA = os.path.join(ROOT, 'knowledge')

# ---------------------------------------------------------------- 常量
CATEGORIES = {
    'female_cultivator': {
        'label': '女性修仙者',
        'file': 'female_cultivators.jsonl',
        'fields': [
            ('gender_basis', '女性依据'), ('race', '种族'), ('realm', '境界'),
            ('spirit_root', '灵根'), ('constitution', '特殊体质'), ('bloodline', '血脉'),
            ('cultivation_path', '修炼方向'), ('techniques', '功法法术'), ('sect', '宗门'),
            ('faction', '所属势力'), ('origin', '出身来历'), ('personality', '性格'),
            ('motivation', '目标动机'), ('appearance', '外貌'), ('relationships', '人物关系'),
        ],
    },
    'female_deity': {
        'label': '女性神佛',
        'file': 'female_deities.jsonl',
        'fields': [
            ('gender_basis', '女性依据'), ('divine_rank', '神位神格'), ('buddhist_rank', '佛门果位'),
            ('title', '尊号'), ('domain', '神职领域'), ('vows', '誓愿'), ('karma', '因果'),
            ('faith', '信仰体系'), ('realm', '所在神域'), ('daoist_site', '道场'),
            ('manifestations', '化身显现'), ('artifacts', '关联法宝'), ('source_evidence', '原文依据'),
        ],
    },
    'female_artifact_spirit': {
        'label': '女性器灵',
        'file': 'artifact_spirits.jsonl',
        'fields': [
            ('gender_basis', '女性依据'), ('artifact_name', '所属法宝'), ('artifact_type', '法宝类别'),
            ('grade', '法宝品阶'), ('manifestation_form', '显化形态'), ('origin_method', '诞生方式'),
            ('temperament', '性格'), ('abilities', '能力'), ('recognition_conditions', '认主条件'),
            ('growth_stage', '成长阶段'), ('limitations', '能力限制'), ('contract_relation', '契约关系'),
        ],
    },
    'female_beast': {
        'label': '女性异兽',
        'file': 'female_beasts.jsonl',
        'fields': [
            ('gender_basis', '女性依据'), ('species', '物种'), ('bloodline', '血脉'),
            ('beast_rank', '异兽等级'), ('habitat', '栖息地'), ('ecological_role', '生态位'),
            ('appearance', '外形'), ('innate_abilities', '天赋能力'), ('temperament', '性格'),
            ('human_form_condition', '化形条件'), ('contract_relation', '契约关系'),
        ],
    },
}

REALMS = ['凡人', '炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘',
          '渡劫', '散仙', '地仙', '真仙', '天仙', '玄仙', '金仙', '太乙', '大罗', '道祖']

QUALITY_LABEL = {
    'verified': '原文可证', 'inferred': '合理推导', 'adapted': '原创改编',
    'pending': '待核查', 'conflict': '存在冲突',
}

DETAIL_LEVELS = {'compact': 900, 'standard': 3200, 'complete': 7600}

DEFAULTS = {
    'detail_level': 'standard',
    'random_mode': 'weighted',
    'allow_adaptation': True,
    'allow_pending': False,
    'exclude_recent': True,
}


# ---------------------------------------------------------------- 工具函数
def norm(v):
    if v is None:
        return ''
    return ' '.join(str(v).lower().split())


def truncate(s, n):
    t = '' if s is None else str(s)
    t = t.strip()
    return t if len(t) <= n else t[:max(0, n - 1)] + '…'


def clamp(n, lo, hi):
    try:
        n = float(n)
    except (TypeError, ValueError):
        n = lo
    if math.isnan(n):
        n = lo
    return max(lo, min(hi, n))


def hash32(text):
    h = 2166136261
    for ch in str(text):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def realm_rank(text):
    t = str(text or '')
    for i in range(len(REALMS) - 1, -1, -1):
        if REALMS[i] in t:
            return i
    return -1


def js_len(s):
    """JS 的 String.length（UTF-16 码元数），用于与插件截断行为对齐。"""
    return len(str(s).encode('utf-16-le')) // 2


def js_truncate(s, n):
    t = str('' if s is None else s).strip()
    if js_len(t) <= n:
        return t
    cut = t.encode('utf-16-le')[:max(0, (n - 1) * 2)]
    return cut.decode('utf-16-le', 'ignore') + '…'


def has_female_evidence(e):
    gb = e.get('gender_basis') or ''
    if str(gb).strip():
        return True
    fields = e.get('fields') or {}
    if str(fields.get('gender_basis') or '').strip():
        return True
    import re
    if any(re.match(r'^(女|女性|女子|女性向|女主)$', str(t).strip()) for t in (e.get('tags') or [])):
        return True
    hay = (e.get('summary') or '') + (e.get('content') or '') + json.dumps(fields, ensure_ascii=False)
    return bool(re.search(r'女修|女仙|女子|少女|女性|女神|女帝|女尊|娘娘|圣女|师妹|师姐|女童', hay))


def haystack(e):
    parts = [e.get('name', ''), ' '.join(e.get('aliases') or []), ' '.join(e.get('tags') or []),
             e.get('summary') or '', e.get('gender_basis') or '']
    for v in (e.get('fields') or {}).values():
        parts.append(' '.join(map(str, v)) if isinstance(v, list) else str(v))
    return norm(' '.join(parts))


# ---------------------------------------------------------------- 随机数 / 抽样
M32 = 0xFFFFFFFF


def mulberry32(seed):
    """与 WJL_Rng.fromSeed 相同的 mulberry32（全程按 32 位无符号取模，等价于 JS 的 |0）。"""
    if seed is None or seed == '':
        a = int.from_bytes(os.urandom(4), 'big') & M32
    else:
        try:
            a = int(seed) & M32
        except (TypeError, ValueError):
            a = hash32(seed)
    if a == 0:
        a = 0x9E3779B9

    def next_float():
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = ((a ^ (a >> 15)) * (1 | a)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296.0

    return next_float


def sample_weighted(items, weights, count, rand):
    pool = [{'it': it, 'w': max(0.0001, float(w) if w else 1.0)} for it, w in zip(items, weights)]
    picked = []
    n = min(count, len(pool))
    for _ in range(n):
        total = sum(p['w'] for p in pool)
        r = rand() * total
        idx = 0
        for i, p in enumerate(pool):
            r -= p['w']
            if r <= 0:
                idx = i
                break
            idx = i
        picked.append(pool[idx]['it'])
        pool.pop(idx)
    return picked


def sample_uniform(items, count, rand):
    pool = list(items)
    picked = []
    n = min(count, len(pool))
    for _ in range(n):
        idx = int(rand() * len(pool))
        picked.append(pool[idx])
        pool.pop(idx)
    return picked


# ---------------------------------------------------------------- 筛选 / 打分
def hard_filter(e, p, settings):
    cat = p.get('category') or ''
    if cat and e.get('type') != cat:
        return False
    if e.get('status') in ('deprecated', 'conflict') and not p.get('include_deprecated'):
        return False
    allow_pending = p.get('allow_pending') or settings.get('allow_pending')
    allow_adapt = settings.get('allow_adaptation') if p.get('allow_adaptation') is None else p.get('allow_adaptation')
    quality = e.get('quality')
    if not allow_pending and quality in ('pending', 'conflict'):
        return False
    if not allow_adapt and (e.get('adaptation_flag') or quality == 'adapted'):
        return False
    if e.get('id') in (p.get('exclude_ids') or []):
        return False
    if not has_female_evidence(e) and not allow_adapt:
        return False

    fields = e.get('fields') or {}
    if p.get('realm'):
        rank = realm_rank(fields.get('realm') or fields.get('beast_rank') or '')
        want = realm_rank(p['realm'])
        if want >= 0 and rank != want:
            return False
        if want < 0 and norm(p['realm']) not in norm(fields.get('realm') or ''):
            return False
    if p.get('realm_min'):
        rank = realm_rank(fields.get('realm') or '')
        lo = realm_rank(p['realm_min'])
        if rank < 0 or (lo >= 0 and rank < lo):
            return False
    if p.get('realm_max'):
        rank = realm_rank(fields.get('realm') or '')
        hi = realm_rank(p['realm_max'])
        if rank < 0 or (hi >= 0 and rank > hi):
            return False
    for key in ('race', 'bloodline', 'grade', 'artifact_type', 'species', 'habitat', 'domain', 'sect'):
        val = p.get(key)
        if not val:
            continue
        raw = fields.get(key)
        vv = ' '.join(map(str, raw)) if isinstance(raw, list) else str(raw or '')
        if norm(val) not in norm(vv):
            return False
    if p.get('can_transform') and not str(fields.get('human_form_condition') or '').strip():
        return False
    return True


def score(e, p):
    w = 1.0
    hay = haystack(e)
    name_norm = norm(e.get('name', '') + ' ' + ' '.join(e.get('aliases') or []))
    if p.get('keyword'):
        k = norm(p['keyword'])
        if k in name_norm:
            w += 3.0
        elif k in hay:
            w += 1.5
    for tag in p.get('tags') or []:
        t = norm(tag)
        if t in name_norm:
            w += 2.0
        elif any(norm(x) == t for x in (e.get('tags') or [])):
            w += 2.0
        elif t in hay:
            w += 1.0
    if e.get('quality') == 'verified':
        w += 0.6
    if e.get('quality') == 'inferred':
        w += 0.3
    tags = e.get('tags') or []
    if tags:
        w += min(0.4, len(tags) * 0.05)
    return w


# ---------------------------------------------------------------- 输出格式化
def fact_lines(e, budget, level):
    cat = CATEGORIES.get(e.get('type'))
    if not cat:
        return []
    per_key = 90 if level == 'compact' else 160 if level == 'standard' else 400
    max_keys = 4 if level == 'compact' else 10 if level == 'standard' else 99
    lines = []
    fields = e.get('fields') or {}
    for key, label in cat['fields']:
        raw = fields.get(key)
        if raw is None or raw == '' or raw == []:
            continue
        val = '、'.join(map(str, raw)) if isinstance(raw, list) else str(raw)
        lines.append(label + '：' + js_truncate(val, per_key))
        if len(lines) >= max_keys:
            break
    text = '\n'.join(lines)
    if js_len(text) > budget:
        text = js_truncate(text, budget)
    return text.split('\n') if text else []


def load_pools(data_dir):
    p = os.path.join(data_dir, 'indexes', 'surface_pools.json')
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except OSError:
        return {'sects': [], 'techniques': [], 'spirit_roots': [], 'realms': REALMS, 'identities': []}


SECT_ALIGN = [
    (re.compile(r'魔|血|幽冥|修罗|尸魂|白骨|合欢|五毒|万毒|毒'), '魔道'),
    (re.compile(r'妖|兽'), '妖族'),
    (re.compile(r'佛|寺|禅|金刚'), '佛门'),
    (re.compile(r'商会|坊'), '商盟'),
    (re.compile(r'联盟'), '联盟'),
]

IDENTITY_ALIGN = [
    (re.compile(r'魔修'), ['魔道']),
    (re.compile(r'妖修|妖王'), ['妖族']),
    (re.compile(r'圣女|仙子|亲传弟子|真传弟子|内门弟子|外门弟子|执事弟子|师姐|师妹|峰主|宗主|掌门|宗门长老'),
     ['正道', '佛门', '世家', '殿阁', '门派', '宗门']),
    (re.compile(r'女帝|公主'), ['殿阁', '世家', '联盟', '妖族']),
    (re.compile(r'散修|丹修|道侣|红颜知己|护道者'), None),
]


def sect_align(name):
    n = str(name or '')
    for rx, align in SECT_ALIGN:
        if rx.search(n):
            return align
    return '正道'


IDENTITY_TIER = [
    (re.compile(r'长老|宗主|掌门|峰主|女帝|妖王|公主|殿主|城主|家主'), 2),
    (re.compile(r'圣女|仙子|亲传弟子|真传弟子|执事弟子|师姐|魔修|妖修|丹修|护道者'), 1),
    (re.compile(r'外门弟子|内门弟子|师妹|散修|道侣|红颜知己'), 0),
]


def ident_tier(name):
    for rx, tier in IDENTITY_TIER:
        if rx.search(str(name or '')):
            return tier
    return 1


def compose_background(e, seed, pools):
    """与插件 WJL_Profile.compose 逐项一致的背景骨架。"""
    f = e.get('fields') or {}
    rng = mulberry32('wjl-bg|%s|%s' % ('' if seed is None else seed, e.get('id')))

    def pick(arr):
        return arr[int(rng() * len(arr))] if arr else None

    def trim(v, n=46):
        return js_truncate(re.sub(r'\s+', ' ', str(v)).strip(), n) if v not in (None, '') else ''

    fields, prov = {}, {}
    def add(label, value, src=None):
        v = trim(value)
        if v:
            fields[label] = v
            if src:
                prov[label] = src

    t = e.get('type')
    authored = []
    note = ''
    if t == 'female_cultivator':
        raw = f.get('relationships') or f.get('gender_basis') or ''
        idtext = raw.split('：', 1)[1] if '：' in raw else raw
        idtext = re.split(r'[、，,；;]', str(idtext))[0].strip()
        id_word = bool(re.search(r'圣女|圣子|仙|神女|长老|掌门|宗主|弟子|门人|传人|散修|女帝|公主|师姐|师妹|师父|师尊|执事|护法|使者|阁主|殿主|岛主|城主|家主|妃|夫人|仙女|妖女|魔女|真人|真君|仙子|器灵|道侣|红颜', idtext))
        id_bad = (not idtext) or (not id_word) or js_len(idtext) > 20 or bool(re.search(r'型|模板|示例|核心|表现|过度|缺点|弱点', idtext))
        def ident_align(nm):
            rule = next((r for r in IDENTITY_ALIGN if r[0].search(nm)), None)
            return rule[1] if rule else None

        id_rule = None if id_bad else ident_align(idtext)
        sects = pools.get('sects') or []
        fit = [x for x in sects if id_rule and sect_align(x.get('name')) in id_rule] if id_rule else []
        sect = pick(fit or sects)
        align = sect_align((sect or {}).get('name'))
        high = [x for x in (pools.get('realms') or []) if realm_rank(x) >= 3] or (pools.get('realms') or [])
        realm_name = f.get('realm') or pick(high)
        ident_name = '' if id_bad else idtext
        if not ident_name:
            rr = realm_rank(realm_name)
            tiers = [1, 2] if rr >= 9 else ([1] if rr >= 4 else [0, 1])
            idents = pools.get('identities') or []
            ok = []
            for x in idents:
                r = ident_align(x.get('name', ''))
                if ident_tier(x.get('name', '')) in tiers and (not r or align in r):
                    ok.append(x)
            ident_name = (pick(ok or idents) or {}).get('name') or '宗门弟子'
        wanderer = bool(re.search(r'散修|游历', ident_name))
        if sect:
            name = '%s（%s）' % (sect['name'], sect['kind']) if sect.get('kind') else sect['name']
            add('出身门派' if wanderer else '所属门派', name, sect.get('source_ids'))
        add('身份', ident_name, 'library' if id_bad else 'entity')
        add('境界', realm_name, 'entity' if f.get('realm') else 'library')
        root = pick(pools.get('spirit_roots') or [])
        add('灵根', f.get('spirit_root') or (root or {}).get('name'), 'entity' if f.get('spirit_root') else 'library')
        tech_text = str(f.get('techniques') or '').strip()
        tech_ok = bool(tech_text) and js_len(tech_text) <= 14 and not re.search(r'[、，,]', tech_text) \
            and bool(re.search(r'(功|法|诀|经|术|掌|拳|指|腿|步|身法|剑法|刀法|枪法|神通|真解|大道|录|篇|咒|阵)$', tech_text))
        tech = pick(pools.get('techniques') or [])
        add('主修功法', tech_text if tech_ok else (tech or {}).get('name'), 'entity' if tech_ok else 'library')
        add('气质外形', f.get('appearance'), 'entity')
        authored = ['姓名', '年龄段与生日', '性格', '个人经历', '说话方式', '门派内的具体职务', '功法的招式细节']
        note = '门派/境界/灵根/功法为资料库随机配对（各自有原文出处），角色本身由模型创作。'
    elif t == 'female_deity':
        add('尊号', f.get('title') or e.get('name'), 'entity')
        add('神职', f.get('domain'), 'entity')
        add('道场', f.get('daoist_site'), 'entity')
        add('果位/神阶', f.get('divine_rank') or f.get('buddhist_rank'), 'entity')
        add('信众与香火', f.get('faith'), 'entity')
        authored = ['具体化身形象', '灵验传闻', '信众口中的故事']
        note = '尊号/神职/道场取自原文；化身细节与故事由模型创作。'
    elif t == 'female_artifact_spirit':
        add('依附法宝', f.get('artifact_name') or e.get('name'), 'entity')
        add('法宝类别', f.get('artifact_type'), 'entity')
        add('品阶', f.get('grade'), 'entity')
        add('显化形态', f.get('manifestation_form'), 'entity')
        add('能力与限制', f.get('abilities') or f.get('limitations'), 'entity')
        authored = ['器灵姓名', '女子形态与样貌', '性格', '认主经过', '与主人的相处方式']
        note = '素材只给法宝名与形制：器灵的女性形态、样貌、性格由模型补全。'
    elif t == 'female_beast':
        add('物种', f.get('species') or e.get('name'), 'entity')
        blood = str(f.get('bloodline') or '')
        if blood:
            head = blood.split('。')[0]
            blood = head[:60] + ('…' if len(head) > 60 else '')
        add('血脉', blood, 'entity')
        add('品阶', f.get('beast_rank'), 'entity')
        add('栖息地', f.get('habitat'), 'entity')
        add('天赋神通', f.get('innate_abilities'), 'entity')
        add('化形条件', f.get('human_form_condition'), 'entity')
        authored = ['化形后的女子形象', '名字', '性格', '与人类的相处']
        note = '物种/血脉/栖息地取自原文；化形后的女子样貌与性格由模型创作。'
    return {
        'fields': fields,
        'provenance': prov,
        'created_by': '资料库随机配对（seed 可复现）',
        'to_be_authored': authored,
        'pools_ready': bool(pools.get('sects')),
        'note': note,
    }


def entity_to_result(e, level, max_chars, seed=None, pools=None):
    cat = CATEGORIES.get(e.get('type'))
    budget = max(200, (max_chars or 3200) // 2)
    out = {
        'id': e.get('id'),
        'name': e.get('name'),
        'category': e.get('type'),
        'category_label': cat['label'] if cat else e.get('type'),
        'summary': js_truncate(e.get('summary'), 90 if level == 'compact' else 200 if level == 'standard' else 400),
        'tags': (e.get('tags') or [])[:(4 if level == 'compact' else 12)],
        'quality': e.get('quality'),
        'quality_label': QUALITY_LABEL.get(e.get('quality'), e.get('quality')),
        'adaptation_flag': bool(e.get('adaptation_flag')),
        'gender_basis': js_truncate(e.get('gender_basis'), 60 if level == 'compact' else 160),
        'source_ids': (e.get('source_ids') or [])[:(20 if level == 'complete' else 3)],
    }
    facts = {}
    for line in fact_lines(e, budget, level):
        idx = line.find('：')
        if idx > 0:
            facts[line[:idx]] = line[idx + 1:]
    out['facts'] = facts
    fields = e.get('fields') or {}
    if e.get('type') == 'female_artifact_spirit' and fields.get('artifact_name') \
            and '法宝名' in str(e.get('subtype') or ''):
        out['material_note'] = '素材只提供法宝名与形制；器灵的女性形态、样貌、性格由模型补全。'
    out['background'] = compose_background(e, seed, pools or {})
    if level == 'complete' and e.get('content'):
        out['content'] = js_truncate(e.get('content'), 800)
    return out


def render_md(results):
    if not results:
        return '（无匹配素材）'
    blocks = []
    for i, r in enumerate(results, 1):
        head = '%d. %s（%s｜%s）' % (i, r['name'], r['category_label'], r['quality_label'])
        body = '\n'.join('   %s：%s' % (k, v) for k, v in (r.get('facts') or {}).items())
        parts = [head]
        if r.get('summary'):
            parts.append('   ' + r['summary'])
        bg = r.get('background') or {}
        if bg.get('fields'):
            parts.append('   【背景骨架】' + '；'.join('%s：%s' % (k, v) for k, v in bg['fields'].items()))
        if bg.get('to_be_authored'):
            parts.append('   【待模型补】' + '、'.join(bg['to_be_authored']))
        if body:
            parts.append(body)
        if r.get('material_note'):
            parts.append('   ※ ' + r['material_note'])
        blocks.append('\n'.join(parts))
    return '\n\n'.join(blocks)


# ---------------------------------------------------------------- 主流程
def load_entities(data_dir, only=None):
    ents = []
    for key, cat in CATEGORIES.items():
        if only and key != only:
            continue
        path = os.path.join(data_dir, 'entities', cat['file'])
        if not os.path.exists(path):
            continue
        with open(path, 'r', encoding='utf-8-sig') as fh:
            for line in fh:
                line = line.strip()
                if line:
                    ents.append(json.loads(line))
    return ents


def parse_combo(text):
    """`female_cultivator:1,female_beast:2` → [(category, count), ...]"""
    pairs = []
    for part in str(text).split(','):
        part = part.strip()
        if not part:
            continue
        if ':' in part:
            k, v = part.split(':', 1)
            pairs.append((k.strip(), int(v)))
        else:
            pairs.append((part, 1))
    for k, _ in pairs:
        if k not in CATEGORIES:
            raise SystemExit('未知类别：%s（可选：%s）' % (k, ' / '.join(CATEGORIES)))
    return pairs


def build_params(args, category):
    return {
        'category': category,
        'count': int(clamp(args.count, 1, 10)),
        'keyword': args.keyword or '',
        'tags': [t for t in (args.tags or '').replace('，', ',').replace('、', ',').split(',') if t.strip()],
        'realm': args.realm or '',
        'realm_min': args.realm_min or '',
        'realm_max': args.realm_max or '',
        'race': args.race or '',
        'bloodline': args.bloodline or '',
        'grade': args.grade or '',
        'artifact_type': args.artifact_type or '',
        'species': args.species or '',
        'habitat': args.habitat or '',
        'domain': args.domain or '',
        'sect': args.sect or '',
        'can_transform': bool(args.can_transform),
        'allow_pending': bool(args.allow_pending),
        'allow_adaptation': None,
        'exclude_ids': [],
        'include_deprecated': False,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description='万界仙录 · 离线随机抽取（算法与插件一致）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('--category', help='female_cultivator / female_deity / female_artifact_spirit / female_beast')
    ap.add_argument('--combo', help='组合抽取，如 female_cultivator:1,female_beast:2（与 --category 二选一）')
    ap.add_argument('--count', type=int, default=1, help='数量 1–10，默认 1')
    ap.add_argument('--seed', help='随机种子（整数或字符串）；相同种子+相同数据=相同结果')
    ap.add_argument('--random-mode', choices=['weighted', 'uniform'], default='weighted')
    ap.add_argument('--detail', choices=['compact', 'standard', 'complete'], default='standard')
    ap.add_argument('--keyword')
    ap.add_argument('--tags', help='标签，逗号分隔，参与加权')
    ap.add_argument('--realm')
    ap.add_argument('--realm-min', dest='realm_min')
    ap.add_argument('--realm-max', dest='realm_max')
    ap.add_argument('--race')
    ap.add_argument('--bloodline')
    ap.add_argument('--grade')
    ap.add_argument('--artifact-type', dest='artifact_type')
    ap.add_argument('--species')
    ap.add_argument('--habitat')
    ap.add_argument('--domain')
    ap.add_argument('--sect')
    ap.add_argument('--can-transform', dest='can_transform', action='store_true', help='只取可化形的异兽')
    ap.add_argument('--allow-pending', dest='allow_pending', action='store_true', help='允许“待核查”素材')
    ap.add_argument('--no-adaptation', dest='allow_adaptation', action='store_false',
                    help='排除“原创改编”素材（器灵法宝名素材会因此被排除）')
    ap.add_argument('--names-only', dest='names_only', action='store_true', help='只输出名字')
    ap.add_argument('--format', choices=['json', 'md'], default='json')
    ap.add_argument('--data-dir', default=DEFAULT_DATA, help='资料包目录（含 entities/），默认 knowledge/')
    ap.add_argument('--out', help='写入文件而不是打印')
    args = ap.parse_args(argv)

    if not args.category and not args.combo:
        ap.error('需要 --category 或 --combo')

    settings = {
        'allow_adaptation': DEFAULTS['allow_adaptation'] if args.allow_adaptation else False,
        'allow_pending': DEFAULTS['allow_pending'],
    }
    entities = load_entities(args.data_dir)
    pools = load_pools(args.data_dir)
    if not entities:
        print('没有找到资料包：%s' % args.data_dir, file=sys.stderr)
        return 2

    seed_raw = args.seed
    rand = mulberry32(seed_raw)

    jobs = parse_combo(args.combo) if args.combo else [(args.category, int(clamp(args.count, 1, 10)))]
    for category, _ in jobs:
        if category not in CATEGORIES:
            ap.error('未知类别：%s' % category)

    results = []
    metas = []
    for category, count in jobs:
        params = build_params(args, category)
        params['count'] = count
        p = dict(params)
        pool = [e for e in entities if hard_filter(e, p, settings)]
        relaxed = []
        if len(pool) < count:
            relaxed.append('候选不足，已放宽“近期去重”限制（可能需要允许重复素材）')
        if not pool and not (p['allow_pending'] or settings['allow_pending']):
            p2 = dict(p, allow_pending=True)
            retry = [e for e in entities if hard_filter(e, p2, settings)]
            if retry:
                pool = retry
                relaxed.append('已包含“待核查”素材，请在使用时注明来源可信度')
        if not pool:
            metas.append({'category': category, 'count': 0, 'candidates': 0,
                          'relaxed': ['当前资料库中没有满足条件的候选，请放宽条件或先导入资料包']})
            continue
        pool.sort(key=lambda e: e['id'])
        if args.random_mode == 'uniform':
            picked = sample_uniform(pool, count, rand)
        else:
            weights = [score(e, p) for e in pool]
            picked = sample_weighted(pool, weights, count, rand)
        if len(pool) < count:
            relaxed.append('符合条件的素材只有 %d 条，少于请求的 %d 条' % (len(pool), count))
        for e in picked:
            results.append(entity_to_result(e, args.detail, DETAIL_LEVELS[args.detail], seed_raw, pools))
        metas.append({'category': category, 'count': len(picked), 'candidates': len(pool),
                      'relaxed': relaxed})

    payload = {
        'success': bool(results),
        'count': len(results),
        'detail_level': args.detail,
        'results': results,
        'warnings': [w for m in metas for w in (m.get('relaxed') or []) if not m['count']],
        'meta': {'seed': seed_raw if seed_raw is not None else None, 'jobs': metas},
    }

    if args.names_only:
        text = '\n'.join(r['name'] for r in results)
    elif args.format == 'md':
        text = render_md(results)
        if payload['warnings']:
            text += '\n\n⚠ ' + '；'.join(payload['warnings'])
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)

    if args.out:
        with open(args.out, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text + '\n')
        print('已写入 %s（%d 条）' % (args.out, len(results)), file=sys.stderr)
    else:
        print(text)
    return 0 if results else 1


if __name__ == '__main__':
    sys.exit(main())
