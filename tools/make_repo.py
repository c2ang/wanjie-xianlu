#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本地工程整理成「可直接用酒馆 URL 安装」的仓库目录 publish/。

酒馆安装扩展时会下载仓库 zip，并找根目录下的 manifest.json，
所以 publish/ 根目录必须是插件本体（index.js / manifest.json / style.css / ui / knowledge）。

用法（在 wanjie-xianlu 目录下）：
    PYTHONIOENCODING=utf-8 python tools/make_repo.py
"""
import io
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'publish')

# 插件本体：源目录 -> 仓库内路径
PLUGIN_FILES = [
    ('plugin/manifest.json', 'manifest.json'),
    ('plugin/index.js', 'index.js'),
    ('plugin/style.css', 'style.css'),
    ('plugin/ui/panel.html', 'ui/panel.html'),
]

# 资料包（不含 raw/：那是 12 个原始 txt，内容已全部进 documents/*.jsonl）
KNOWLEDGE = [
    ('knowledge/index.json', 'knowledge/index.json'),
    ('knowledge/documents/source_documents.jsonl', 'knowledge/documents/source_documents.jsonl'),
    ('knowledge/entities/female_cultivators.jsonl', 'knowledge/entities/female_cultivators.jsonl'),
    ('knowledge/entities/female_deities.jsonl', 'knowledge/entities/female_deities.jsonl'),
    ('knowledge/entities/artifact_spirits.jsonl', 'knowledge/entities/artifact_spirits.jsonl'),
    ('knowledge/entities/female_beasts.jsonl', 'knowledge/entities/female_beasts.jsonl'),
    ('knowledge/relations/relations.jsonl', 'knowledge/relations/relations.jsonl'),
    ('knowledge/indexes/surface_pools.json', 'knowledge/indexes/surface_pools.json'),
    ('knowledge/indexes/category_index.json', 'knowledge/indexes/category_index.json'),
    ('knowledge/indexes/tag_index.json', 'knowledge/indexes/tag_index.json'),
]

# 开发用：仓库里保留，但不在插件运行路径上
EXTRA = [
    ('README.md', 'README.md'),
    ('LICENSE', 'LICENSE'),
    ('schemas/xianlu-tools.openai.json', 'schemas/xianlu-tools.openai.json'),
    ('schemas/xianlu-tools.meta.json', 'schemas/xianlu-tools.meta.json'),
    ('schemas/xianlu-result.schema.json', 'schemas/xianlu-result.schema.json'),
    ('schemas/xianlu-enums.json', 'schemas/xianlu-enums.json'),
    ('docs/制卡器调用规范.md', 'docs/制卡器调用规范.md'),
    ('docs/制卡器提示词.md', 'docs/制卡器提示词.md'),
    ('docs/效果样例.md', 'docs/效果样例.md'),
    ('docs/交付报告.md', 'docs/交付报告.md'),
    ('tests/core.test.mjs', 'tests/core.test.mjs'),
]

TOOLS = [
    'build_knowledge.py', 'build_pools.py', 'pick_random.py', 'make_samples.py',
    'export_share.py', 'install.mjs', 'validate_pack.mjs', 'smoke_import.mjs',
    'e2e_import.mjs', 'check_ui.mjs', 'verify_cli_parity.mjs', 'verify_share.mjs',
    'export_schemas.mjs', 'make_repo.py', 'verify_publish.mjs',
]

GITIGNORE = """dist/
publish/
tools/__pycache__/
*.pyc
node_modules/
.DS_Store
"""


def _rmtree_force(path):
    """删目录，遇到只读文件（git 对象）先改权限。"""
    for base, dirs, files in os.walk(path, topdown=False):
        for f in files:
            fp = os.path.join(base, f)
            try:
                os.chmod(fp, 0o666)
                os.remove(fp)
            except OSError:
                pass
        for d in dirs:
            dp = os.path.join(base, d)
            try:
                os.chmod(dp, 0o777)
            except OSError:
                pass
    shutil.rmtree(path, ignore_errors=True)


def copy(src_rel, dst_rel):
    src = os.path.join(ROOT, src_rel)
    dst = os.path.join(OUT, dst_rel)
    if not os.path.exists(src):
        raise SystemExit('缺文件：' + src_rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return os.path.getsize(dst)


def main():
    # 保留 .git（push 过的仓库不能整目录删），只清工作区
    if os.path.isdir(OUT):
        for name in os.listdir(OUT):
            if name == '.git':
                continue
            path = os.path.join(OUT, name)
            if os.path.isdir(path):
                _rmtree_force(path)
            else:
                os.remove(path)
    else:
        os.makedirs(OUT)

    total = 0
    n = 0
    for pair in PLUGIN_FILES + KNOWLEDGE + EXTRA:
        total += copy(*pair)
        n += 1
    for name in TOOLS:
        total += copy('tools/' + name, 'tools/' + name)
        n += 1
    # 仓库内 tools/ 的相对路径与源目录一致（脚本都用 dirname/.. 定位），可直接跑

    io.open(os.path.join(OUT, '.gitignore'), 'w', encoding='utf-8', newline='\n').write(GITIGNORE)
    total += len(GITIGNORE)
    n += 1

    mani = io.open(os.path.join(OUT, 'manifest.json'), encoding='utf-8').read()
    ver = (re.search(r'"version"\s*:\s*"([^"]+)"', mani) or [None, '?'])[1]
    print('✓ publish/ 就绪：%d 个文件，%.1f MB，版本 %s' % (n, total / 1048576.0, ver))
    print('  根目录即插件本体（manifest.json 在根），酒馆可直接用仓库 URL 安装')


if __name__ == '__main__':
    main()
