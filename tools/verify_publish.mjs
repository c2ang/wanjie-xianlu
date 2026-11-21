/**
 * 校验 publish/ 能否被酒馆「用 URL 安装」：根目录是插件本体、资料包齐全、能真正导入。
 *
 * 用法：node tools/verify_publish.mjs [publish 目录]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const P = process.argv[2] || join(root, 'publish');

const fails = [];
const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else fails.push(msg); };

// 1. 酒馆安装时必须能找到的文件（根目录 = 插件本体）
for (const f of ['manifest.json', 'index.js', 'style.css', 'ui/panel.html']) {
    ok(existsSync(join(P, f)), '根目录有 ' + f);
}
const mani = JSON.parse(readFileSync(join(P, 'manifest.json'), 'utf8'));
ok(mani.js === 'index.js' && mani.css === 'style.css', 'manifest 的 js/css 指向根目录文件');
ok(!!mani.display_name && !!mani.version, 'manifest 有 display_name / version（' + mani.version + '）');

// 2. 资料包完整（插件用相对路径 knowledge/… 拉取）
const idx = JSON.parse(readFileSync(join(P, 'knowledge/index.json'), 'utf8'));
for (const rel of idx.entities || []) ok(existsSync(join(P, 'knowledge', rel)), '资料包有 ' + rel);
ok(existsSync(join(P, 'knowledge', idx.pools || 'indexes/surface_pools.json')), '资料包有素材池');

// 3. 真跑一次导入（伪 fetch 从 publish/ 读文件，等价于浏览器 fetch 扩展目录）
const src = readFileSync(join(P, 'index.js'), 'utf8');
const factory = new Function('window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
    src + '\nreturn { WJL_DB, WJL_State, WJL_Import, WJL_Controller, WJL_Profile };');
const api = factory(undefined, undefined, undefined, undefined, undefined);

const mem = { documents: new Map(), entities: new Map(), relations: new Map(), history: new Map(), favorites: new Map(), meta: new Map() };
let seq = 0;
const keyOf = (n, v) => n === 'documents' ? v.source_id : n === 'entities' ? v.id : n === 'relations' ? v.relation_id
    : n === 'history' ? (v.seq === undefined ? (v.seq = ++seq) : v.seq) : n === 'favorites' ? v.id : v.key;
Object.assign(api.WJL_DB, {
    isAvailable: () => true,
    async open() { return true; },
    async getAll(n) { return Array.from(mem[n].values()); },
    async get(n, k) { return mem[n].get(k); },
    async put(n, v) { mem[n].set(keyOf(n, v), v); return v; },
    async putMany(n, vs) { for (const v of vs) mem[n].set(keyOf(n, v), v); },
    async count(n) { return mem[n].size; },
    async clear(n) { mem[n].clear(); },
    async clearAll() { for (const k of Object.keys(mem)) mem[k].clear(); },
    async delete(n, k) { mem[n].delete(k); },
    async getAllByIndex() { return []; },
    async meta(k, f) { return mem.meta.has(k) ? mem.meta.get(k) : f; },
    async getMeta(k, f) { return mem.meta.has(k) ? mem.meta.get(k) : f; },
    async setMeta(k, v) { mem.meta.set(k, v); },
});

globalThis.fetch = async (url) => {
    const m = String(url).match(/knowledge\/(.+)$/);
    if (!m) return { ok: false, status: 404, text: async () => '' };
    const p = join(P, 'knowledge', m[1]);
    if (!existsSync(p)) return { ok: false, status: 404, text: async () => '' };
    const text = readFileSync(p, 'utf8');
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

const res = await api.WJL_Import.importBuiltinPack('', null);
const stats = await api.WJL_Controller.stats();
ok(res && res.ok !== false, '导入未报错');
ok(stats.documents === 1396, '原文 1396 篇（实得 ' + stats.documents + '）');
ok(stats.entities === 252, '素材 252 条（实得 ' + stats.entities + '）');
ok(stats.relations === 318, '关联 318 条（实得 ' + stats.relations + '）');

// 4. 抽一条看背景骨架是否真的带出来
await api.WJL_Controller.reload();
const payload = await api.WJL_Controller.search({ category: 'female_cultivator', limit: 1, seed: 42 });
const first = payload.payload && payload.payload.results && payload.payload.results[0];
ok(!!(first && first.background && Object.keys(first.background.fields || {}).length >= 3),
    '抽取结果带背景骨架（' + (first && first.name) + '）');

console.log('');
if (fails.length) {
    console.log('✗ ' + fails.length + ' 项未通过：');
    for (const f of fails) console.log('   - ' + f);
    process.exitCode = 1;
} else {
    console.log('✓ publish/ 可直接用酒馆 URL 安装（根目录 manifest.json + 资料包导入通过）');
}
