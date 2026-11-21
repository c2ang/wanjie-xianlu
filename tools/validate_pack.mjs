#!/usr/bin/env node
/**
 * 万界仙录 — 资料包校验
 *
 * 用法：node tools/validate_pack.mjs [knowledge 目录]
 * 退出码：0 全部通过；1 存在错误。
 *
 * 校验项：
 *  - index.json 存在且结构完整
 *  - 各 JSONL 可逐行解析，无坏行
 *  - 实体 ID 唯一；必需字段非空；type/quality 合法
 *  - 实体 source_ids 都能在 documents 中找到
 *  - 关联两端实体都存在
 *  - 统计数与实际行数一致
 *  - 女性身份依据：verified 必须有 gender_basis
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');

const TYPES = new Set(['female_cultivator', 'female_deity', 'female_artifact_spirit', 'female_beast']);
const QUALITY = new Set(['verified', 'inferred', 'adapted', 'pending', 'conflict']);

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

function readJsonl(rel) {
    const path = join(root, rel);
    if (!existsSync(path)) {
        err(`缺少文件：${rel}`);
        return [];
    }
    const text = readFileSync(path, 'utf8');
    const rows = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
        if (!line.trim()) return;
        try {
            rows.push(JSON.parse(line));
        } catch (e) {
            err(`${rel}:${i + 1} JSON 解析失败：${e.message}`);
        }
    });
    return rows;
}

const indexPath = join(root, 'index.json');
if (!existsSync(indexPath)) {
    console.error('✗ 找不到 index.json：' + indexPath);
    process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
for (const k of ['name', 'version', 'documents', 'entities', 'relations', 'counts']) {
    if (!(k in index)) err(`index.json 缺少字段 ${k}`);
}

const docs = readJsonl(index.documents);
const docIds = new Set();
for (const d of docs) {
    const id = d.source_id || d.id;
    if (!id) { err('文档缺少 source_id'); continue; }
    if (docIds.has(id)) err(`文档 ID 重复：${id}`);
    docIds.add(id);
    if (!d.title) warn(`文档 ${id} 缺少 title`);
    if (!String(d.content || '').trim()) warn(`文档 ${id} 正文为空`);
}

const entityIds = new Set();
let entityCount = 0;
const byType = {};
for (const rel of index.entities || []) {
    const rows = readJsonl(rel);
    for (const e of rows) {
        entityCount++;
        const id = e.id;
        if (!id) { err(`${rel} 中实体缺少 id`); continue; }
        if (entityIds.has(id)) err(`实体 ID 重复：${id}`);
        entityIds.add(id);
        if (!TYPES.has(e.type)) err(`${id} type 非法：${e.type}`);
        else byType[e.type] = (byType[e.type] || 0) + 1;
        if (!e.name) err(`${id} 缺少 name`);
        if (!QUALITY.has(e.quality)) err(`${id} quality 非法：${e.quality}`);
        if (e.quality === 'verified' && !e.gender_basis) {
            err(`${id} 标记 verified 但缺少 gender_basis（女性身份依据）`);
        }
        if (!Array.isArray(e.source_ids) || !e.source_ids.length) {
            warn(`${id} 没有 source_ids，无法追溯原文`);
        } else {
            for (const s of e.source_ids) {
                if (!docIds.has(s)) err(`${id} 引用了不存在的原文 ${s}`);
            }
        }
        if (e.fields && typeof e.fields !== 'object') err(`${id} fields 不是对象`);
    }
}

const relations = readJsonl(index.relations);
for (const r of relations) {
    if (!r.relation_id) err('关联缺少 relation_id');
    if (!entityIds.has(r.source_entity_id)) err(`关联 ${r.relation_id} 起点实体不存在：${r.source_entity_id}`);
    if (!r.target_entity_id) {
        // 资料库外对象（如法宝本体不在四类实体中）只保留名称，不算错误
        if (!r.target_label) warn(`关联 ${r.relation_id} 既无 target_entity_id 也无 target_label`);
    } else if (!entityIds.has(r.target_entity_id)) {
        err(`关联 ${r.relation_id} 终点实体不存在：${r.target_entity_id}`);
    }
    if (!r.relation_type) warn(`关联 ${r.relation_id} 缺少 relation_type`);
}

// 门面素材池
const poolsPath = index.pools ? join(root, index.pools) : join(root, 'indexes', 'surface_pools.json');
if (!existsSync(poolsPath)) {
    warn('缺少门面素材池 indexes/surface_pools.json（背景骨架里的门派/功法会缺失）');
} else {
    const pools = JSON.parse(readFileSync(poolsPath, 'utf8'));
    const docIds = new Set(docs.map(d => d.source_id));
    for (const k of ['sects', 'techniques', 'spirit_roots']) {
        const arr = pools[k] || [];
        if (!arr.length) warn(`素材池 ${k} 为空`);
        for (const item of arr) {
            for (const sid of (item.source_ids || [])) {
                if (!docIds.has(sid)) err(`素材池 ${k}「${item.name}」指向不存在的原文 ${sid}`);
            }
        }
    }
    if ((pools.sects || []).length < 20) warn(`门派池只有 ${(pools.sects || []).length} 条，建议 ≥20`);
    console.log(`  素材池：门派 ${(pools.sects || []).length} / 功法 ${(pools.techniques || []).length} / 灵根 ${(pools.spirit_roots || []).length} / 境界 ${(pools.realms || []).length}`);
}

const c = index.counts || {};
if (c.documents !== docs.length) err(`counts.documents=${c.documents} 与实际 ${docs.length} 不符`);
if (c.entities !== entityCount) err(`counts.entities=${c.entities} 与实际 ${entityCount} 不符`);
if (c.relations !== relations.length) err(`counts.relations=${c.relations} 与实际 ${relations.length} 不符`);
for (const t of TYPES) {
    if ((c[t] || 0) !== (byType[t] || 0)) err(`counts.${t}=${c[t]} 与实际 ${byType[t] || 0} 不符`);
}

const quality = {};
for (const t of TYPES) quality[t] = 0;
console.log(`资料包：${index.name} v${index.version}`);
console.log(`  原文 ${docs.length} 篇 / 实体 ${entityCount}（女修 ${byType.female_cultivator || 0} · 神佛 ${byType.female_deity || 0} · 器灵 ${byType.female_artifact_spirit || 0} · 异兽 ${byType.female_beast || 0}）/ 关联 ${relations.length}`);

if (warns.length) {
    console.log(`\n⚠ 警告 ${warns.length} 条（不阻断）：`);
    for (const w of warns.slice(0, 20)) console.log('  - ' + w);
    if (warns.length > 20) console.log(`  …另有 ${warns.length - 20} 条`);
}

if (errors.length) {
    console.log(`\n✗ 错误 ${errors.length} 条：`);
    for (const e of errors.slice(0, 40)) console.log('  - ' + e);
    if (errors.length > 40) console.log(`  …另有 ${errors.length - 40} 条`);
    process.exit(1);
}
console.log('\n✓ 校验通过');
