#!/usr/bin/env node
/**
 * 万界仙录 — 安装到 SillyTavern
 *
 * 用法：
 *   node tools/install.mjs                      # 默认安装到 E:\AI\sillytavern
 *   node tools/install.mjs "D:/sillytavern"     # 指定 SillyTavern 根目录
 *   node tools/install.mjs --no-knowledge       # 不复制资料包（省 10MB）
 *
 * 做的事：把 plugin/* 和 knowledge/{index.json,documents,entities,relations,indexes}
 * 复制到 <ST>/public/scripts/extensions/third-party/wanjie-xianlu/。
 * 插件通过自身脚本路径推导 baseUrl，因此 knowledge/ 必须与 index.js 同级。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');

const args = process.argv.slice(2);
const noKnowledge = args.includes('--no-knowledge');
const stRoot = args.find(a => !a.startsWith('--')) || 'E:/AI/sillytavern';

const EXT_NAME = 'wanjie-xianlu';
const target = join(stRoot, 'public', 'scripts', 'extensions', 'third-party', EXT_NAME);

function fail(msg) {
    console.error('✗ ' + msg);
    process.exit(1);
}

if (!existsSync(join(stRoot, 'package.json'))) fail(`找不到 SillyTavern：${stRoot}（该目录缺少 package.json）`);
const extDir = join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
if (!existsSync(extDir)) fail(`找不到扩展目录：${extDir}`);

const pkg = JSON.parse(readFileSync(join(stRoot, 'package.json'), 'utf8'));
console.log(`目标 SillyTavern：${stRoot}（${pkg.name || '?'} ${pkg.version || '?'}）`);

// 清理旧版，避免残留文件和缓存
if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log('已移除旧版本：' + target);
}
mkdirSync(target, { recursive: true });

function copyDir(src, dst) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
        const from = join(src, name);
        const to = join(dst, name);
        if (statSync(from).isDirectory()) copyDir(from, to);
        else copyFileSync(from, to);
    }
}

copyDir(join(project, 'plugin'), target);
console.log('✓ 已复制插件代码');

if (!noKnowledge) {
    const kdir = join(target, 'knowledge');
    mkdirSync(join(kdir, 'documents'), { recursive: true });
    mkdirSync(join(kdir, 'entities'), { recursive: true });
    mkdirSync(join(kdir, 'relations'), { recursive: true });
    mkdirSync(join(kdir, 'indexes'), { recursive: true });
    copyFileSync(join(project, 'knowledge', 'index.json'), join(kdir, 'index.json'));
    for (const sub of ['documents', 'entities', 'relations', 'indexes']) {
        copyDir(join(project, 'knowledge', sub), join(kdir, sub));
    }
    console.log('✓ 已复制资料包（raw 原文与 reports 不随插件安装，留在项目里）');
}

function walk(dir) {
    let n = 0;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        n += statSync(p).isDirectory() ? walk(p) : 1;
    }
    return n;
}

const files = walk(target);
const required = ['manifest.json', 'index.js', 'style.css', 'ui/panel.html'];
for (const r of required) {
    if (!existsSync(join(target, r))) fail(`安装后缺少必要文件：${r}`);
}
console.log(`✓ 安装完成：${files} 个文件 → ${target}`);
console.log('\n下一步：');
console.log('  1. 刷新 SillyTavern 页面（Ctrl+F5）');
console.log('  2. 打开「扩展」面板，确认已列出「万界仙录」');
console.log('  3. 进入万界仙录 → 设置 → 点「导入内置资料包」');
console.log('  4. 首页应显示 1396 篇原文 / 252 条素材 / 318 条关联');
