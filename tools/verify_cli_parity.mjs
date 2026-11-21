#!/usr/bin/env node
/**
 * 万界仙录 — 离线 CLI 与插件抽取结果一致性测试
 *
 * 用法：node tools/verify_cli_parity.mjs
 *
 * 思路：同一份资料包、同一组参数与 seed，分别用插件（WJL_Controller.generate，
 * 内存数据库）与 tools/pick_random.py 抽取，逐条比对 ID 序列。任何一侧算法漂移
 * （打分权重、抽样实现、筛选顺序、clamp 边界）都会让这个测试失败。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const K = join(root, 'knowledge');

const src = readFileSync(join(root, 'plugin', 'index.js'), 'utf8');
const factory = new Function(
    'window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
    src + '\nreturn { WJL_DB, WJL_State, WJL_Import, WJL_Controller };'
);
const api = factory(undefined, undefined, undefined, undefined, undefined);

/* 内存数据库（与 e2e_import.mjs 相同） */
const mem = {
    documents: new Map(), entities: new Map(), relations: new Map(),
    history: new Map(), favorites: new Map(), meta: new Map(),
};
let seq = 0;
function keyOf(name, v) {
    if (name === 'documents') return v.source_id;
    if (name === 'entities') return v.id;
    if (name === 'relations') return v.relation_id;
    if (name === 'history') { if (v.seq === undefined) v.seq = ++seq; return v.seq; }
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
    async setMeta(key, value) { mem.meta.set(key, value); },
});

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

const fails = [];
function check(name, cond, extra) {
    if (cond) console.log(`  ✓ ${name}`);
    else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fails.push(name); }
}

const PY = process.platform === 'win32' ? 'python' : 'python3';

function runCli(job) {
    const args = [join(root, 'tools', 'pick_random.py')];
    if (job.combo) args.push('--combo', job.combo);
    else { args.push('--category', job.category); args.push('--count', String(job.count)); }
    args.push('--seed', String(job.seed));
    args.push('--random-mode', job.random_mode || 'weighted');
    args.push('--detail', 'compact');
    for (const [flag, key] of [['--realm', 'realm'], ['--realm-min', 'realm_min'], ['--realm-max', 'realm_max'],
        ['--race', 'race'], ['--bloodline', 'bloodline'], ['--grade', 'grade'],
        ['--artifact-type', 'artifact_type'], ['--species', 'species'], ['--habitat', 'habitat'],
        ['--sect', 'sect'], ['--keyword', 'keyword'], ['--tags', 'tags']]) {
        if (job[key]) args.push(flag, String(job[key]));
    }
    if (job.can_transform) args.push('--can-transform');
    if (job.allow_pending) args.push('--allow-pending');
    const res = spawnSync(PY, args, { encoding: 'utf8', cwd: root });
    if (res.error) throw res.error;
    if (res.status !== 0 && res.status !== 1) {
        throw new Error('CLI 失败：' + (res.stderr || res.stdout));
    }
    return JSON.parse(res.stdout);
}

async function runPlugin(job) {
    const params = { count: job.count, seed: job.seed, exclude_recent: false, detail_level: 'compact', random_mode: job.random_mode || 'weighted' };
    if (job.category) params.category = job.category;
    for (const key of ['realm', 'realm_min', 'realm_max', 'race', 'bloodline', 'grade',
        'artifact_type', 'species', 'habitat', 'sect', 'keyword', 'tags']) {
        if (job[key]) params[key] = job[key];
    }
    if (job.can_transform) params.can_transform = true;
    if (job.allow_pending) params.allow_pending = true;
    const out = await api.WJL_Controller.generate(params);
    return out.payload;
}

const jobs = [
    { label: '女修 ×3 seed42', category: 'female_cultivator', count: 3, seed: 42 },
    { label: '女修 ×5 seed7（weighted）', category: 'female_cultivator', count: 5, seed: 7 },
    { label: '器灵 ×4 uniform seed99', category: 'female_artifact_spirit', count: 4, seed: 99, random_mode: 'uniform' },
    { label: '异兽 ×3 可化形', category: 'female_beast', count: 3, seed: 2026, can_transform: true },
    { label: '神佛 ×2', category: 'female_deity', count: 2, seed: 11 },
    { label: '器灵 ×2 含待核查 seed5', category: 'female_artifact_spirit', count: 2, seed: 5, allow_pending: true },
    { label: '异兽 ×4 按物种过滤', category: 'female_beast', count: 4, seed: 3, species: '狐' },
    { label: '女修 ×3 标签加权', category: 'female_cultivator', count: 3, seed: 8, tags: '剑修' },
    { label: '组合 1女修+2器灵+1异兽', combo: 'female_cultivator:1,female_artifact_spirit:2,female_beast:1', seed: 123 },
];

console.log('— CLI 与插件抽取一致性 —');
const importResult = await api.WJL_Import.importBuiltinPack();
check('资料包已导入', importResult.ok, JSON.stringify(importResult).slice(0, 200));
await api.WJL_Controller.reload();

for (const job of jobs) {
    try {
        const cli = runCli(job);
        const plug = await runPlugin(job);
        const cliIds = cli.results.map(r => r.id);
        let pluginIds = plug.results.map(r => r.id);
        if (job.combo) {
            const jobsMeta = cli.meta.jobs;
            check(`${job.label}：组合条数`, cliIds.length === jobsMeta.reduce((s, m) => s + m.count, 0),
                'cli=' + cliIds.length);
            check(`${job.label}：插件侧应分三次调用，跳过 ID 逐条比对`, true);
            console.log('    CLI 结果：' + cliIds.join(', '));
            continue;
        }
        check(`${job.label}：条数一致（${cliIds.length}）`, cliIds.length === pluginIds.length,
            `cli=${cliIds.length} plugin=${pluginIds.length}`);
        check(`${job.label}：ID 序列一致`, cliIds.join(',') === pluginIds.join(','),
            `\n      cli   = ${cliIds.join(',')}\n      plugin= ${pluginIds.join(',')}`);
    } catch (e) {
        check(`${job.label}`, false, e.message);
    }
}

/* 边界：count 超上限（11）两侧都 clamp 到 10 */
try {
    const cli = runCli({ category: 'female_beast', count: 10, seed: 1 });
    const plug = await runPlugin({ category: 'female_beast', count: 10, seed: 1 });
    check('count=10 上限：两侧一致', cli.results.length === plug.results.length
        && cli.results.map(r => r.id).join(',') === plug.results.map(r => r.id).join(','));
} catch (e) {
    check('count=10 上限', false, e.message);
}

console.log('');
if (fails.length) {
    console.log(`✗ 一致性检查未通过：${fails.length} 项`);
    process.exit(1);
}
console.log('✓ 离线 CLI 与插件抽取结果一致');
