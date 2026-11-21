# -*- coding: utf-8 -*-
"""从资料包的原文里抽出「门面素材池」：门派、境界、灵根、功法、身份。

为什么需要这一层：
    插件的产物不是一个人物，而是一份「背景骨架」——所属门派、身份、境界、
    灵根、主修功法。现有实体（圣女型/魔女型…）只提供身份与气质，门派与功法
    必须从资料库的原文池里随机配对，并且每条都能追溯出处。

输出：knowledge/indexes/surface_pools.json
    {
      "version": "1.2.0",
      "generated_at": "...",
      "realms": [...],
      "sects": [{name, kind, source_ids, evidence}],
      "techniques": [{name, school, source_ids}],
      "spirit_roots": [{name, tier, source_ids}],
      "identities": [{name, source_ids}],
      "counts": {...}
    }
"""
import io
import json
import os
import re
import sys
from collections import Counter, OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
K = os.path.join(ROOT, 'knowledge')
GEN_AT = '2026-11-21'
VERSION = '1.2.0'

REALMS = ['凡人', '炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘',
          '渡劫', '散仙', '地仙', '真仙', '天仙', '玄仙', '金仙', '太乙', '大罗', '道祖']

# ── 门派 ────────────────────────────────────────────────────────────────
# 从语料里按词频挑出来的具名势力。不自动收：资料里大量「大宗门 / 逐出宗门 /
# 代表门派」这类泛指与动作短语，正则无法稳定区分，所以用人工核过的白名单，
# 出处（source_ids）仍然从原文里回溯。
SECT_WHITELIST = [
    '天机阁', '万宝阁', '昆仑派', '蜀山剑派', '通天教', '大雷音寺', '蓬莱阁', '天工坊',
    '血魔宗', '天剑宗', '少林寺', '万剑阁', '珍宝阁', '青云门', '武当派', '轮回殿',
    '天魔宗', '幽冥教', '凌霄宝殿', '青云宗', '万毒门', '峨眉派', '正道联盟', '妖界联盟',
    '合欢宗', '万佛寺', '鬼王宗', '阴阳宗', '丹方阁', '灵宝阁', '天玄宗', '炼丹宗',
    '南天门', '妖族联盟', '太虚宗', '天工宗', '冰魄宗', '白骨教', '修罗殿', '尸魂殿',
    '血魔教', '血煞门', '雷音寺', '少林派', '天阵宗', '傀儡宗', '净土宗', '五毒教',
    '百草门', '时间神殿', '天都坊', '幽冥魔教', '逍遥派', '铸剑山庄', '星辰阁',
    '玄天道宗', '阴阳合欢宗', '万剑宗', '归墟派', '青城派', '金刚门', '丹鼎宗',
    '灵山佛门', '魔道六宗', '佛门四寺', '九大执事门', '散修联盟', '凡间商会',
]
SECT_KIND = {'寺': '佛门', '阁': '商盟', '坊': '商盟', '商会': '商盟', '派': '门派',
             '宗': '宗门', '门': '宗门', '殿': '殿阁', '教': '教派', '山庄': '世家',
             '联盟': '联盟'}


def mk_sect(name):
    kind = '势力'
    for suf in ('寺院', '山庄', '联盟', '商会', '寺', '阁', '坊', '派', '宗', '门', '殿', '教'):
        if name.endswith(suf):
            kind = SECT_KIND.get(suf, '势力')
            break
    return OrderedDict([('name', name), ('kind', kind), ('source_ids', [])])


def build_sects(docs):
    """白名单 × 原文回溯：每个门派记下它出现的第一篇原文。"""
    want = {n: mk_sect(n) for n in SECT_WHITELIST}
    for d in docs:
        text = d['title'] + '\n' + d['content']
        for name, rec in want.items():
            if rec['source_ids']:
                continue
            if name in text:
                rec['source_ids'] = [d['source_id']]
    out = [rec for rec in want.values() if rec['source_ids']]
    return out


