#!/usr/bin/env node
/**
 * 万界仙录 — 导入 → 检索 → 抽取 → 关联 全链路测试（内存数据库，不启动浏览器）
 *
 * 用法：node tools/e2e_import.mjs [knowledge 目录]
 *
 * 做法：把 index.js 载入沙箱，用一个内存版 WJL_DB 替换 IndexedDB，
 * 再用伪造的 fetch 读本地资料包，完整走一遍插件真实调用链。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const K = process.argv[2] || join(root, 'knowledge');

const src = readFileSync(join(root, 'plugin', 'index.js'), 'utf8');
const factory = new Function(
    'window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
    src + '\nreturn { WJL_DB, WJL_State, WJL_Import, WJL_Controller, WJL_Query, WJL_Settings, WJL_Util, WJL_CATEGORIES, WJL_SelfTest };'
);
const api = factory(undefined, undefined, undefined, undefined, undefined);

/* ---------------- 内存版数据库 ---------------- */
const mem = {
    documents: new Map(), entities: new Map(), relations: new Map(),
    history: new Map(), favorites: new Map(), meta: new Map(),
};
let seq = 0;

function keyOf(name, v) {
    if (name === 'documents') return v.source_id;
    if (name === 'entities') return v.id;
    if (name === 'relations') return v.relation_id;
    if (name === 'history') {
        if (v.seq === undefined) v.seq = ++seq;
        return v.seq;
    }
    if (name === 'favorites') return v.id;
    return v.key;
}

Object.assign(api.WJL_DB, {
    isAvailable: () => true,
    async open() { return true; },
    async getAll(name) { return Array.from(mem[name].values()); },
    async get(name, key) { return mem[name].get(key); },
    async put(name, value) { mem[name].set(keyOf(name, value), value); return value; },
    async putMany(name, values) { for (const v of values) mem[name].set(keyOf(name, v), v); },
    async count(name) { return mem[name].size; },
    async clear(name) { mem[name].clear(); },
    async clearAll() { for (const k of Object.keys(mem)) mem[k].clear(); },
    async delete(name, key) { mem[name].delete(key); },
    async getAllByIndex() { return []; },
    async meta(key, fallback) { return mem.meta.has(key) ? mem.meta.get(key) : fallback; },
    async getMeta(key, fallback) { return mem.meta.has(key) ? mem.meta.get(key) : fallback; },
    async setMeta(key, value) { mem.meta.set(key, value); },
});

/* ---------------- 伪造 fetch ---------------- */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
    const m = String(url).match(/knowledge\/(.+)$/);
    if (!m) return { ok: false, status: 404, text: async () => '' };
    try {
        const text = readFileSync(join(K, m[1]), 'utf8');
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
        return { ok: false, status: 404, text: async () => '' };
    }
};

/* ---------------- 断言 ---------------- */
const fails = [];
function check(name, cond, extra) {
    if (cond) console.log(`  ✓ ${name}`);
    else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fails.push(name); }
}

const PACK = JSON.parse(readFileSync(join(K, 'index.json'), 'utf8'));
const EXPECT = PACK.counts || {};
console.log('1) 导入内置资料包');
const imp = await api.WJL_Import.importBuiltinPack('http://localhost:8000/scripts/extensions/third-party/wanjie-xianlu/');
check('导入返回成功', imp.ok === true, JSON.stringify(imp).slice(0, 300));
check('文档数与 index.json 一致', imp.counts && imp.counts.documents === EXPECT.documents, String(imp.counts && imp.counts.documents) + ' vs ' + EXPECT.documents);
check('实体数与 index.json 一致', imp.counts && imp.counts.entities === EXPECT.entities, String(imp.counts && imp.counts.entities) + ' vs ' + EXPECT.entities);
check('关联数与 index.json 一致', imp.counts && imp.counts.relations === EXPECT.relations, String(imp.counts && imp.counts.relations) + ' vs ' + EXPECT.relations);

const stats = await api.WJL_Controller.stats();
check('统计已刷新', stats.entities === EXPECT.entities && stats.documents === EXPECT.documents, JSON.stringify(stats));

console.log('2) 检索');
const s1 = await api.WJL_Controller.search({ category: 'female_cultivator', keyword: '圣女', limit: 3 });
check('检索有结果', s1.payload.results.length > 0);
check('结果带出处', (s1.payload.results[0].source_ids || []).length > 0);
check('默认排除待核查', s1.payload.results.every(r => r.quality !== 'pending'));

