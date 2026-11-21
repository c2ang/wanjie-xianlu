#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
万界仙录 · 资料库构建器
=======================================================================
输入：knowledge/raw/*.txt（12 个按类目整理好的 txt，共 1396 篇）
输出：
  knowledge/documents/source_documents.jsonl   原始篇目层（只读，不做结构化覆盖）
  knowledge/entities/*.jsonl                   四类实体（女修 / 神佛 / 器灵 / 异兽）
  knowledge/relations/relations.jsonl          实体关联层
  knowledge/indexes/*.json                     分类索引、标签索引
  knowledge/reports/*.md                       重复、质量、待核查、候选清单
  knowledge/index.json                         内置资料包清单（插件 importBuiltinPack 读取）

抽取原则（宁可少写，不可编造）：
  1. 原文一字不改；结构化只是「抽取 + 标注」，原文仍以篇目形式完整保留。
  2. 女性身份分三档证据：
       verified — 正文/字段/标题里明确写了女性（她 / 女修 / 少女 / 娘娘 / 雌 …）
       inferred — 类目本身限定女性（如「女性角色模板」的子类型），有文档级依据
       pending  — 没有任何女性依据（图鉴条目等），默认不参与抽取
  3. 字段只从原文的「键：值」结构（表格两列 / `- 键：值`）里取，取不到就留空。
  4. 输出确定性（同样输入 → 同样输出），便于 diff 与回归测试。
"""
import json
import re
import hashlib
import os
from collections import OrderedDict, Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'knowledge', 'raw')
K = os.path.join(ROOT, 'knowledge')
GEN_AT = '2026-11-21'

BANNER = re.compile(r'(?m)^━{20,}\n【第 (\d{3}) 篇】(.*)\n源文件：(.*)\n━{20,}\n')
HEAD = re.compile(r'^(◆|  ▸|    ·)\s*(.*)$')
KV_LINE = re.compile(r'^\s*[-*]?\s*([^：:|]{1,10})：\s*(.+)$')
HR = re.compile(r'^─{10,}$')

CATS = OrderedDict([
    ('female_cultivator', dict(
        label='女性修仙者', prefix='cult', file='female_cultivators.jsonl',
        fields=['gender_basis', 'race', 'realm', 'spirit_root', 'constitution', 'bloodline',
                'cultivation_path', 'techniques', 'sect', 'faction', 'origin', 'personality',
                'motivation', 'appearance', 'relationships'])),
    ('female_deity', dict(
        label='女性神佛', prefix='deity', file='female_deities.jsonl',
        fields=['gender_basis', 'divine_rank', 'buddhist_rank', 'title', 'domain', 'vows',
                'karma', 'faith', 'realm', 'daoist_site', 'manifestations', 'artifacts',
                'source_evidence'])),
    ('female_artifact_spirit', dict(
        label='女性器灵', prefix='spirit', file='artifact_spirits.jsonl',
        fields=['gender_basis', 'artifact_name', 'artifact_type', 'grade', 'manifestation_form',
                'origin_method', 'temperament', 'abilities', 'recognition_conditions',
                'growth_stage', 'limitations', 'contract_relation'])),
    ('female_beast', dict(
        label='女性异兽', prefix='beast', file='female_beasts.jsonl',
        fields=['gender_basis', 'species', 'bloodline', 'beast_rank', 'habitat',
                'ecological_role', 'appearance', 'innate_abilities', 'temperament',
                'human_form_condition', 'contract_relation'])),
])

FIELD_MAP = {
    'female_cultivator': [
        (r'性别', 'gender_basis'), (r'种族|族属', 'race'), (r'境界|修为', 'realm'),
        (r'灵根', 'spirit_root'), (r'体质', 'constitution'), (r'血脉', 'bloodline'),
        (r'修炼方向|道途', 'cultivation_path'), (r'功法|法术|招式|武器|常用武器', 'techniques'),
        (r'宗门|门派', 'sect'), (r'势力|阵营', 'faction'),
        (r'出身|来历|背景', 'origin'), (r'性格', 'personality'),
        (r'目标|动机|执念|追求', 'motivation'), (r'外貌|容貌|外形|气质|形象', 'appearance'),
        (r'关系|师承|恋慕|身份', 'relationships'),
    ],
    'female_deity': [
        (r'性别', 'gender_basis'), (r'神位|神格|神阶', 'divine_rank'),
        (r'果位|佛位', 'buddhist_rank'), (r'尊号|称号|名号', 'title'),
        (r'神职|司掌|领域|职责', 'domain'), (r'誓愿|大愿', 'vows'), (r'因果|业力', 'karma'),
        (r'信仰|香火|供奉', 'faith'), (r'神域|居所|世界', 'realm'),
        (r'道场|驻锡', 'daoist_site'), (r'化身|法相|显现', 'manifestations'),
        (r'法宝|法器|神器', 'artifacts'), (r'依据|出处', 'source_evidence'),
    ],
    'female_artifact_spirit': [
        (r'性别', 'gender_basis'), (r'所属法宝|本体|法宝名称|宿主', 'artifact_name'),
        (r'法宝类别|类别|类型', 'artifact_type'), (r'品阶|品级|等级', 'grade'),
        (r'显化|化形形态|形态', 'manifestation_form'), (r'诞生|来历|成因', 'origin_method'),
        (r'性格', 'temperament'), (r'能力|神通|功效', 'abilities'),
        (r'认主', 'recognition_conditions'),
        (r'成长|进阶', 'growth_stage'), (r'限制|代价|禁忌|缺陷', 'limitations'),
        (r'契约|绑定', 'contract_relation'),
    ],
    'female_beast': [
        (r'性别', 'gender_basis'), (r'物种|族属|种类|所属类别', 'species'),
        (r'血脉', 'bloodline'), (r'品阶|等级|阶位|成熟品阶|初始品阶', 'beast_rank'),
        (r'栖息地|分布|出没|领地', 'habitat'), (r'生态位|习性|食性', 'ecological_role'),
        (r'外形|外貌|体貌|体态|形态', 'appearance'), (r'天赋|神通|能力|技能', 'innate_abilities'),
        (r'性格', 'temperament'), (r'化形', 'human_form_condition'),
        (r'契约', 'contract_relation'),
    ],
}

NON_CHARACTER_NAMES = {
    '人物模板', '主角模板', '反派设定', '名字生成', '人物设定',
    '外挂类型', '道心类型', '目录', '总览', '概览',
}


FEMALE_STRONG = re.compile(
    r'女子|女性|少女|女修|仙子|女仙|女神|女妖|女鬼|女童|娘娘|圣母|圣女|公主|女帝|女王|'
    r'雌性|雌兽|母兽|女菩萨|女使者|她')
GENDER_FIELD = re.compile(r'性别[：:]\s*([女雌])')

DOC_REJECT = re.compile(
    r'体系|大全|总览|概览|指南|规则|清单|图鉴|报告|设定|参考|详解|介绍|框架|总结|说明|'
    r'问题|方案|分类|等级|划分|原理|应用|禁忌|影响|意义|定义|来源|历史|发展|演变|'
    r'价格|物价|经济|市场|管理|审查|核查|目录|地图|职业|世界|大陆|界$|名字|命名|生成')
SINGLE_SUBJECT_HINT = re.compile(r'◆\s*(概述|定义|简介|品阶|属性|外形|能力|来历|起源|特点)')

BEAST_RANK_HINT = re.compile(r'妖|兽|灵宠|灵兽')
DEITY_NAME = re.compile(
    r'女娲|王母|西王母|九天玄女|嫦娥|观音|菩萨|娘娘|圣母|圣女|女神|女仙|天妃|织女|洛神|'
    r'精卫|麻姑|何仙姑|碧霞|斗姆|后土|羲和|常羲|瑶姬|龙女|善财|佛母|明妃|空行母')
CULT_TITLE = re.compile(r'模板|人物|角色|红颜|魔女|妖女|圣女|女修|修士|散修|弟子|长老|师尊|掌门|剑修|丹修')

SPIRIT_NAME_HEADER = re.compile(r'器灵|法宝名称')
BEAST_NAME_HEADER = re.compile(r'妖兽名称|兽名|灵兽名称')
DEITY_NAME_HEADER = re.compile(r'菩萨|神佛|神祇|神名|佛名|女神|娘娘')

CULT_SECTION = re.compile(r'(型|模板|仙子|魔女|妖女|圣女|师姐|师妹|师尊|长老|掌门|女帝|女王|城主|散修|剑修|丹修|符修|道侣|红颜|青梅|侍女|公主)$')
DEITY_SECTION = re.compile(r'(菩萨|娘娘|圣母|圣女|女神|女仙|天妃|帝君|天王|真人|元君|道君)$')
BEAST_SECTION = re.compile(
    r'(兽|龙|凤|凰|狐|虎|蛇|狼|鸟|蝶|虫|龟|鹏|鸦|兔|鼠|豹|蛛|蟾|蚕|马|犀|鲲|雀|蛟|螭|蟠|虬|'
    r'饕餮|人面|枭|蜈蚣|蝎|蜂|蚊|鲸|鲨|獠|貔貅|狻猊|睚眦)$')
SPIRIT_SECTION = re.compile(r'(器灵|剑灵|器魂|灵识|魂灵)$')

# 法宝名 → 器灵素材（用户设定：器灵只需要法宝名，性别与形象由模型补全）
ARTIFACT_SUFFIX = re.compile(
    r'(剑|刀|枪|矛|钟|鼎|塔|幡|镜|珠|瓶|印|图|舟|扇|弓|箭|鞭|锤|斧|戟|针|索|伞|灯|琴|箫|笛|'
    r'环|镯|甲|铠|衣|冠|钗|戈|轮|袋|葫芦|令|钩|钺|棍|棒|杖|卷|册|尺|铃|鼓|镗|耙|铲|梭|镖)$')
ARTIFACT_GENERIC = re.compile(
    r'法剑|宝刀|灵珠|储物袋|符|法器|法宝|灵器|宝器|仙器|武器|装备|材料|大全|体系|总览|图鉴|'
    r'详解|参考|设定|一览|清单|分类|等级|排名|谱|制作|炼制|工艺|流程|价格|交易|黑市|经济|货币|'
    r'灵石|丹药|丹方|阵法|通用|类型|种类|说明|指南|入门|概览|九阶|八阶|七阶|六阶|五阶|四阶|三阶|二阶|一阶')

ARTIFACT_TYPE_MAP = [
    ('剑', '剑'), ('刀', '刀'), ('枪', '枪'), ('矛', '矛'), ('锤', '锤'), ('弓', '弓'), ('箭', '箭'),
    ('鞭', '鞭'), ('索', '索'), ('珠', '珠'), ('镜', '镜'), ('塔', '塔'), ('幡', '幡'), ('钟', '钟'),
    ('鼎', '鼎'), ('扇', '扇'), ('笛', '乐器'), ('箫', '乐器'), ('琴', '乐器'), ('印', '印'),
    ('图', '图卷'), ('甲', '甲胄'), ('铠', '甲胄'), ('衣', '法衣'), ('冠', '冠冕'), ('钗', '首饰'),
    ('环', '环饰'), ('镯', '环饰'), ('灯', '灯'), ('铃', '铃'), ('袋', '储物'), ('葫芦', '储物'),
    ('轮', '轮'), ('斧', '斧'), ('戟', '戟'), ('针', '针'), ('伞', '伞'), ('舟', '舟'),
    ('尺', '尺'), ('卷', '图卷'), ('册', '册'),
]


def artifact_type_of(name):
    for suf, label in ARTIFACT_TYPE_MAP:
        if name.endswith(suf):
            return label
    return '法宝'


SECTION_TITLE_OK = re.compile(r'^[\u4e00-\u9fff·A-Za-z0-9]{2,14}$')
SECTION_TITLE_BAD = re.compile(
    r'概述|定义|简介|分类|类型划分|等级|来源|历史|特点|规则|禁忌|体系|总览|说明|应用|'
    r'注意|参考|步骤|流程|对比|区别|关系|影响|作用|意义|原理|总结|小结|导语|导航|目录|'
    r'^\d+(\.\d+)*$|^[一二三四五六七八九十]+、')


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]


def clean(s):
    return re.sub(r'[ \t]+', ' ', s).strip()


def clip(s, n):
    s = clean(s)
    return s if len(s) <= n else s[:n] + '…'


def sentences(text):
    for part in re.split(r'(?<=[。！？；\n])', text):
        s = part.strip()
        if s:
            yield s


def read_docs():
    docs = []
    for fname in sorted(f for f in os.listdir(RAW) if f.endswith('.txt')):
        text = open(os.path.join(RAW, fname), encoding='utf-8-sig').read().replace('\r', '')
        parts = BANNER.split(text)
        for i in range(1, len(parts), 4):
            no, title, srcpath, body = parts[i], parts[i + 1].strip(), parts[i + 2].strip(), parts[i + 3]
            body = body.strip('\n')
            docs.append(dict(file=fname, no=int(no), title=title, srcpath=srcpath,
                             body=body, hash=sha(body),
                             uid=sha('%s|%d|%s|%s' % (fname, int(no), title, body))))
    return docs


def split_blocks(body):
    blocks = [dict(level=0, title='', lines=[])]
    for line in body.split('\n'):
        m = HEAD.match(line)
        if m:
            mark = m.group(1).strip()
            level = 1 if mark == '◆' else (2 if mark == '▸' else 3)
            blocks.append(dict(level=level, title=m.group(2).strip(), lines=[]))
        else:
            blocks[-1]['lines'].append(line)
    return blocks


def tables_of(lines):
    """返回 [(header, rows)]，header/rows 都是 cell 列表。"""
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i + 1].strip()):
            header = [c.strip() for c in line.strip().strip('|').split('|')]
            j, rows = i + 2, []
            while j < len(lines) and lines[j].startswith('|'):
                cells = [c.strip() for c in lines[j].strip().strip('|').split('|')]
                if len(cells) == len(header) and not re.match(r'^[-: ]+$', ''.join(cells)):
                    rows.append(cells)
                j += 1
            out.append((header, rows))
            i = j
            continue
        i += 1
    return out


def parse_kv(lines):
    kv = OrderedDict()
    for header, rows in tables_of(lines):
        if len(header) == 2 and len(rows) <= 12:
            for k, v in rows:
                if k and v:
                    kv.setdefault(k, v)
    for line in lines:
        if line.startswith('|'):
            continue
        m = KV_LINE.match(line)
        if m:
            k, v = m.group(1).strip(), clean(m.group(2))
            if k and v and len(k) <= 8 and not k.startswith('·'):
                kv.setdefault(k, v)
    return kv


SECTION_KEY = re.compile(r'^([\u4e00-\u9fff/·、]{2,10})\s*[：:]\s*(.*)$')


def flat_sections(body):
    """读出「品阶： 先天灵宝」以及「外观：」换行接正文这两种平铺写法。"""
    out, cur = {}, None
    for ln in body.split('\n'):
        line = ln.strip()
        if not line or line.startswith('│') or line.startswith('━') or line.startswith('────'):
            if cur is None:
                continue
            line = ''
        m = SECTION_KEY.match(line)
        if m and not re.match(r'^-|^\d+\.', line):
            cur = m.group(1).strip()
            val = m.group(2).strip()
            if cur not in out:
                out[cur] = val
            cur = None if val else cur
            continue
        if cur and len(line) < 200:
            out[cur] = (out.get(cur, '') + '\n' + line).strip()
    return out


def table_kv(lines):
    """把「| 项目 | 内容 |」两列表读成 dict。"""
    out = {}
    for ln in lines:
        ln = ln.strip()
        if not ln.startswith('|') or set(ln) <= set('|-: '):
            continue
        cells = [c.strip() for c in ln.strip('|').split('|')]
        if len(cells) != 2:
            continue
        k, v = cells
        if not k or not v or k in ('项目', '属性', '名称', '内容'):
            continue
        out[k] = v
    return out


def map_fields(category, kv):
    out, extra = OrderedDict(), OrderedDict()
    for k, v in kv.items():
        key = None
        for pat, name in FIELD_MAP[category]:
            if re.search(pat, k):
                key = name
                break
        if key:
            if key not in out and len(v) >= 1:
                out[key] = clip(v, 160)
        elif len(k) <= 6 and len(v) >= 2:
            extra[k] = clip(v, 60)
    return out, extra


def first_prose(lines, minlen=10):
    for line in lines:
        s = line.strip()
        if not s or s.startswith(('|', '│', '┌', '├', '└', '─', '-')):
            continue
        if HR.match(s) or len(s) < minlen:
            continue
        return s
    return ''


TABLE_HEADER_CELLS = {'说明', '内容', '描述', '含义', '备注'}


def is_table_noise(ln):
    """表格分隔行、表头行（如 | 特征 | 说明 |）不算正文。"""
    t = str(ln or '').strip()
    if not t:
        return True
    if re.match(r'^\|[\s:|-]+\|?$', t):
        return True
    if t.startswith('|'):
        cells = [c.strip() for c in t.strip('|').split('|') if c.strip()]
        if len(cells) >= 2 and cells[0] in ('特征', '项目', '属性', '字段', '维度', '方面', '类型') \
                and cells[1] in TABLE_HEADER_CELLS:
            return True
    return False


def lines_summary(lines, limit=120):
    """小节没有散文时，用前几行（含表格行，已清理）拼一句摘要。"""
    parts = []
    for ln in lines:
        if is_table_noise(ln):
            continue
        c = basis_clean(ln)
        if not c or c.startswith('━') or c.startswith('─'):
            continue
        if re.fullmatch(r'[-—\s：，；]+', c):
            continue
        parts.append(c)
        if len('；'.join(parts)) >= limit // 2 or len(parts) >= 3:
            break
    return clip('；'.join(parts), limit)


def basis_clean(s):
    """把「证据句」清理成可读文本：去掉表格竖线/引用前缀，表格行转「标签：内容」。"""
    s = str(s or '').strip()
    if not s:
        return ''
    s = re.sub(r'^│\s*', '', s)
    if s.startswith('|'):
        cells = [c.strip() for c in s.strip().strip('|').split('|')]
        cells = [c for c in cells if c]
        if len(cells) >= 2 and all(len(c) <= 40 for c in cells):
            s = cells[0] + '：' + '，'.join(cells[1:])
        else:
            s = '，'.join(cells)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^[-*+]\s*', '', s)
    return clip(s, 120)


# 明显是男性形象的说法：女子题材里出现就丢掉这一段
MALE_ONLY = re.compile(r'老者|老翁|老汉|男子|大汉|壮汉|少年|男童|和尚|道士|先生|老道')
FEMALE_HINT = re.compile(r'女子|女性|少女|女修|仙子|女仙|女神|娘娘|圣女|公主|女帝|女王|她|女')

_SEG_SPLIT = re.compile(r'[、，,；;/／]')


def drop_male_segments(v):
    """「慈祥老者、温婉女修」→「温婉女修」；只剩男性描述的整段丢掉。"""
    parts = [x.strip() for x in _SEG_SPLIT.split(str(v or '')) if x.strip()]
    if not parts:
        return ''
    kept = [x for x in parts if not (MALE_ONLY.search(x) and not FEMALE_HINT.search(x))]
    if not kept:
        return ''
    return '、'.join(kept)


def value_clean(v):
    """字段值清理：表格竖线、多余空白、男性形象段剔除。"""
    v = str(v or '').strip()
    if not v:
        return ''
    if v.startswith('|'):
        cells = [c.strip() for c in v.strip().strip('|').split('|')]
        cells = [c for c in cells if c]
        v = '，'.join(cells) if len(cells) > 2 else (cells[0] + '：' + cells[1] if len(cells) == 2 else cells[0])
    v = re.sub(r'\s+', ' ', v).strip()
    if '：' in v:
        label, _, rest = v.partition('：')
        rest = drop_male_segments(rest)
        return (label + '：' + rest) if rest else ''
    return drop_male_segments(v)


def gender_of(doc, blocks):
    """返回 (basis, level)；level ∈ verified / inferred / pending。"""
    body = doc['body']
    m = GENDER_FIELD.search(body)
    if m:
        s = next((x for x in sentences(body) if '性别' in x), '')
        return (clip(value_clean(s), 120), 'verified')
    for s in sentences(body):
        if FEMALE_STRONG.search(s):
            s = value_clean(s)
            if s:
                return (clip(s, 120), 'verified')
    if re.search(r'女性|红颜|仙子|魔女|圣女|神女|女神|娘娘|圣母', doc['title']):
        return ('篇目标题「%s」限定为女性条目' % doc['title'], 'inferred')
    if doc['file'].startswith('08-') and '模板' in doc['title'] and re.search(r'女性|红颜', body):
        return ('「%s」所属类目为女性角色模板' % doc['title'], 'inferred')
    return ('', 'pending')


def is_subject_doc(doc, category):
    t = doc['title']
    if len(t) > 16 or DOC_REJECT.search(t):
        return False
    if '📖' in doc['body'] or '内容导航' in doc['body'][:200]:
        return False
    if len(doc['body']) < 150:
        return False
    if not SINGLE_SUBJECT_HINT.search(doc['body']):
        return False
    if category == 'female_deity' and not DEITY_NAME.search(t):
        return False
    if category == 'female_cultivator' and not CULT_TITLE.search(t):
        return False
    return True


def detect_type(doc):
    f, t, b = doc['file'], doc['title'], doc['body']
    if f.startswith('07-'):
        if re.search(r'报告|审查|核查', t):
            return (None, None)
        return ('female_beast', 'species' if '/pets/' in doc['srcpath'] else 'beast')
    if f.startswith('04-'):
        if '器灵' in t or len(re.findall(r'器灵', b)) >= 3:
            return ('female_artifact_spirit', 'artifact_spirit')
        return (None, None)
    if f.startswith('06-'):
        if DEITY_NAME.search(t):
            return ('female_deity', 'deity')
        if len(DEITY_NAME.findall(b)) >= 2 and re.search(r'菩萨|娘娘|圣母|圣女|女神|女仙|天妃', b):
            return ('female_deity', 'deity')
        return (None, None)
    if f.startswith('08-'):
        if is_subject_doc(doc, 'female_cultivator') or CULT_TITLE.search(t):
            return ('female_cultivator', 'character')
        return (None, None)
    return (None, None)


class Builder:
    def __init__(self, docs):
        self.docs = docs
        self.doc_rows = []
        self.entities = []
        self.relations = []
        self.pending = []
        self.counters = Counter()
        self.by_name = {}
        self.doc_id = {}

    def build_documents(self):
        for d in self.docs:
            cat = d['file'].split('-', 1)[1].rsplit('.', 1)[0]
            sid = 'doc_' + d['uid']
            self.doc_id[d['uid']] = sid
            self.doc_rows.append(OrderedDict([
                ('source_id', sid),
                ('source_file', d['file']),
                ('title', d['title']),
                ('content', d['body']),
                ('category', cat),
                ('source_path', '%s · 第%03d篇' % (d['srcpath'], d['no'])),
                ('source_hash', d['hash']),
                ('import_time', GEN_AT),
                ('char_count', len(d['body'])),
            ]))

    def next_id(self, category):
        self.counters[category] += 1
        return '%s_%05d' % (CATS[category]['prefix'], self.counters[category])

    def emit(self, category, name, subtype, fields, summary, content, tags, doc, basis, quality):
        basis = basis_clean(basis)
        fields = OrderedDict((k, value_clean(v)) for k, v in fields.items() if value_clean(v))
        key = (category, name)
        if key in self.by_name:
            ent = self.by_name[key]
            sid = self.doc_id[doc['uid']]
            if sid not in ent['source_ids']:
                ent['source_ids'].append(sid)
            return ent
        if basis:
            fields = OrderedDict([('gender_basis', basis)] + [(k, v) for k, v in fields.items() if k != 'gender_basis'])
        ent = OrderedDict([
            ('id', self.next_id(category)),
            ('type', category),
            ('subtype', subtype),
            ('name', name),
            ('aliases', []),
            ('tags', tags),
            ('summary', clip(summary, 200)),
            ('fields', fields),
            ('content', clip(content, 3000)),
            ('source_ids', [self.doc_id[doc['uid']]]),
            ('gender_basis', basis),
            ('quality', quality),
            ('adaptation_flag', False),
            ('status', 'active' if quality == 'verified' else 'review'),
        ])
        self.entities.append(ent)
        self.by_name[key] = ent
        return ent

    def build_entities(self):
        for d in self.docs:
            category, subtype = detect_type(d)
            if not category:
                continue
            blocks = split_blocks(d['body'])
            basis, level = gender_of(d, blocks)
            if is_subject_doc(d, category):
                self.subject_entity(d, category, subtype, blocks, basis, level)
            self.catalog_entities(d, category, subtype, blocks, basis, level)
            self.section_entities(d, category, subtype, blocks, basis, level)
            if category == 'female_artifact_spirit':
                self.inline_spirits(d, subtype, blocks)
        self.build_artifact_spirits()

    def build_artifact_spirits(self):
        """法宝名 → 器灵素材。

        用户设定：器灵只需要给一个法宝的名字，酒馆的模型会自行赋予女性特质。
        所以把 04 里的法宝条目整篇转成「器灵」素材：name 就是法宝名，
        quality=adapted + adaptation_flag=True（明确「性别由模型补全」，不伪造女性依据），
        原文的「品阶 / 器灵 / 使用限制」等设定原样保留，供模型引用。
        """
        seen = set()
        for d in self.docs:
            if not d['file'].startswith('04-'):
                continue
            name = clean(d['title'])
            if not name or len(name) < 2 or len(name) > 10:
                continue
            if not ARTIFACT_SUFFIX.search(name) or ARTIFACT_GENERIC.search(name):
                continue
            if name in seen or ('female_artifact_spirit', name) in self.by_name:
                continue
            blocks = split_blocks(d['body'])
            bmap = {}
            for b in blocks:
                key = re.sub(r'^\d+(\.\d+)*[\.\s、]*', '', b['title']).strip()
                bmap.setdefault(key, []).extend(b['lines'])
            kv = {}
            for lines in bmap.values():
                kv.update(table_kv(lines))
            flat = flat_sections(d['body'])
            for k, v in flat.items():
                kv.setdefault(k, v)

            def pick(*keys):
                for k in keys:
                    for kk, vv in kv.items():
                        if kk == k and vv.strip():
                            return vv.strip()
                return ''

            grade_bits = [v for k, v in kv.items()
                          if ('品阶' in k or '等级' in k) and v.strip() and len(v) <= 40]
            if any('兽' in v for v in grade_bits):
                continue  # 04 里夹着的兽类条目（如椒图），不是法宝
            grade = ' / '.join(dict.fromkeys(grade_bits))[:40]
            if not grade:
                prose = [l.strip() for l in (bmap.get('品阶') or bmap.get('等级') or []) if l.strip()]
                if prose:
                    grade = clean(prose[0])[:40]
                    if '兽' in grade:
                        continue
            # 04 里也混着丹药、兽类条目（毒龙珠=毒丹、五色小圆珠=半成品丹、椒图=玄兽），都不是法宝
            if '丹' in grade:
                continue
            if len(re.findall(r'此丹|丹炉|丹方|丹香|丹药|丹成|丹纹', d['body'])) >= 2:
                continue
            look = pick('外观', '外形', '外形描写')
            if not look:
                look_lines = [l for l in (bmap.get('外观') or bmap.get('外形') or bmap.get('外形描写') or [])
                              if l.strip()]
                look = first_prose(look_lines)
            look = clip(look, 160)
            note = pick('器灵')
            if not note:
                tail = '\n'.join(bmap.get('武器特性') or bmap.get('法宝特性') or bmap.get('特性') or [])
                for line in tail.split('\n'):
                    if '器灵' in line:
                        note = clean(line.lstrip('-* '))
                        break
            note = clip(note, 120)
            limit = pick('使用限制', '副作用', '限制')
            limit = clip(limit, 80)
            atype = artifact_type_of(name)
            parts = []
            if grade:
                parts.append('品阶：' + grade)
            if atype and atype != '法宝':
                parts.append('类别：' + atype)
            if look:
                parts.append('形制：' + look)
            if note:
                parts.append('原文器灵注：' + note)
            if limit:
                parts.append('使用限制：' + limit)
            digest = '；'.join(parts)
            fields = OrderedDict([('artifact_name', name), ('artifact_type', atype)])
            if grade:
                fields['grade'] = grade
            summary = '「%s」的器灵——素材只给法宝名与形制；器灵的女子形态、样貌、性格由模型按人设补全。' % name
            tags = ['器灵', '法宝', atype]
            if grade:
                tags.append(re.split(r'[·/]', grade)[0])
            tags = [t for t in dict.fromkeys(t for t in tags if t and len(t) <= 12)][:6]
            ent = self.emit('female_artifact_spirit', name, '器灵·法宝名', fields,
                            summary, digest or summary, tags, d, '', 'adapted')
            ent['adaptation_flag'] = True
            ent['quality'] = 'adapted'
            seen.add(name)
            self.add_relation(ent, 'spirit_of_artifact', name,
                              '器灵寄于「%s」，法宝名即素材' % name)

    def inline_spirits(self, d, subtype, blocks):
        """「- 器灵：名为"紫"，形如紫衣少女」这类行内条目。"""
        pat = re.compile(r'器灵[：:]\s*名为\s*[「"“\']?([^「"”\'，,。；]{1,8})[」"”\']?([^。；]{0,180})')
        FEM = re.compile(r'少女|女子|女童|女修|仙子|老妪|女性|容颜|姿容|她')
        MALE = re.compile(r'老者|老翁|大汉|武士|男子|青年男子|壮汉|和尚|少年|男童')
        for b in blocks:
            text = '\n'.join(b['lines'])
            title = re.sub(r'^\d+(\.\d+)*[\.\s、]*', '', b['title']).strip()
            lookalike = bool(title) and 2 <= len(title) <= 12 and not SECTION_TITLE_BAD.search(title)
            artifact = title if lookalike else (d['title'] if 2 <= len(d['title']) <= 12 else '')
            for m in pat.finditer(text):
                name, tail = m.group(1).strip(), m.group(2).strip('，, ')
                if not name:
                    continue
                full = '器灵：名为「%s」，%s' % (name, tail)
                if MALE.search(tail) and not FEM.search(tail):
                    self.pending.append(dict(name=name, category='female_artifact_spirit',
                                             reason='原文明确为男性形态，未收入女性类目',
                                             where='%s · 第%03d篇' % (d['srcpath'], d['no'])))
                    continue
                fields = OrderedDict()
                if FEM.search(tail):
                    fields['manifestation_form'] = clip(tail, 140)
                    fields['temperament'] = clip(re.sub(r'^形如|^体型', '', tail), 90)
                    basis, quality = clip(full, 140), 'verified'
                else:
                    fields['temperament'] = clip(tail, 90)
                    basis, quality = '', 'pending'
                if artifact:
                    fields['artifact_name'] = artifact
                ent = self.emit('female_artifact_spirit', name, subtype + '_named', fields,
                                clip(full, 180), full, [name, d['title']], d, basis, quality)
                if artifact:
                    self.add_relation(ent, 'spirit_of_artifact', artifact,
                                      '器灵「%s」属于 %s' % (name, artifact))

    def section_entities(self, d, category, subtype, blocks, doc_basis, doc_level):
        """把「▸ 观音菩萨」「▸ 仙子型」这类小节也抽成实体。"""
        pattern = {
            'female_cultivator': CULT_SECTION,
            'female_deity': DEITY_SECTION,
            'female_beast': BEAST_SECTION,
            'female_artifact_spirit': SPIRIT_SECTION,
        }[category]
        for b in blocks:
            name = re.sub(r'^\d+(\.\d+)*[\.\s、]*', '', b['title'])
            name = re.sub(r'^[一二三四五六七八九十]+、', '', name).strip()
            if not name or not SECTION_TITLE_OK.match(name) or SECTION_TITLE_BAD.search(name):
                continue
            text = '\n'.join(b['lines'])
            if len(text.strip()) < 80:
                continue
            if not pattern.search(name):
                continue
            if category == 'female_deity' and not (
                    DEITY_NAME.search(name) or DEITY_SECTION.search(name)):
                continue
            kv = parse_kv(b['lines'])
            fields, extra = map_fields(category, kv)
            if extra:
                fields['extra'] = '；'.join('%s=%s' % (k, v) for k, v in list(extra.items())[:6])
            own = next((s for s in sentences(text) if FEMALE_STRONG.search(s)), '')
            if own:
                basis, level = clip(own, 120), 'verified'
            else:
                basis, level = doc_basis, doc_level
            tags = [d['title'], name]
            for key in ('species', 'beast_rank', 'grade', 'artifact_type', 'realm'):
                if fields.get(key):
                    tags.extend(re.split(r'[·、,，/\s]+', fields[key])[:2])
            tags = [t for t in dict.fromkeys(t for t in tags if t and len(t) <= 12)][:6]
            summary = first_prose(b['lines']) or lines_summary(b['lines'])
            quality = 'verified' if (level == 'verified' and fields) else \
                      ('inferred' if level in ('verified', 'inferred') else 'pending')
            if name in NON_CHARACTER_NAMES:
                continue
            if not fields and level == 'pending':
                continue
            ent = self.emit(category, name, subtype + '_section', fields, summary or name, text,
                            tags, d, basis if quality != 'pending' else '', quality)
            if quality == 'pending':
                self.pending.append(dict(name=name, category=category, reason='小节未标注性别',
                                         where='%s · 第%03d篇' % (d['srcpath'], d['no'])))
            for key, rtype in {'habitat': 'habitat_in', 'sect': 'member_of_sect',
                               'artifact_name': 'spirit_of_artifact'}.items():
                if fields.get(key) and len(fields[key]) <= 24:
                    self.add_relation(ent, rtype, fields[key], '%s：%s' % (rtype, fields[key]))

    def subject_entity(self, d, category, subtype, blocks, basis, level):
        kv = parse_kv(d['body'].split('\n'))
        fields, extra = map_fields(category, kv)
        if extra:
            fields['extra'] = '；'.join('%s=%s' % (k, v) for k, v in list(extra.items())[:6])
        summary = first_prose(blocks[1]['lines']) if len(blocks) > 1 else first_prose(d['body'].split('\n'))
        tags = [d['title']]
        for key in ('species', 'grade', 'beast_rank', 'artifact_type', 'race', 'realm'):
            if fields.get(key):
                tags.extend(re.split(r'[·、,，/\s]+', fields[key])[:3])
        tags = [t for t in dict.fromkeys(t for t in tags if t and len(t) <= 12)][:8]
        quality = 'verified' if (level == 'verified' and len(fields) >= 2) else \
                  ('inferred' if level in ('verified', 'inferred') and fields else 'pending')
        ent = self.emit(category, d['title'], subtype, fields, summary or d['title'], d['body'],
                        tags, d, basis, quality)
        if quality == 'pending':
            self.pending.append(dict(name=d['title'], category=category, reason='缺少女性身份依据',
                                     where='%s · 第%03d篇' % (d['srcpath'], d['no'])))
        return ent

    def catalog_entities(self, d, category, subtype, blocks, basis, level):
        title = d['title']
        catalog_doc = bool(re.search(r'图鉴|大全|清单|总览|列表|名录|一览', title))
        for header, rows in tables_of(d['body'].split('\n')):
            if len(rows) < 3 or len(header) < 2:
                continue
            first = header[0]
            ok = (category == 'female_beast' and BEAST_NAME_HEADER.search(first)) or \
                 (category == 'female_artifact_spirit' and SPIRIT_NAME_HEADER.search(first)) or \
                 (category == 'female_deity' and DEITY_NAME_HEADER.search(first))
            if not ok and not catalog_doc:
                continue
            if not ok:
                continue
            for cells in rows:
                name = cells[0].strip()
                if not name or len(name) > 20 or not re.search(r'[\u4e00-\u9fff]', name):
                    continue
                kv = OrderedDict((h, c) for h, c in zip(header, cells) if h and c)
                fields, extra = map_fields(category, kv)
                if '性别' in [h for h in header]:
                    gi = header.index('性别')
                    if gi < len(cells) and re.match(r'女|雌', cells[gi]):
                        row_basis = '表格字段「性别」标注为「%s」' % cells[gi]
                        row_level = 'verified'
                    else:
                        row_basis, row_level = '', 'pending'
                else:
                    g = next((s for s in sentences(' '.join(cells)) if FEMALE_STRONG.search(s)), '')
                    row_basis, row_level = (clip(g, 120), 'verified') if g else (basis, level)
                    if level == 'verified' and not g:
                        row_basis, row_level = '', 'pending'
                if extra:
                    fields['extra'] = '；'.join('%s=%s' % (k, v) for k, v in list(extra.items())[:6])
                summary = '｜'.join('%s：%s' % (h, c) for h, c in zip(header, cells) if c and c != name)
                tags = [t for t in dict.fromkeys(
                    [title] + [re.sub(r'^[一二三四五六七八九十]+、', '', t) for t in
                               [cells[header.index(h)] for h in header if re.search(r'属性|类别|类型|品阶|等级', h) and h in header]]
                ) if t and len(t) <= 12][:6]
                quality = 'verified' if (row_level == 'verified' and len(fields) >= 2) else \
                          ('inferred' if row_level in ('verified', 'inferred') and fields else 'pending')
                ent = self.emit(category, name, subtype + '_catalog', fields, summary,
                                '｜'.join(cells), tags, d, row_basis if quality != 'pending' else '',
                                quality)
                if quality == 'pending':
                    self.pending.append(dict(name=name, category=category,
                                             reason='表格条目未标注性别', where='%s · 第%03d篇' % (d['srcpath'], d['no'])))
                for h, c in zip(header, cells):
                    if re.search(r'栖息地|分布|地域', h) and ent['type'] == 'female_beast':
                        self.add_relation(ent, 'habitat_in', c, '栖息于 %s' % clip(c, 40))
                    if re.search(r'所属法宝|本体', h) and ent['type'] == 'female_artifact_spirit':
                        self.add_relation(ent, 'spirit_of_artifact', c, '器灵所属：%s' % clip(c, 40))

    def add_relation(self, ent, rtype, target, description):
        target = clean(target)
        if not target or len(target) > 40:
            return
        tid = ''
        hit = self.by_name.get((ent['type'], target)) or self.by_name.get(('female_artifact_spirit', target))
        if hit:
            tid = hit['id']
        self.relations.append(OrderedDict([
            ('relation_id', 'rel_%05d' % (len(self.relations) + 1)),
            ('source_entity_id', ent['id']),
            ('relation_type', rtype),
            ('target_entity_id', tid),
            ('target_label', target),
            ('description', description),
            ('source_ids', list(ent['source_ids'])),
        ]))

    def build_relations(self):
        mapping = {
            'female_cultivator': [('sect', 'member_of_sect'), ('faction', 'aligned_with')],
            'female_deity': [('domain', 'domain_of'), ('daoist_site', 'enshrined_at'),
                             ('artifacts', 'wields')],
            'female_artifact_spirit': [('artifact_name', 'spirit_of_artifact')],
            'female_beast': [('habitat', 'habitat_in'), ('bloodline', 'bloodline_from')],
        }
        for ent in self.entities:
            for key, rtype in mapping.get(ent['type'], []):
                val = ent['fields'].get(key)
                if val and len(val) <= 30:
                    self.add_relation(ent, rtype, val, '%s：%s' % (rtype, val))


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')


def main():
    docs = read_docs()
    b = Builder(docs)
    b.build_documents()
    b.build_entities()
    b.build_relations()

    tc = Counter(e['type'] for e in b.entities)
    qc = Counter(e['quality'] for e in b.entities)

    write_jsonl(os.path.join(K, 'documents', 'source_documents.jsonl'), b.doc_rows)
    for cat, meta in CATS.items():
        write_jsonl(os.path.join(K, 'entities', meta['file']),
                    [e for e in b.entities if e['type'] == cat])
    write_jsonl(os.path.join(K, 'relations', 'relations.jsonl'), b.relations)

    cat_index = OrderedDict()
    for cat, meta in CATS.items():
        ids = [e['id'] for e in b.entities if e['type'] == cat]
        sub = Counter(e['subtype'] for e in b.entities if e['type'] == cat)
        cat_index[cat] = OrderedDict([('label', meta['label']), ('count', len(ids)),
                                     ('by_subtype', dict(sub)), ('ids', ids)])
    tag_index = defaultdict(list)
    for e in b.entities:
        for t in e['tags']:
            tag_index[t].append(e['id'])
    os.makedirs(os.path.join(K, 'indexes'), exist_ok=True)
    json.dump(cat_index, open(os.path.join(K, 'indexes', 'category_index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    json.dump(dict(sorted(tag_index.items(), key=lambda kv: (-len(kv[1]), kv[0]))),
              open(os.path.join(K, 'indexes', 'tag_index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)

    # -------- 报告
    rep = os.path.join(K, 'reports')
    os.makedirs(rep, exist_ok=True)
    hashes, titles = defaultdict(list), defaultdict(list)
    for d in b.doc_rows:
        hashes[d['source_hash']].append(d)
        titles[d['title']].append(d)
    dup_hash = {h: v for h, v in hashes.items() if len(v) > 1}
    dup_title = {t: v for t, v in titles.items() if len(v) > 1}
    lines = ['# 重复资料检测报告', '',
             '- 总篇目：%d' % len(b.doc_rows),
             '- 完全重复（内容哈希相同）：%d 组' % len(dup_hash),
             '- 标题重复：%d 组' % len(dup_title), '',
             '> 只做标记，不删除任何原始篇目。', '']
    if dup_hash:
        lines += ['## 完全重复', '']
        for h, v in list(dup_hash.items())[:80]:
            lines.append('- `%s` ← %s' % (h, '；'.join(d['source_path'] for d in v)))
    if dup_title:
        lines += ['', '## 标题重复（内容未必相同）', '']
        for t, v in list(dup_title.items())[:80]:
            same = len({d['source_hash'] for d in v}) == 1
            lines.append('- %s ×%d%s' % (t, len(v), '（内容相同）' if same else '（内容不同，分别保留）'))
    open(os.path.join(rep, 'duplicate_report.md'), 'w', encoding='utf-8').write('\n'.join(lines))

    cov = defaultdict(Counter)
    for e in b.entities:
        for k in e['fields']:
            cov[e['type']][k] += 1
    lines = ['# 数据质量报告', '', '- 生成时间：%s' % GEN_AT,
             '- 篇目：%d' % len(b.doc_rows), '- 实体：%d' % len(b.entities),
             '- 关联：%d' % len(b.relations), '', '## 实体分布', '']
    for cat, meta in CATS.items():
        lines.append('- %s（`%s`）：%d' % (meta['label'], cat, tc[cat]))
    lines += ['', '## 质量分布', '']
    for q in ['verified', 'inferred', 'adapted', 'pending', 'conflict']:
        lines.append('- %s：%d' % (q, qc[q]))
    lines += ['', '## 字段覆盖率', '']
    for cat, meta in CATS.items():
        n = max(tc[cat], 1)
        lines += ['### %s' % meta['label'], '', '| 字段 | 覆盖 |', '|---|---|']
        for k in meta['fields']:
            lines.append('| %s | %.0f%% |' % (k, 100.0 * cov[cat][k] / n))
        lines.append('')
    open(os.path.join(rep, 'quality_report.md'), 'w', encoding='utf-8').write('\n'.join(lines))

    lines = ['# 待核查清单', '',
             '- 候选条目：%d 条' % len(b.pending), '',
             '> 这些条目**没有任何女性身份依据**，因此以 `pending` 入库，默认不参与抽取。',
             '> 需要人工确认性别、或改写为明确设定后，才能升级为 verified。', '',
             '| 名称 | 类别 | 原因 | 出处 |', '|---|---|---|---|']
    for c in b.pending[:600]:
        lines.append('| %s | %s | %s | %s |' % (c['name'], c['category'], c['reason'], c['where']))
    open(os.path.join(rep, 'pending_review.md'), 'w', encoding='utf-8').write('\n'.join(lines))

    for cat, meta in CATS.items():
        rows = [e for e in b.entities if e['type'] == cat]
        out = ['# %s 候选资料清单' % meta['label'], '',
               '- 条目数：%d' % len(rows), '- 生成时间：%s' % GEN_AT, '',
               '| ID | 名称 | 质量 | 概要 |', '|---|---|---|---|']
        for e in rows:
            out.append('| %s | %s | %s | %s |' % (e['id'], e['name'], e['quality'],
                                                  clip(e['summary'].replace('|', '｜'), 40)))
        open(os.path.join(rep, 'candidates_%s.md' % cat), 'w', encoding='utf-8').write('\n'.join(out))

    index = OrderedDict([
        ('name', '万界仙录·基础资料包'),
        ('version', '1.2.0'),
        ('generated_at', GEN_AT),
        ('documents', 'documents/source_documents.jsonl'),
        ('entities', ['entities/' + CATS[c]['file'] for c in CATS]),
        ('relations', 'relations/relations.jsonl'),
        ('pools', 'indexes/surface_pools.json'),
        ('counts', OrderedDict([('documents', len(b.doc_rows)), ('entities', len(b.entities)),
                                ('relations', len(b.relations))] + [(c, tc[c]) for c in CATS])),
    ])
    json.dump(index, open(os.path.join(K, 'index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    print(json.dumps(index['counts'], ensure_ascii=False))
    print('quality:', dict(qc))


if __name__ == '__main__':
    main()
