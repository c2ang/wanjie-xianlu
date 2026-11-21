#!/usr/bin/env node
/**
 * 万界仙录 — 导出工具契约（给制卡器/第三方调用方）
 *
 * 用法：node tools/export_schemas.mjs [输出目录，默认 schemas/]
 *
 * 产出：
 *   xianlu-tools.openai.json   5 个 Function Tool 的 OpenAI 格式定义（可直接喂给模型）
 *   xianlu-tools.meta.json     同名工具的展示名与短说明（UI 用）
 *   xianlu-result.schema.json  返回值 payload 的 JSON Schema
 *   xianlu-enums.json          枚举与常量（类别、质量、详细程度、境界、字段标签）
 *
 * 这些文件直接从 plugin/index.js 的 WJL_Tools.defs() 导出，避免文档与代码脱节。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = process.argv[2] || join(root, 'schemas');
mkdirSync(outDir, { recursive: true });

const src = readFileSync(join(root, 'plugin/index.js'), 'utf8');
const api = new Function(
    'window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
    src + '\nreturn { WJL_Tools, WJL_CATEGORIES, WJL_QUALITY_LABEL, WJL_DETAIL_LEVELS, WJL_REALMS, WJL_DEFAULT_SETTINGS };'
)(undefined, undefined, undefined, undefined, undefined);

const defs = api.WJL_Tools.defs();

const tools = defs.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
}));

const meta = defs.map(d => ({ name: d.name, displayName: d.displayName, description: d.description }));

const resultSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'xianlu_payload',
    type: 'object',
    required: ['success', 'count', 'results', 'warnings'],
    properties: {
        success: { type: 'boolean', description: '是否有结果。false 时看 warnings' },
        count: { type: 'integer', description: 'results 的条数' },
        detail_level: { type: 'string', enum: ['compact', 'standard', 'complete'] },
        results: { type: 'array', items: { $ref: '#/definitions/entity_result' } },
        warnings: { type: 'array', items: { type: 'string' }, description: '需要转述给用户的提示（候选不足、已放宽条件等）' },
        meta: { type: 'object', description: '抽取/检索的附加信息，结构随工具不同' },
    },
    definitions: {
        entity_result: {
            type: 'object',
            required: ['id', 'name', 'category', 'summary', 'quality'],
            properties: {
                id: { type: 'string', description: '素材 ID，后续 lookup / related / save 用它' },
                name: { type: 'string' },
                category: { type: 'string', enum: Object.keys(api.WJL_CATEGORIES) },
                category_label: { type: 'string' },
                summary: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                quality: { type: 'string', enum: Object.keys(api.WJL_QUALITY_LABEL) },
                quality_label: { type: 'string' },
                adaptation_flag: { type: 'boolean', description: 'true=含改编成分，不得当作原文事实引用' },
                gender_basis: { type: 'string', description: '女性身份的资料依据；为空表示需由模型补全' },
                source_ids: { type: 'array', items: { type: 'string' } },
                facts: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: '中文标签 → 值，键名见 xianlu-enums.json 的 field_labels',
                },
                background: {
                    type: 'object',
                    description: '背景骨架：直接可用的门面资料（门派/境界/灵根/功法 等），不是一个人物',
                    properties: {
                        fields: { type: 'object', additionalProperties: { type: 'string' }, description: '中文标签 → 值' },
                        provenance: { type: 'object', description: '每个字段的出处（entity / library / 原文 doc id）' },
                        created_by: { type: 'string' },
                        to_be_authored: { type: 'array', items: { type: 'string' }, description: '必须由模型补全的部分（姓名/性格/经历…）' },
                        pools_ready: { type: 'boolean', description: '资料包的池子是否已导入；false 时只有境界' },
                        note: { type: 'string', description: '给模型看的诚实标注' },
                    },
                    required: ['fields'],
                },
                material_note: { type: 'string', description: '器灵素材说明：只给法宝名与形制，女性形态由模型补全' },
                content: { type: 'string', description: '仅 detail_level=complete 时返回的原文摘录' },
                relation_type: { type: 'string', description: '仅 related 返回时存在' },
                relation_description: { type: 'string' },
            },
        },
        doc_hit: {
            type: 'object',
            description: 'scope=document 时的原文片段',
            properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                category: { type: 'string' },
                source_path: { type: 'string' },
                snippet: { type: 'string' },
                score: { type: 'number' },
            },
        },
    },
};

const enums = {
    generated_at: new Date().toISOString(),
    categories: Object.fromEntries(Object.entries(api.WJL_CATEGORIES).map(([k, v]) => [k, {
        label: v.label,
        short: v.short,
        prefix: v.prefix,
        fields: v.fields,
        filters: v.filters,
    }])),
    quality: api.WJL_QUALITY_LABEL,
    detail_levels: api.WJL_DETAIL_LEVELS,
    realms: api.WJL_REALMS,
    defaults: api.WJL_DEFAULT_SETTINGS,
    counts: { count_min: 1, count_max: 10, limit_min: 1, limit_max: 20 },
};

const write = (name, obj) => {
    const p = join(outDir, name);
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    console.log('✓ ' + name);
};

write('xianlu-tools.openai.json', tools);
write('xianlu-tools.meta.json', meta);
write('xianlu-result.schema.json', resultSchema);
write('xianlu-enums.json', enums);

console.log(`\n已导出 ${tools.length} 个工具定义到 ${outDir}`);
console.log('工具：' + tools.map(t => t.function.name).join(', '));
