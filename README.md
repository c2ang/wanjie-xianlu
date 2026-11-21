# 万界仙录 · Wanjie Xianlu

> 一个 SillyTavern 本地资料库插件：从 1396 篇修仙设定里，为你的角色卡**随机取出一份背景骨架**——门派、身份、境界、灵根、主修功法——名字和性格留给模型去写。

**它不生成人物。** 它给的是一份有出处、可复现、不越界的「门面资料」。

---

## 它到底给什么

```
一次调用 → 女性修仙者「红颜知己」               一次调用 → 女性器灵「紫郢剑」
├ 所属门派  天剑宗（宗门）    ← 原文            ├ 依附法宝  紫郢剑      ← 原文
├ 身份      红颜知己          ← 资料库随机配对   ├ 显化形态  形如紫衣少女 ← 原文
├ 境界      金丹              ← 资料库随机配对   └ 留给模型：姓名 / 形貌 / 性格
├ 灵根      水灵根            ← 资料库随机配对
├ 主修功法  雷霆剑诀          ← 资料库随机配对
└ 留给模型：姓名 / 年龄段 / 性格 / 经历 / 说话方式 / 门派职务 / 招式细节
```

- 每个字段都带 `provenance`：`entity` = 出自原文、`library` = 从素材池随机配对、数组 = 原文 `source_id`。
- 每类都有 `to_be_authored`：**必须由模型补**的部分，防止把原创当设定。
- 器灵类常常只有法宝名与形制，会明确标注「女性形态由模型补全」——不伪造女性依据。

真实抽样见 [`docs/效果样例.md`](docs/效果样例.md)（8 条，seed 固定可复现）。

---

## 安装

前置：SillyTavern 1.18.0+。

**方式 0：酒馆里填链接（不用下载）**

在 SillyTavern → 扩展 → **Install extension**，填入：

```
https://github.com/c2ang/wanjie-xianlu
```

酒馆会下载仓库（压缩约 3.4 MB，解压 11 MB），仓库根目录就是插件本体。
装完刷新页面，进入面板 → 设置 → 「导入内置资料包」。

> 也可以直接下载 zip：`https://github.com/c2ang/wanjie-xianlu/archive/refs/heads/main.zip`，解压到
> `<ST>/public/scripts/extensions/third-party/wanjie-xianlu/`。

**方式 A：一键安装（本机开发用）**

```bash
git clone <this-repo> && cd wanjie-xianlu
node tools/install.mjs                 # 默认装到 E:\AI\sillytavern
node tools/install.mjs "D:/sillytavern"  # 或指到你的目录
```

**方式 B：手动**。把 `plugin/` 与 `knowledge/` 复制到
`<ST>/public/scripts/extensions/third-party/wanjie-xianlu/`。

**方式 C：解压即用**。下载 Release 里的 `wanjie-xianlu-v1.2.0.zip`，解压到同一目录。

装完：刷新页面（Ctrl+F5）→ 扩展面板出现「万界仙录」→ 打开面板 → 设置页点**「导入内置资料包」** →
首页应显示 **1396 篇原文 / 252 条素材 / 318 条关联**。

> 装好后先点设置页的**「自检」**：它会把上下文、资料库、原文检索、抽取复现、5 个工具注册、命令注册逐项跑一遍。

---

## 三种用法

### 1. 让模型自己调（Function Tool）

插件注册了 5 个工具，支持工具调用的模型会自己用：

| 工具 | 用途 |
| --- | --- |
| `xianlu_generate` | 随机抽取 1–10 条素材（核心） |
| `xianlu_search` | 条件检索：素材 / 资料库原文 / 两者 |
| `xianlu_lookup` | 按 id 或名字查一条 |
| `xianlu_related` | 器灵↔法宝、异兽↔血脉、女修↔宗门 |
| `xianlu_save_result` | 存进插件收藏区（不写人物卡） |

### 2. 斜杠命令（模型不支持工具调用时）

```text
/xianlu generate category=female_cultivator count=2 seed=42
/xianlu search scope=document keyword=器灵 limit=3
/xianlu lookup name=紫
/xianlu stats
/xianlu selftest
```

### 3. 面板

首页 / 浏览 / 检索 / 抽取 / 历史 / 详情 / 设置 七个页签，相同能力的手动入口。

---

## 给制卡器的调用方法

> 完整规范：[`docs/制卡器调用规范.md`](docs/制卡器调用规范.md) · 可直粘的提示词：[`docs/制卡器提示词.md`](docs/制卡器提示词.md) · 机器可读契约：[`schemas/`](schemas) · 写好的示例卡：[`docs/示例人物卡.json`](docs/示例人物卡.json)

### 一句话流程

```
① xianlu_generate（要几条、什么类别、什么条件、seed）
        ↓ 拿到 results[].background.fields
② 把 fields 写进卡片 description / scenario
        ↓
③ personality / first_mes / mes_example 由模型按 fields 写
```

### 请求

```json
{
  "category": "female_cultivator",
  "count": 2,
  "seed": 42,
  "filters": { "realm_min": "金丹", "sect": "剑", "tags": ["剑修"] },
  "detail_level": "standard",
  "exclude_recent": true
}
```

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `category` | `female_cultivator` / `female_deity` / `female_artifact_spirit` / `female_beast` | 四类素材 |
| `count` | 1–10 | 一次取几条 |
| `seed` | 数字或字符串 | **同 seed + 同资料包 = 同结果**，做卡可复现 |
| `filters` | 见下 | 硬条件先过滤，软条件只加权 |
| `detail_level` | `compact` / `standard` / `complete` | 约 900 / 3200 / 7600 字预算 |
| `exclude_recent` | bool | 近期抽过的不再给（默认 true） |
| `random_mode` | `weighted` / `uniform` | 权重抽样或均匀抽样 |