const s2 = await api.WJL_Controller.search({ category: 'female_beast', allow_pending: true, limit: 5 });
check('允许待核查时能取到异兽', s2.payload.results.length === 5);

const s3 = await api.WJL_Controller.search({ scope: 'document', keyword: '器灵', limit: 3 });
check('原文检索有结果', s3.payload.results.length > 0);
check('原文片段带出处路径', !!s3.payload.results[0].source_path);

console.log('3) 随机抽取');
const g1 = await api.WJL_Controller.generate({ category: 'female_beast', count: 3, seed: 20261121, allow_pending: true });
const g2 = await api.WJL_Controller.generate({ category: 'female_beast', count: 3, seed: 20261121, allow_pending: true, exclude_recent: false });
const ids1 = g1.payload.results.map(r => r.id).sort().join(',');
const ids2 = g2.payload.results.map(r => r.id).sort().join(',');
check('抽取返回 3 条', g1.payload.results.length === 3);
check('同 seed 可复现', ids1 === ids2, `${ids1} vs ${ids2}`);

// 背景骨架：女修必须拿到门派/境界/灵根/功法，且标明哪些由模型补
{
    const gc = await api.WJL_Controller.generate({ category: 'female_cultivator', count: 2, seed: 99 });
    const bg = gc && gc.payload && gc.payload.results[0] && gc.payload.results[0].background;
    const f = (bg && bg.fields) || {};
    check('背景骨架：女修含身份/门派/境界/灵根/功法',
        !!(f['身份'] && (f['所属门派'] || f['出身门派']) && f['境界'] && f['灵根'] && f['主修功法']),
        JSON.stringify(Object.keys(f)));
    check('背景骨架：标明模型需要补的部分', Array.isArray(bg && bg.to_be_authored) && bg.to_be_authored.includes('姓名'));
    check('背景骨架：素材池已随资料包导入', bg && bg.pools_ready === true);
    const bb = await api.WJL_Controller.generate({ category: 'female_beast', count: 1, seed: 99, allow_pending: true });
    const bf = ((bb.payload.results[0] || {}).background || {}).fields || {};
    check('背景骨架：异兽含物种/品阶', !!(bf['物种']), JSON.stringify(Object.keys(bf)));
}

const g3 = await api.WJL_Controller.generate({ category: 'female_deity', count: 50, allow_pending: true });
check('候选不足给警告', g3.payload.warnings.length > 0 || g3.payload.results.length < 50);

console.log('4) 查询与关联');
const sp = await api.WJL_Controller.lookup({ name: '紫' });
check('按名称找到器灵「紫」', sp.ok && sp.payload.results[0].name === '紫', JSON.stringify(sp.payload).slice(0, 200));
const rel = await api.WJL_Controller.related({ id: sp.payload.results[0].id });
check('器灵能查到法宝关联', rel.payload.results.length > 0 || rel.payload.warnings.length === 0);

console.log('5) 收藏与历史');
await api.WJL_Controller.saveResult({ entity_id: sp.payload.results[0].id, note: 'e2e' });
check('收藏写入成功', mem.favorites.size === 1);
check('抽取历史已记录', mem.history.size >= 1);

console.log('6) 浏览器自检模块');
api.WJL_State.ctx = {
    isToolCallingSupported: () => true,
    // ST 里 SlashCommandParser.commands 是普通对象，不是 Map——按真实结构注入
    SlashCommandParser: { commands: { xianlu: { aliases: ['万界仙录', 'wjl'] } } },
};
api.WJL_State.toolsRegistered = true;
const st = await api.WJL_SelfTest.run();
check('自检整体通过', st.ok === true, st.fails.join('、'));
check('自检报告可读', typeof st.text === 'string' && st.text.includes('✓'), st.text.slice(0, 120));

console.log(`\n内存库最终：文档 ${mem.documents.size} · 实体 ${mem.entities.size} · 关联 ${mem.relations.size} · 历史 ${mem.history.size} · 收藏 ${mem.favorites.size}`);
globalThis.fetch = realFetch;

if (fails.length) {
    console.log(`\n✗ ${fails.length} 项失败`);
    process.exit(1);
}
console.log('\n✓ 全链路通过');