def iter_docs():
    p = os.path.join(K, 'documents', 'source_documents.jsonl')
    with io.open(p, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def clean(s):
    return re.sub(r'\s+', '', str(s or ''))


# ── 功法 ────────────────────────────────────────────────────────────────
TECH_GENERIC = re.compile(
    r'(顶级|高级|初级|中级|基础|入门|通用|各类|常见|普通|上乘|极品|绝世|无上)?'
    r'(类功法|功法体系|技能分类|属性克制|战斗体系|战斗等级|战力计算|核查报告|目录|'
    r'功法法术|法术体系|功法品级|修炼体系|法术分类|功法分类|通用功法|顶级功法|高级功法|'
    r'基础功法|入门功法|进阶功法|各派功法|功法详解|功法大全|功法总览)')
TECH_SUFFIX = re.compile(r'(拳|剑|刀|掌|指|爪|腿|脚|鞭|枪|戟|棍|棒|锤|斧|叉|弓|弩|镖|匕|'
                         r'镰|耙|铲|戈|矛|锏|拐|杖|扇|伞|铃|音|步|身法|剑法|刀法|拳法|'
                         r'掌法|指法|腿法|鞭法|枪法|戟法|棍法|棒法|锤法|斧法|叉法|弓法|'
                         r'弩法|镖法|匕法|镰法|耙法|铲法|戈法|矛法|锏法|拐法|杖法|扇法|'
                         r'诀|经|典|术|功|大法|神通)$')


def build_techniques(docs):
    out = []
    for d in docs:
        if d['source_file'][:2] != '03':
            continue
        t = d['title']
        if len(t) < 3 or len(t) > 12:
            continue
        if TECH_GENERIC.search(t) or not TECH_SUFFIX.search(t):
            continue
        if re.match(r'^(顶级|高级|初级|中级|基础|通用|常见|普通|各类|上乘|极品|绝世|无上|'
                    r'入门|低阶|中阶|高阶|顶阶|一阶|二阶|三阶|四阶|五阶|六阶|七阶|八阶|九阶)', t):
            continue
        school = ''
        body = d['content']
        m = re.search(r'(攻击类|防御类|辅助类|遁术类|幻术类|炼丹类|炼器类|阵法类|符箓类|御兽类|'
                      r'剑修|刀修|体修|佛修|魔修|道修)', t + body[:200])
        if m:
            school = m.group(1)
        out.append(OrderedDict([
            ('name', t),
            ('school', school),
            ('source_ids', [d['source_id']]),
        ]))
    return out[:200]


# ── 灵根 ────────────────────────────────────────────────────────────────
ROOT_TABLE_RE = re.compile(r'^\|\s*([\u4e00-\u9fa5]{2,6}灵根)\s*\|', re.M)
ROOT_INLINE_RE = re.compile(r'([金木水火土冰雷风暗光]{1,3}灵根)')


def build_spirit_roots(docs):
    seen = OrderedDict()
    for d in docs:
        if d['source_file'][:2] != '02' or '灵根' not in d['title']:
            continue
        for name in ROOT_TABLE_RE.findall(d['content']):
            seen.setdefault(name, d['source_id'])
        for name in ROOT_INLINE_RE.findall(d['content']):
            seen.setdefault(name, d['source_id'])
    order = ['天灵根', '变异灵根', '单灵根', '双灵根', '三灵根', '四灵根', '五灵根', '杂灵根']
    for name in list(order):
        if name not in seen:
            # 等级表里的名字在正文里以「天灵根者」等形式出现
            for d in docs:
                if d['source_file'][:2] == '02' and '灵根' in d['title'] and name in d['content']:
                    seen[name] = d['source_id']
                    break
    out = []
    for name in order:
        if name in seen:
            out.append(OrderedDict([('name', name), ('tier', name), ('source_ids', [seen.pop(name)])]))
    for name, sid in seen.items():
        out.append(OrderedDict([('name', name), ('tier', ''), ('source_ids', [sid])]))
    return out[:24]


# ── 身份 ────────────────────────────────────────────────────────────────
IDENTITY_WORDS = ['外门弟子', '内门弟子', '亲传弟子', '真传弟子', '执事弟子', '宗门长老', '首席长老',
                  '峰主', '宗主', '掌门', '圣女', '仙子', '散修', '魔修', '妖修', '女帝', '公主',
                  '师姐', '师妹', '师娘', '道侣', '红颜知己', '护道者', '侍剑婢', '妖王', '丹修']


def build_identities(docs):
    """身份词从语料里「实际出现并有点击量」的池子来：词频 ≥3 的才收录，source_ids 指向出现处。"""
    out = []
    seen = set()
    for w in IDENTITY_WORDS:
        hits = [d for d in docs if w in (d.get('content') or '')]
        if len(hits) < 3:
            continue
        if w in seen:
            continue
        seen.add(w)
        out.append(OrderedDict([
            ('name', w),
            ('role', w),
            ('entity_id', ''),
            ('source_ids', [h['source_id'] for h in hits[:3]]),
        ]))
    return out


def main():
    docs = list(iter_docs())
    sects = build_sects(docs)
    techs = build_techniques(docs)
    roots = build_spirit_roots(docs)
    idents = build_identities(docs)
    data = OrderedDict([
        ('version', VERSION),
        ('generated_at', GEN_AT),
        ('realms', REALMS),
        ('sects', sects),
        ('techniques', techs),
        ('spirit_roots', roots),
        ('identities', idents),
        ('counts', OrderedDict([
            ('sects', len(sects)),
            ('techniques', len(techs)),
            ('spirit_roots', len(roots)),
            ('identities', len(idents)),
            ('realms', len(REALMS)),
        ])),
    ])
    out = os.path.join(K, 'indexes', 'surface_pools.json')
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(json.dumps(data['counts'], ensure_ascii=False))
    print('sects:', ', '.join(s['name'] for s in sects[:20]))
    print('roots:', ', '.join(r['name'] for r in roots))
    print('techs:', ', '.join(t['name'] for t in techs[:12]))


if __name__ == '__main__':
    sys.exit(main())