硬条件：`realm`、`realm_min`/`realm_max`（19 级：凡人→道祖）、`race`、`bloodline`、`grade`、`artifact_type`、`species`、`habitat`、`sect`、`can_transform`、`tags`、`keyword`。

### 返回

```json
{
  "success": true,
  "count": 1,
  "detail_level": "standard",
  "results": [
    {
      "id": "cult_00013",
      "name": "神秘型",
      "category": "female_cultivator",
      "category_label": "女性修仙者",
      "summary": "性格：深不可测，行事莫测；教导方式：点到为止……",
      "quality": "verified",
      "quality_label": "原文可证",
      "adaptation_flag": false,
      "gender_basis": "常见身份：隐世大能",
      "source_ids": ["doc_03ed95346a1509ff"],
      "background": {
        "fields": {
          "所属门派": "天剑宗（宗门）",
          "身份": "红颜知己",
          "境界": "金丹",
          "灵根": "水灵根",
          "主修功法": "雷霆剑诀",
          "气质外形": "隐世大能"
        },
        "provenance": { "所属门派": ["doc_03ed95346a1509ff"], "身份": "library" },
        "to_be_authored": ["姓名", "年龄段与生日", "性格", "个人经历", "说话方式", "门派内的具体职务", "功法的招式细节"],
        "pools_ready": true,
        "created_by": "资料库随机配对（seed 可复现）"
      }
    }
  ],
  "warnings": [],
  "meta": { "seed": "42", "candidates": 20, "relaxed": [] }
}
```

候选不足时会逐级放宽并写进 `warnings` / `meta.relaxed`，调用方应把这些提示传给作者，而不是静默接受。

### 落成一张人物卡

```jsonc
{
  "name": "（模型起名）",
  "description": "天剑宗红颜知己，金丹修为，水灵根，主修雷霆剑诀。气质：隐世大能，深不可测。",
  "scenario": "天剑宗后山剑冢，她等你递上那柄断了半截的雷纹剑。",
  "personality": "（由模型依 fields 写）",
  "first_mes": "（由模型写，必须符合金丹剑修的口吻）",
  "extensions": { "xianlu": { "pack": "wanjie-xianlu", "seed": "42", "entity_id": "cult_00013" } }
}
```

三条硬规矩：

1. `quality` 为 `adapted` 的条目，是「原文没有、据法宝名改编」的素材，**不能说成原文设定**。
2. `gender_basis` 为空的条目（多为法宝名器灵），女性身份是模型补全，不是资料库事实。
3. `to_be_authored` 里的一切都必须模型创作，不能倒填进 `fields`。

### 批量 / 多类别

`xianlu_generate` 一次只取一个类别。做一张卡要「1 女修 + 1 器灵」就调两次（或用离线 CLI 的 `--combo`）：

```bash
python tools/pick_random.py --combo "female_cultivator:1,female_artifact_spirit:1" --seed 7 --format md
```

离线 CLI 与插件算法逐项一致（`tools/verify_cli_parity.mjs` 守护），适合在制卡器侧、无酒馆环境时取数。

---

## 资料库

| 类别 | 条数 | 说明 |
| --- | --- | --- |
| 女性修仙者 | 21 | 多来自「女性角色模板 / 师尊模板 / 红颜知己模板」 |
| 女性神佛 | 6 | 观音、女娲、九天玄女等 |
| 女性器灵 | 86 | 其中 68 件是「法宝名」素材（改编标注） |
| 女性异兽 | 139 | 多为图鉴条目，部分可化形 |
| 设定原文 | 1396 | 世界观 / 修炼体系 / 功法 / 资源 / 势力 / 地理 / 妖兽 / 人物 / 写作 |

素材池：门派 68、功法 156、灵根 24、身份 21、境界 19。同一资料包 + 同一 seed，抽取结果完全一致。

质量五档：`verified` 原文可证 / `inferred` 合理推导 / `adapted` 原创改编 / `pending` 待核查 / `conflict` 冲突。默认只用前两类（`adapted` 可在设置里关掉）。

---

## 目录结构

```
plugin/      SillyTavern 扩展本体（单入口经典脚本，IndexedDB 存储）
knowledge/   资料包：原文 JSONL、四类实体、关联、素材池、报告
tools/       资料构建、校验、打包、安装、离线 CLI
schemas/     5 个 Function Tool 的 OpenAI 格式定义与返回 Schema
docs/        制卡器调用规范、提示词、效果样例、示例人物卡、交付报告
tests/       单元测试（20 项）
```

开发与校验：

```bash
node --test tests/core.test.mjs      # 单元测试
node tools/validate_pack.mjs         # 资料包结构校验
node tools/e2e_import.mjs            # 内存 IndexedDB 全链路
node tools/verify_cli_parity.mjs     # CLI 与插件抽取一致性
python tools/export_share.py         # 生成 dist/ 分发包
```

---

## 数据来源与版权

设定原文来自公开整理的修仙设定资料集（`xiuxian-main`，1396 篇），本项目只做结构化、分类与检索，不声称拥有原文著作权；原文版权归原作者/整理者。
四类实体、素材池与关联是程序抽取结果，`adapted` 条目为改编素材，已逐条标注来源与质量等级。

代码以 MIT 许可发布。
