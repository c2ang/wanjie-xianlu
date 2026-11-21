// 校验 dist/ 下的分发文件：zip 结构、资料包能否被插件导入、世界书/角色卡格式
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYENV = { ...process.env, PYTHONIOENCODING: 'utf-8' };
const DIST = path.join(ROOT, 'dist');
const V = '1.2.0';
let fails = 0;
const ok = (cond, msg, detail = '') => {
    if (!cond) { fails++; console.log(`  ✗ ${msg} ${detail}`); }
    else console.log(`  ✓ ${msg}${detail ? '  ' + detail : ''}`);
};

function loadPlugin() {
    const src = fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'), 'utf8');
    const win = { addEventListener() { } };
    const factory = new Function('window', 'document', 'jQuery', 'indexedDB', 'SillyTavern',
        `${src}\nreturn { WJL_Import, WJL_Schema };`);
    return factory(win, undefined, undefined, undefined, undefined);
}

const P = loadPlugin();

// —— 1. 插件整包
console.log('\n[1] 插件整包');
const zip = path.join(DIST, `wanjie-xianlu-v${V}.zip`);
ok(fs.existsSync(zip), 'zip 存在', `${(fs.statSync(zip).size / 1024).toFixed(0)} KB`);
const listing = execFileSync('python', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(r"${zip}")
for n in z.namelist(): print(n)
`], { encoding: 'utf8', env: PYENV }).trim().split(/\r?\n/);
const need = ['安装说明.txt', 'wanjie-xianlu/manifest.json', 'wanjie-xianlu/index.js',
    'wanjie-xianlu/style.css', 'wanjie-xianlu/ui/panel.html', 'wanjie-xianlu/knowledge/index.json',
    'wanjie-xianlu/knowledge/documents/source_documents.jsonl',
    'wanjie-xianlu/knowledge/relations/relations.jsonl'];
for (const n of need) ok(listing.includes(n), '包含 ' + n);
ok(listing.filter(n => n.includes('knowledge/entities/')).length === 4, '含 4 类实体文件');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'manifest.json'), 'utf8'));
ok(man.display_name && man.js === 'index.js', 'manifest 合法', man.display_name);

// zip 里的 index.js 与源文件一致
const srcHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'plugin', 'index.js'))).digest('hex');
const zHash = execFileSync('python', ['-c', `
import zipfile,hashlib
z=zipfile.ZipFile(r"${zip}")
print(hashlib.sha256(z.read("wanjie-xianlu/index.js")).hexdigest())
`], { encoding: 'utf8', env: PYENV }).trim();
ok(srcHash === zHash, 'zip 内 index.js 与源文件一致', srcHash.slice(0, 12));

// —— 2. 资料包
console.log('\n[2] 资料包（混排 JSONL）');
const pack = path.join(DIST, `资料包-万界仙录-v${V}.jsonl`);
const text = fs.readFileSync(pack, 'utf8');
const parsed = P.WJL_Import.parseJsonl(text);
ok(parsed.errors.length === 0, '无解析错误', parsed.errors.slice(0, 2).join(' | '));
const cls = P.WJL_Import.classify(parsed.rows);
ok(cls.documents.length === 1396, '文档 1396', String(cls.documents.length));
ok(cls.entities.length === 252, '实体 252', String(cls.entities.length));
ok(cls.relations.length === 318, '关联 318', String(cls.relations.length));
ok(cls.invalid.length === 0, '无非法记录', String(cls.invalid.length));
const byType = {};
for (const e of cls.entities) byType[e.type] = (byType[e.type] || 0) + 1;
ok(byType.female_cultivator === 21 && byType.female_deity === 6 &&
    byType.female_artifact_spirit === 86 && byType.female_beast === 139,
    '四类数量正确', JSON.stringify(byType));

// —— 3. 世界书
console.log('\n[3] 世界书');
const SAMPLE_KEYS = ['uid', 'displayIndex', 'comment', 'disable', 'constant', 'selective', 'key',
    'selectiveLogic', 'keysecondary', 'scanDepth', 'vectorized', 'position', 'role', 'depth',
    'order', 'content', 'useProbability', 'probability', 'excludeRecursion', 'preventRecursion',
    'delayUntilRecursion', 'sticky', 'cooldown', 'delay', 'addMemo', 'group', 'groupOverride',
    'groupWeight', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'ignoreBudget'];
for (const [file, want] of [['世界书-万界仙录-素材.json', 252], ['世界书-万界仙录-设定原文.json', 1396]]) {
    const p = path.join(DIST, file);
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const keys = Object.keys(obj.entries);
    const es = keys.map(k => obj.entries[k]);
    const missing = SAMPLE_KEYS.filter(k => !(k in es[0]));
    const badKey = es.filter(e => !Array.isArray(e.key) || e.key.length === 0).length;
    const badContent = es.filter(e => !e.content || e.content.length < 10).length;
    const dupUid = new Set(es.map(e => e.uid)).size !== es.length;
    ok(keys.length === want, `${file} 条目数 ${want}`, String(keys.length));
    ok(missing.length === 0, '字段齐全', missing.join(','));
    ok(badKey === 0 && badContent === 0 && !dupUid, '键/正文/uid 正常', `badKey=${badKey} badContent=${badContent}`);
    ok(typeof obj.name === 'string', '带 name', obj.name);
}

// —— 4. 角色卡
console.log('\n[4] 角色卡');
const card = JSON.parse(fs.readFileSync(path.join(DIST, '角色卡-万界仙录-设定助手.json'), 'utf8'));
ok(card.spec === 'chara_card_v2' && card.spec_version === '2.0', 'spec v2');
const d = card.data;
ok(d.name && d.description && d.first_mes && d.mes_example, '必备字段齐全');
ok(Array.isArray(d.alternate_greetings) && d.alternate_greetings.length > 0, '有备用开场');
const cb = d.character_book;
ok(cb && cb.name && Array.isArray(cb.entries), 'character_book 存在', cb && cb.name);
ok(cb.entries.length === 406, '内嵌条目 406', String(cb.entries.length));
const badCb = cb.entries.filter(e => !e.keys?.length || !e.content || typeof e.id !== 'number').length;
ok(badCb === 0, '条目 keys/content/id 正常', `bad=${badCb}`);
ok(cb.entries.some(e => e.content.includes('器灵')) && cb.entries.some(e => e.content.includes('女娲')),
    '含器灵与神佛条目');

// —— 5. 清单
console.log('\n[5] 清单');
const ml = fs.readFileSync(path.join(DIST, '发布清单.md'), 'utf8');
for (const f of fs.readdirSync(DIST)) {
    if (f === '发布清单.md') continue;
    ok(ml.includes(f), '清单含 ' + f);
}

console.log(fails === 0 ? '\n✓ 分发文件校验通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
