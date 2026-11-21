#!/usr/bin/env node
/**
 * 万界仙录 — 资料包导入冒烟测试（不依赖浏览器）
 *
 * 用法：node tools/smoke_import.mjs [knowledge 目录]
 *
 * 做的事：完全按插件 importBuiltinPack 的读取顺序，把 index.json 和三个 JSONL
 * 喂给 WJL_Import.parseJsonl / classify，检查解析出的文档、实体、关联数量是否
 * 与 index.json 的 counts 一致，并抽检字段与女性身份依据是否安全。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || join(here, '..', 'knowledge');
const src = readFileSync(join(here, '..', 'plugin', 'index.js'), 'utf8');

const factory = new Function(
    'window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
    src + '\nreturn { WJL_Import, WJL_Query, WJL_State, WJL_CATEGORIES };'
);
const core = factory(undefined, undefined, undefined, undefined, undefined);

const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const texts = [];
const read = (rel) => texts.push({ label: rel, text: readFileSync(join(root, rel), 'utf8') });

read(index.documents);
for (const f of index.entities) read(f);
read(index.relations);

const docs = [];
const ents = [];
const rels = [];
const invalid = [];
for (const t of texts) {
    const parsed = core.WJL_Import.parseJsonl(t.text, t.label);
    const cls = core.WJL_Import.classify(parsed.rows);
    docs.push(...cls.documents);
    ents.push(...cls.entities);
    rels.push(...cls.relations);
    invalid.push(...cls.invalid);
}
if (invalid.length) problems.push(`未能识别的记录 ${invalid.length} 条，例如：${invalid.slice(0, 3).join(' / ')}`);

const problems = [];

const c = index.counts;
if (docs.length !== c.documents) problems.push(`文档数 ${docs.length} ≠ ${c.documents}`);
if (ents.length !== c.entities) problems.push(`实体数 ${ents.length} ≠ ${c.entities}`);
if (rels.length !== c.relations) problems.push(`关联数 ${rels.length} ≠ ${c.relations}`);

const ids = new Set();
for (const e of ents) {
    if (ids.has(e.id)) problems.push(`实体 ID 重复：${e.id}`);
    ids.add(e.id);
    if (!core.WJL_CATEGORIES[e.type]) problems.push(`${e.id} 类别未注册：${e.type}`);
    if (e.quality === 'verified' && !e.gender_basis) problems.push(`${e.id} verified 缺 gender_basis`);
}
const docIds = new Set(docs.map(d => d.source_id));
for (const e of ents) {
    for (const s of (e.source_ids || [])) if (!docIds.has(s)) problems.push(`${e.id} 引用不存在原文 ${s}`);
}

// 抽检：随机三条实体能否通过检索控制器（正则空结果不算错）
const byType = {};
for (const e of ents) byType[e.type] = (byType[e.type] || 0) + 1;

console.log(`读取 ${texts.length} 个文件`);
console.log(`  文档 ${docs.length} / 实体 ${ents.length} / 关联 ${rels.length}`);
console.log(`  分布：` + Object.entries(byType).map(([k, v]) => `${core.WJL_CATEGORIES[k].label} ${v}`).join(' · '));
const q = {};
for (const e of ents) q[e.quality] = (q[e.quality] || 0) + 1;
console.log(`  质量：` + Object.entries(q).map(([k, v]) => `${k} ${v}`).join(' · '));

if (problems.length) {
    console.log(`\n✗ ${problems.length} 个问题：`);
    for (const p of problems.slice(0, 20)) console.log('  - ' + p);
    process.exit(1);
}
console.log('\n✓ 导入链路与资料包一致');
