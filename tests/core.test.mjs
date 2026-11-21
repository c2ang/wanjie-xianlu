/**
 * 万界仙录 — 核心逻辑单元测试（Node，无浏览器）
 *
 * index.js 是经典脚本，这里用 Function 构造器把它加载进沙箱，
 * 只取纯逻辑（Schema / Query / Rng / Format / Import）做断言。
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8');

function loadCore() {
    const factory = new Function(
        'window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
        src + '\nreturn { WJL_Schema, WJL_Query, WJL_Rng, WJL_Format, WJL_Util, WJL_Import, WJL_Controller, WJL_State, WJL_CATEGORIES, WJL_Profile };'
    );
    return factory(undefined, undefined, undefined, undefined, undefined);
}

const core = loadCore();

function entity(over = {}) {
    return core.WJL_Schema.normalizeEntity({
        id: 'cult_0001',
        type: 'female_cultivator',
        name: '示例女修',
        summary: '一位以剑入道的女修',
        tags: ['剑修', '高冷'],
        fields: { realm: '元婴期', race: '人族', personality: '高冷' },
        gender_basis: '原文：该角色为女子',
        quality: 'verified',
        source_ids: ['doc_0001'],
        ...over,
    });
}

test('实体规范化：默认值与类型校验', () => {
    assert.throws(() => core.WJL_Schema.normalizeEntity({ name: 'x' }), /未知实体类型/);
    assert.throws(() => core.WJL_Schema.normalizeEntity({ type: 'female_cultivator' }), /缺少 name/);
    const e = entity();
    assert.equal(e.type, 'female_cultivator');
    assert.equal(e.status, 'active');
    assert.equal(e.quality, 'verified');
    assert.deepEqual(e.aliases, []);
    assert.equal(e.fields.realm, '元婴期');
});

test('女性依据识别', () => {
    assert.equal(core.WJL_Schema.hasFemaleEvidence(entity()), true);
    const noGender = core.WJL_Schema.normalizeEntity({
        id: 'beast_1', type: 'female_beast', name: '无名异兽', quality: 'inferred',
    });
    assert.equal(core.WJL_Schema.hasFemaleEvidence(noGender), false);
    const tagOnly = core.WJL_Schema.normalizeEntity({
        id: 'beast_2', type: 'female_beast', name: '青鸾', tags: ['女性'], quality: 'inferred',
    });
    assert.equal(core.WJL_Schema.hasFemaleEvidence(tagOnly), true);
});

test('境界等级解析', () => {
    assert.equal(core.WJL_Schema.realmRank('元婴期'), core.WJL_Schema.realmRank('元婴'));
    assert.ok(core.WJL_Schema.realmRank('化神期') > core.WJL_Schema.realmRank('金丹期'));
    assert.equal(core.WJL_Schema.realmRank('不存在的境界'), -1);
});

test('硬性条件：待核查默认排除', () => {
    const settings = { allowPending: false, allowAdaptation: true, recentWindow: 20 };
    const pending = entity({ id: 'cult_x', quality: 'pending' });
    const ok = entity({ id: 'cult_y' });
    const p = core.WJL_Query.normalizeParams({ category: 'female_cultivator' });
    assert.equal(core.WJL_Query.hardFilter(pending, p, { settings }), false);
    assert.equal(core.WJL_Query.hardFilter(ok, p, { settings }), true);
    assert.equal(core.WJL_Query.hardFilter(pending, { ...p, allowPending: true }, { settings }), true);
});

test('硬性条件：境界过滤与化形要求', () => {
    const settings = { allowPending: true, allowAdaptation: true };
    const e = entity();
    const hit = core.WJL_Query.normalizeParams({ category: 'female_cultivator', realm: '元婴期' });
    const miss = core.WJL_Query.normalizeParams({ category: 'female_cultivator', realm: '金丹期' });
    assert.equal(core.WJL_Query.hardFilter(e, hit, { settings }), true);
    assert.equal(core.WJL_Query.hardFilter(e, miss, { settings }), false);

    const beast = core.WJL_Schema.normalizeEntity({
        id: 'beast_0001', type: 'female_beast', name: '青鸾', quality: 'verified',
        gender_basis: '原文：化形为少女',
        fields: { human_form_condition: '修为达到五阶' },
    });
    const needTransform = core.WJL_Query.normalizeParams({ category: 'female_beast', can_transform: true });
    assert.equal(core.WJL_Query.hardFilter(beast, needTransform, { settings }), true);

    const noForm = core.WJL_Schema.normalizeEntity({
        id: 'beast_0002', type: 'female_beast', name: '石兽', quality: 'verified', gender_basis: '原文：雌性',
    });
    assert.equal(core.WJL_Query.hardFilter(noForm, needTransform, { settings }), false);
});

test('软性条件：标签匹配得分更高', () => {
    const a = entity({ id: 'cult_a', name: '甲', tags: ['剑修'], fields: { realm: '元婴期' } });
    const b = entity({ id: 'cult_b', name: '乙', tags: [], fields: { realm: '元婴期' } });
    const p = core.WJL_Query.normalizeParams({ category: 'female_cultivator', tags: ['剑修'] });
    assert.ok(core.WJL_Query.score(a, p) > core.WJL_Query.score(b, p));
    const ranked = core.WJL_Query.rank([b, a], p);
    assert.equal(ranked[0].e.id, 'cult_a');
});

test('随机数：同种子可复现', () => {
    const r1 = core.WJL_Rng.fromSeed(42);
    const r2 = core.WJL_Rng.fromSeed(42);
    const s1 = [r1(), r1(), r1()];
    const s2 = [r2(), r2(), r2()];
    assert.deepEqual(s1, s2);
    const r3 = core.WJL_Rng.fromSeed(43);
    assert.notDeepEqual(s1, [r3(), r3(), r3()]);
});

test('加权抽样：同种子同数据结果一致，且不放回', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const weights = [5, 1, 1, 1, 1];
    const pick1 = core.WJL_Rng.sampleWeighted(items, weights, 3, core.WJL_Rng.fromSeed(7));
    const pick2 = core.WJL_Rng.sampleWeighted(items, weights, 3, core.WJL_Rng.fromSeed(7));
    assert.deepEqual(pick1, pick2);
    assert.equal(new Set(pick1).size, 3);
    const all = core.WJL_Rng.sampleWeighted(items, weights, 10, core.WJL_Rng.fromSeed(7));
    assert.equal(all.length, 5);
    assert.equal(new Set(all).size, 5);
});

test('格式化：三档详细程度逐级增加', () => {
    const e = entity({ content: '完整的原文资料正文'.repeat(40) });
    const compact = core.WJL_Format.entityToResult(e, 'compact', 900);
    const standard = core.WJL_Format.entityToResult(e, 'standard', 3200);
    const complete = core.WJL_Format.entityToResult(e, 'complete', 7600);
    assert.ok(Object.keys(compact.facts).length <= Object.keys(standard.facts).length);
    assert.ok(Object.keys(complete.facts).length >= Object.keys(standard.facts).length);
    assert.equal(complete.content !== undefined, true);
    assert.equal(compact.content, undefined);
    assert.equal(compact.quality_label, '原文可证');
});

test('JSONL 解析：坏行不吞掉好行', () => {
    const text = [
        JSON.stringify({ id: 'a', type: 'female_beast', name: '甲', quality: 'verified' }),
        '{ 坏行 ',
        JSON.stringify({ id: 'b', type: 'female_beast', name: '乙', quality: 'verified' }),
    ].join('\n');
    const parsed = core.WJL_Import.parseJsonl(text, 't');
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.errors.length, 1);
    const cls = core.WJL_Import.classify(parsed.rows);
    assert.equal(cls.entities.length, 2);
    assert.equal(cls.invalid.length, 0);
});

test('导入分类：文档 / 实体 / 关联可区分', () => {
    const cls = core.WJL_Import.classify([
        { source_id: 'doc_1', title: '一篇文章', content: '正文', category: '世界观' },
        { id: 'cult_1', type: 'female_cultivator', name: '角色', quality: 'verified' },
        { relation_id: 'r1', source_entity_id: 'cult_1', target_entity_id: 'cult_2', relation_type: 'sister' },
        { foo: 'bar' },
    ]);
    assert.equal(cls.documents.length, 1);
    assert.equal(cls.entities.length, 1);
    assert.equal(cls.relations.length, 1);
    assert.equal(cls.invalid.length, 1);
});

test('检索控制器：返回结构与条件过滤', async () => {
    core.WJL_State.entities = [
        entity({ id: 'cult_0001', name: '苏冰凝', tags: ['剑修', '高冷'], fields: { realm: '元婴期' } }),
        entity({ id: 'cult_0002', name: '叶红绡', tags: ['魔女'], fields: { realm: '金丹期' } }),
        entity({ id: 'cult_0003', name: '萧月', tags: ['佛修'], quality: 'pending' }),
    ];
    core.WJL_State.entityMap = new Map(core.WJL_State.entities.map(e => [e.id, e]));
    core.WJL_State.settings = { ...core.WJL_State.settings, allowPending: false, allowAdaptation: true };

    const out = await core.WJL_Controller.search({ category: 'female_cultivator', keyword: '剑修' });
    assert.equal(out.payload.success, true);
    assert.equal(out.payload.results.length, 2);
    assert.equal(out.payload.results[0].name, '苏冰凝');
    assert.equal(out.payload.results.some(r => r.name === '萧月'), false);

    const realm = await core.WJL_Controller.search({ category: 'female_cultivator', realm: '金丹期' });
    assert.equal(realm.payload.results.length, 1);
    assert.equal(realm.payload.results[0].name, '叶红绡');
});

test('抽取控制器：种子里可复现（不含历史写入依赖）', async () => {
    const ents = [];
    for (let i = 0; i < 12; i++) {
        ents.push(entity({ id: 'cult_' + String(i).padStart(4, '0'), name: '女修' + i, tags: i % 3 === 0 ? ['剑修'] : [] }));
    }
    core.WJL_State.entities = ents;
    core.WJL_State.entityMap = new Map(ents.map(e => [e.id, e]));
    core.WJL_State.settings = { ...core.WJL_State.settings, allowPending: false, allowAdaptation: true, recentWindow: 0 };
    core.WJL_State.history = [];

    const a = await core.WJL_Controller.generate({ category: 'female_cultivator', count: 3, seed: 2024 });
    const b = await core.WJL_Controller.generate({ category: 'female_cultivator', count: 3, seed: 2024 });
    assert.equal(a.ok, true);
    assert.deepEqual(a.payload.results.map(r => r.id), b.payload.results.map(r => r.id));
    assert.equal(new Set(a.payload.results.map(r => r.id)).size, 3);

    const c = await core.WJL_Controller.generate({ category: 'female_cultivator', count: 3, seed: 2025 });
    assert.notDeepEqual(a.payload.results.map(r => r.id), c.payload.results.map(r => r.id));
});

test('抽取控制器：候选不足时给出警告而不是静默返回', async () => {
    core.WJL_State.entities = [entity({ id: 'cult_only' })];
    core.WJL_State.entityMap = new Map([['cult_only', core.WJL_State.entities[0]]]);
    core.WJL_State.settings = { ...core.WJL_State.settings, allowPending: false, allowAdaptation: true, recentWindow: 0 };
    const out = await core.WJL_Controller.generate({ category: 'female_cultivator', count: 3, seed: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.payload.results.length, 1);
    assert.ok(out.payload.meta.warnings.length > 0);
});

test('抽取控制器：空库时失败要说明原因', async () => {
    core.WJL_State.entities = [];
    core.WJL_State.entityMap = new Map();
    const out = await core.WJL_Controller.generate({ category: 'female_beast', count: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.payload.success, false);
    assert.match(out.payload.warnings[0], /没有满足条件/);
});

test('查询控制器：按 ID / 名称查找', () => {
    const e = entity({ id: 'cult_0009', name: '白素心', aliases: ['素心仙子'] });
    core.WJL_State.entities = [e];
    core.WJL_State.entityMap = new Map([['cult_0009', e]]);
    assert.equal(core.WJL_Controller.lookup({ id: 'cult_0009' }).payload.results[0].name, '白素心');
    assert.equal(core.WJL_Controller.lookup({ name: '素心仙子' }).payload.results[0].name, '白素心');
    assert.equal(core.WJL_Controller.lookup({ name: '不存在' }).ok, false);
});

test('原文检索：scope=document 按关键词返回片段', async () => {
    core.WJL_State.docCache = [
        { id: 'doc_0001', title: '器灵总览', category: '04-资源物品', source_path: '04-资源物品.txt#12',
          text: '器灵由法宝长期蕴养灵性而生，初生器灵懵懂如幼儿。', lower: '器灵由法宝长期蕴养灵性而生，初生器灵懵懂如幼儿。' },
        { id: 'doc_0002', title: '金丹期', category: '02-修炼体系', source_path: '02-修炼体系.txt#45',
          text: '金丹期修士体内结成金丹，寿元大增。', lower: '金丹期修士体内结成金丹，寿元大增。' },
    ];
    const out = await core.WJL_Controller.search({ scope: 'document', keyword: '器灵' });
    assert.equal(out.ok, true);
    assert.equal(out.payload.results.length, 1);
    assert.equal(out.payload.results[0].title, '器灵总览');
    assert.match(out.payload.results[0].snippet, /初生器灵/);

    const miss = await core.WJL_Controller.search({ scope: 'document', keyword: '不存在的词' });
    assert.equal(miss.payload.results.length, 0);
    assert.match(miss.payload.warnings.join(' '), /没有包含该关键词/);

    const noKw = await core.WJL_Controller.search({ scope: 'document' });
    assert.equal(noKw.ok, false);
    assert.match(noKw.payload.warnings.join(' '), /需要 keyword/);
    core.WJL_State.docCache = null;
});

test('原文检索：scope=auto 在实体不足时附带片段', async () => {
    core.WJL_State.entities = [entity({ id: 'cult_0001', name: '苏冰凝', tags: ['剑修'] })];
    core.WJL_State.entityMap = new Map(core.WJL_State.entities.map(e => [e.id, e]));
    core.WJL_State.settings = { ...core.WJL_State.settings, allowPending: false, allowAdaptation: true };
    core.WJL_State.docCache = [
        { id: 'doc_0001', title: '剑修总纲', category: '03-功法法术', source_path: '03-功法法术.txt#3',
          text: '剑修以剑证道，一往无前，宁可剑折不可心折。', lower: '剑修以剑证道，一往无前，宁可剑折不可心折。' },
    ];
    const out = await core.WJL_Controller.search({ scope: 'auto', category: 'female_cultivator', keyword: '剑修', limit: 5 });
    assert.equal(out.ok, true);
    assert.equal(out.payload.results.length, 1);
    assert.equal(out.payload.documents.length, 1);
    assert.match(out.payload.warnings.join(' '), /原文片段/);
    core.WJL_State.docCache = null;
});

test('器灵素材：法宝名条目默认可用，并注明「形态由模型补全」', () => {
    const spirit = core.WJL_Schema.normalizeEntity({
        id: 'spirit_09001',
        type: 'female_artifact_spirit',
        subtype: '器灵·法宝名',
        name: '诛仙剑',
        summary: '「诛仙剑」的器灵——素材只给法宝名与形制',
        tags: ['器灵', '法宝', '剑'],
        fields: { artifact_name: '诛仙剑', artifact_type: '剑', grade: '神器·天道杀器' },
        quality: 'adapted',
        adaptation_flag: true,
        source_ids: ['doc_0001'],
    });
    const p = core.WJL_Query.normalizeParams({ category: 'female_artifact_spirit' });
    assert.equal(core.WJL_Query.hardFilter(spirit, p, {}), true, '默认设置下（允许改编）法宝名器灵应进入候选池');

    const out = core.WJL_Format.entityToResult(spirit, 'standard', 3200);
    assert.match(out.material_note || '', /由模型补全/);
    assert.equal(out.facts['所属法宝'], '诛仙剑');

    const noAdapt = core.WJL_Query.hardFilter(spirit, p, { settings: { allowAdaptation: false, allowPending: false } });
    assert.equal(noAdapt, false, '关闭「允许改编」后应排除，避免把模型补全当成资料库事实');
});

test('背景骨架：女修拿到门派/境界/灵根/功法，姓名性格留给模型', () => {
    core.WJL_State.pools = {
        realms: ['凡人', '炼气', '筑基', '金丹', '元婴', '化神'],
        sects: [{ name: '青云宗', kind: '宗门', source_ids: ['doc_sect'] }],
        techniques: [{ name: '裂天拳', school: '攻击类', source_ids: ['doc_tech'] }],
        spirit_roots: [{ name: '火灵根', tier: '', source_ids: ['doc_root'] }],
        identities: [],
    };
    const cult = core.WJL_Schema.normalizeEntity({
        id: 'cult_00100', type: 'female_cultivator', subtype: '角色模板', name: '圣女型',
        summary: '身份：大宗门圣女', fields: { relationships: '身份：大宗门圣女', appearance: '清冷出尘' },
        quality: 'verified', source_ids: ['doc_cult'],
    });
    const bg = core.WJL_Profile.compose(cult, 42);
    assert.equal(bg.fields['所属门派'], '青云宗（宗门）');
    assert.equal(bg.fields['主修功法'], '裂天拳');
    assert.equal(bg.fields['灵根'], '火灵根');
    assert.ok(bg.fields['境界'], '应随机到一个境界');
    assert.ok(bg.to_be_authored.includes('姓名') && bg.to_be_authored.includes('性格'));
    assert.ok(bg.note && /由模型创作/.test(bg.note));
    // 同 seed 必须复现
    assert.deepEqual(core.WJL_Profile.compose(cult, 42).fields, bg.fields);
    // 不同 seed 允许不同
    const bg2 = core.WJL_Profile.compose(cult, 7);
    assert.equal(bg2.fields['所属门派'], '青云宗（宗门）', '池里只有一个门派时不变');

    const out = core.WJL_Format.entityToResult(cult, 'standard', 3200, 42);
    assert.ok(out.background && out.background.fields['所属门派'] === '青云宗（宗门）');

    const beast = core.WJL_Schema.normalizeEntity({
        id: 'beast_00001', type: 'female_beast', subtype: '妖兽', name: '九尾狐',
        summary: '狐族', fields: { species: '狐族', habitat: '青丘', bloodline: '九尾天狐' },
        quality: 'pending', source_ids: ['doc_beast'],
    });
    const bgb = core.WJL_Profile.compose(beast, 1);
    assert.equal(bgb.fields['物种'], '狐族');
    assert.equal(bgb.fields['栖息地'], '青丘');
    assert.ok(bgb.to_be_authored.includes('名字'));
});
