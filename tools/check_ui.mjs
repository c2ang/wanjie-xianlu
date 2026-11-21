#!/usr/bin/env node
/**
 * 万界仙录 — UI 静态交叉检查
 *
 * 不启动浏览器，检查最容易出错的两类问题：
 *  1. index.js 里 getElementById('x') / $('#x') 引用的元素，panel.html 里是否存在；
 *  2. panel.html 里 data-wjl-act="x" 声明的动作，index.js 的 handleAction 是否处理。
 *
 * 动态创建的元素写在 DYNAMIC_IDS 白名单里。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const js = readFileSync(join(root, 'plugin', 'index.js'), 'utf8');
const html = readFileSync(join(root, 'plugin', 'ui', 'panel.html'), 'utf8');

const DYNAMIC_IDS = new Set(['wjl-quick-result', 'extensions_settings']);

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const usedIds = new Set([
    ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
    ...[...js.matchAll(/\$\('#([^']+)'\)/g)].map(m => m[1]),
]);

// 面板里的静态入口 + index.js 字符串模板里动态渲染的入口
const actsInHtml = new Set([
    ...[...html.matchAll(/data-wjl-act="([^"]+)"/g)].map(m => m[1]),
    ...[...js.matchAll(/data-wjl-act="([^"]+)"/g)].map(m => m[1]),
]);
const actsHandled = new Set([...js.matchAll(/act === '([^']+)'/g)].map(m => m[1]));

const problems = [];
for (const id of usedIds) {
    if (!htmlIds.has(id) && !DYNAMIC_IDS.has(id)) problems.push(`index.js 引用了不存在的元素 id：${id}`);
}
for (const act of actsInHtml) {
    if (!actsHandled.has(act)) problems.push(`panel.html 声明了动作但 index.js 未处理：data-wjl-act="${act}"`);
}
for (const act of actsHandled) {
    if (!actsInHtml.has(act)) problems.push(`index.js 处理了动作但面板里没有入口：${act}（可选）`);
}

// 设置项：面板 data-wjl-setting 必须存在于默认设置里
const settingsBlock = js.slice(js.indexOf('WJL_DEFAULT_SETTINGS'), js.indexOf('WJL_DEFAULT_SETTINGS') + 1200);
const settingKeys = new Set([...settingsBlock.matchAll(/(\w+):/g)].map(m => m[1]));
for (const m of html.matchAll(/data-wjl-setting="([^"]+)"/g)) {
    if (!settingKeys.has(m[1])) problems.push(`面板设置项没有对应默认值：${m[1]}`);
}

// 面板模板必须按「third-party/扩展名」全路径取，否则酒馆里会 404（v1.2.1 修过的真实 bug）
if (!/'third-party\/' \+ WJL_EXT_NAME/.test(js)) {
    problems.push('加载面板模板时必须用 third-party/ 前缀（renderExtensionTemplateAsync(WJL_EXT_NAME) 会 404）');
}
if (!/ui\/panel\.html/.test(js)) {
    problems.push('index.js 里没有 ui/panel.html 的 fetch 兜底路径');
}

console.log(`面板 id ${htmlIds.size} 个 / 代码引用 ${usedIds.size} 个 / 动作 ${actsInHtml.size} 个`);
if (problems.length) {
    console.log(`\n✗ ${problems.length} 个问题：`);
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
}
console.log('\n✓ UI 引用一致');
