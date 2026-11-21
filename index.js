/**
 * 万界仙录 (Wanjie Xianlu) — SillyTavern 修仙资料库与角色素材抽取插件
 *
 * 设计原则：
 *  - 资料库是「素材源」，AI 是「作者」。插件只负责检索、筛选、随机抽取与格式化。
 *  - 原始资料只读，任何结构化数据都额外附带 source_ids 便于溯源。
 *  - 不向上下文注入整库资料；只在工具被调用时返回精简结果。
 *  - Function Tool 是主入口，Slash Command 与 UI 是兜底入口。
 *
 * 本文件为经典脚本（非 ES Module），由 SillyTavern 以 <script> 方式加载。
 */

const WJL_EXT_NAME = 'wanjie-xianlu';
const WJL_DB_NAME = 'wanjie_xianlu';
const WJL_DB_VERSION = 1;
const WJL_PACK_VERSION = '1.0.0';

/* =========================================================================
 * 1. 分类与字段定义
 * ========================================================================= */

const WJL_CATEGORIES = {
    female_cultivator: {
        label: '女性修仙者',
        short: '女修',
        file: 'female_cultivators.jsonl',
        prefix: 'cult',
        fields: [
            ['gender_basis', '女性依据'], ['race', '种族'], ['realm', '境界'],
            ['spirit_root', '灵根'], ['constitution', '特殊体质'], ['bloodline', '血脉'],
            ['cultivation_path', '修炼方向'], ['techniques', '功法法术'], ['sect', '宗门'],
            ['faction', '所属势力'], ['origin', '出身来历'], ['personality', '性格'],
            ['motivation', '目标动机'], ['appearance', '外貌'], ['relationships', '人物关系'],
        ],
        filters: ['realm', 'race', 'spirit_root', 'constitution', 'bloodline', 'sect', 'faction'],
    },
    female_deity: {
        label: '女性神佛',
        short: '神佛',
        file: 'female_deities.jsonl',
        prefix: 'deity',
        fields: [
            ['gender_basis', '女性依据'], ['divine_rank', '神位神格'], ['buddhist_rank', '佛门果位'],
            ['title', '尊号'], ['domain', '神职领域'], ['vows', '誓愿'], ['karma', '因果'],
            ['faith', '信仰体系'], ['realm', '所在神域'], ['daoist_site', '道场'],
            ['manifestations', '化身显现'], ['artifacts', '关联法宝'], ['source_evidence', '原文依据'],
        ],
        filters: ['divine_rank', 'buddhist_rank', 'domain', 'faith', 'realm', 'daoist_site'],
    },
    female_artifact_spirit: {
        label: '女性器灵',
        short: '器灵',
        file: 'artifact_spirits.jsonl',
        prefix: 'spirit',
        fields: [
            ['gender_basis', '女性依据'], ['artifact_name', '所属法宝'], ['artifact_type', '法宝类别'],
            ['grade', '法宝品阶'], ['manifestation_form', '显化形态'], ['origin_method', '诞生方式'],
            ['temperament', '性格'], ['abilities', '能力'], ['recognition_conditions', '认主条件'],
            ['growth_stage', '成长阶段'], ['limitations', '能力限制'], ['contract_relation', '契约关系'],
        ],
        filters: ['artifact_type', 'grade', 'origin_method', 'growth_stage', 'manifestation_form'],
    },
    female_beast: {
        label: '女性异兽',
        short: '异兽',
        file: 'female_beasts.jsonl',
        prefix: 'beast',
        fields: [
            ['gender_basis', '女性依据'], ['species', '物种'], ['bloodline', '血脉'],
            ['beast_rank', '异兽等级'], ['habitat', '栖息地'], ['ecological_role', '生态位'],
            ['appearance', '外形'], ['innate_abilities', '天赋能力'], ['temperament', '性格'],
            ['human_form_condition', '化形条件'], ['contract_relation', '契约关系'],
        ],
        filters: ['species', 'bloodline', 'beast_rank', 'habitat', 'ecological_role'],
    },
};

const WJL_QUALITY_ORDER = ['verified', 'inferred', 'adapted', 'pending', 'conflict'];
const WJL_QUALITY_LABEL = {
    verified: '原文可证',
    inferred: '合理推导',
    adapted: '原创改编',
    pending: '待核查',
    conflict: '存在冲突',
};

const WJL_REALMS = [
    '凡人', '炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫',
    '散仙', '地仙', '真仙', '天仙', '玄仙', '金仙', '太乙', '大罗', '道祖',
];

const WJL_DETAIL_LEVELS = { compact: 900, standard: 3200, complete: 7600 };

const WJL_DEFAULT_SETTINGS = {
    enabled: true,
    toolsEnabled: true,
    promptHintEnabled: false,
    detailLevel: 'standard',
    randomMode: 'weighted',
    recentWindow: 20,
    allowAdaptation: true,
    allowPending: false,
    packImported: false,
    packVersion: '',
};

/* =========================================================================
 * 2. 通用工具
 * ========================================================================= */

const WJL_Util = {
    norm(v) {
        return String(v === undefined || v === null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
    },
    toArray(v) {
        if (Array.isArray(v)) return v.filter(x => x !== undefined && x !== null && x !== '').map(String);
        if (v === undefined || v === null || v === '') return [];
        if (typeof v === 'string') {
            return v.split(/[,，、;；|]/).map(x => x.trim()).filter(Boolean);
        }
        return [String(v)];
    },
    hash32(str) {
        let h = 2166136261;
        const s = String(str);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    },
    clamp(n, lo, hi) {
        n = Number(n);
        if (!Number.isFinite(n)) n = lo;
        return Math.max(lo, Math.min(hi, n));
    },
    truncate(s, n) {
        const t = String(s === undefined || s === null ? '' : s).replace(/\s+\n/g, '\n').trim();
        return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
    },
    chunks(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    },
    uuid(prefix) {
        const r = Math.random().toString(36).slice(2, 10);
        return (prefix || 'id') + '_' + Date.now().toString(36) + r;
    },
    setByPath(obj, path, value) {
        const parts = String(path).split('.');
        let cur = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
        return obj;
    },
};

/* =========================================================================
 * 3. 随机数（可复现）
 * ========================================================================= */

const WJL_Rng = {
    fromSeed(seed) {
        let a = seed === undefined || seed === null || seed === ''
            ? (Math.random() * 0xffffffff) >>> 0
            : (typeof seed === 'number' ? seed : WJL_Util.hash32(seed)) >>> 0;
        if (a === 0) a = 0x9e3779b9;
        return function next() {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    /** 按权重不放回抽样；items 已排序，保证同 seed 同结果 */
    sampleWeighted(items, weights, count, rand) {
        const pool = items.map((it, i) => ({ it, w: Math.max(0.0001, Number(weights[i]) || 1) }));
        const picked = [];
        const n = Math.min(count, pool.length);
        for (let k = 0; k < n; k++) {
            const total = pool.reduce((s, p) => s + p.w, 0);
            let r = rand() * total;
            let idx = 0;
            for (let i = 0; i < pool.length; i++) {
                r -= pool[i].w;
                if (r <= 0) { idx = i; break; }
                idx = i;
            }
            picked.push(pool[idx].it);
            pool.splice(idx, 1);
        }
        return picked;
    },

    sampleUniform(items, count, rand) {
        const pool = items.slice();
        const picked = [];
        const n = Math.min(count, pool.length);
        for (let k = 0; k < n; k++) {
            const idx = Math.floor(rand() * pool.length);
            picked.push(pool[idx]);
            pool.splice(idx, 1);
        }
        return picked;
    },
};

/* =========================================================================
 * 4. IndexedDB 层
 * ========================================================================= */

const WJL_STORES = {
    documents: { key: 'source_id', indexes: { category: 'category', title: 'title' } },
    entities: { key: 'id', indexes: { type: 'type', quality: 'quality', status: 'status' } },
    relations: { key: 'relation_id', indexes: { source: 'source_entity_id', target: 'target_entity_id', relType: 'relation_type' } },
    history: { key: 'seq', autoIncrement: true, indexes: { ts: 'ts' } },
    favorites: { key: 'id', indexes: { entity_id: 'entity_id' } },
    meta: { key: 'key', indexes: {} },
};

const WJL_DB = {
    _db: null,
    _opening: null,

    isAvailable() {
        try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; }
    },

    open() {
        if (this._db) return Promise.resolve(this._db);
        if (this._opening) return this._opening;
        if (!this.isAvailable()) return Promise.reject(new Error('当前环境不支持 IndexedDB，无法建立本地资料库'));
        this._opening = new Promise((resolve, reject) => {
            let req;
            try {
                req = indexedDB.open(WJL_DB_NAME, WJL_DB_VERSION);
            } catch (e) {
                reject(e);
                return;
            }
            req.onupgradeneeded = () => {
                const db = req.result;
                for (const [name, def] of Object.entries(WJL_STORES)) {
                    let store;
                    if (db.objectStoreNames.contains(name)) {
                        store = req.transaction.objectStore(name);
                    } else {
                        store = db.createObjectStore(name, {
                            keyPath: def.key,
                            autoIncrement: !!def.autoIncrement,
                        });
                    }
                    for (const [idxName, path] of Object.entries(def.indexes || {})) {
                        if (!store.indexNames.contains(idxName)) {
                            store.createIndex(idxName, path, { unique: false });
                        }
                    }
                }
            };
            req.onsuccess = () => {
                this._db = req.result;
                this._db.onversionchange = () => { try { this._db.close(); } catch { } this._db = null; };
                resolve(this._db);
            };
            req.onerror = () => reject(req.error || new Error('打开资料库失败'));
            req.onblocked = () => reject(new Error('资料库被其它标签页占用，请关闭其他 SillyTavern 窗口后重试'));
        }).finally(() => { this._opening = null; });
        return this._opening;
    },

    async _store(name, mode) {
        const db = await this.open();
        return db.transaction(name, mode || 'readonly').objectStore(name);
    },

    _req(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    },

    async getAll(name) {
        const store = await this._store(name);
        return this._req(store.getAll());
    },

    async get(name, key) {
        const store = await this._store(name);
        return this._req(store.get(key));
    },

    async put(name, value) {
        const store = await this._store(name, 'readwrite');
        await this._req(store.put(value));
        return value;
    },

    async putMany(name, values, onProgress) {
        const list = Array.isArray(values) ? values : [];
        let done = 0;
        for (const chunk of WJL_Util.chunks(list, 400)) {
            await new Promise((resolve, reject) => {
                this.open().then(db => {
                    const tx = db.transaction(name, 'readwrite');
                    const store = tx.objectStore(name);
                    for (const v of chunk) store.put(v);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    tx.onabort = () => reject(tx.error || new Error('写入事务被中止'));
                }).catch(reject);
            });
            done += chunk.length;
            if (typeof onProgress === 'function') onProgress(done, list.length);
        }
        return done;
    },

    async count(name) {
        const store = await this._store(name);
        return this._req(store.count());
    },

    async clear(name) {
        const store = await this._store(name, 'readwrite');
        await this._req(store.clear());
    },

    async clearAll() {
        for (const name of Object.keys(WJL_STORES)) await this.clear(name);
    },

    async delete(name, key) {
        const store = await this._store(name, 'readwrite');
        await this._req(store.delete(key));
    },

    async getAllByIndex(name, index, value) {
        const store = await this._store(name);
        return this._req(store.index(index).getAll(value));
    },

    async meta(key, fallback) {
        const row = await this.get('meta', key);
        return row ? row.value : fallback;
    },

    // 兼容别名：早期代码到处写的是 getMeta()
    async getMeta(key, fallback) {
        return this.meta(key, fallback);
    },

    async setMeta(key, value) {
        return this.put('meta', { key, value });
    },
};

/* =========================================================================
 * 5. 实体规范化与校验
 * ========================================================================= */

const WJL_Schema = {
    normalizeEntity(raw, opts) {
        const o = opts || {};
        const src = raw && typeof raw === 'object' ? raw : {};
        const type = String(src.type || src.category || '').trim();
        if (!WJL_CATEGORIES[type]) {
            throw new Error('未知实体类型：' + (type || '(空)') + '，可选：' + Object.keys(WJL_CATEGORIES).join(', '));
        }
        const id = String(src.id || src.entity_id || '').trim() || (WJL_CATEGORIES[type].prefix + '_' + WJL_Util.hash32(JSON.stringify(src)).toString(36));
        const name = String(src.name || src.title || '').trim();
        if (!name) throw new Error('实体 ' + id + ' 缺少 name 字段');

        const fields = {};
        const rawFields = (src.fields && typeof src.fields === 'object') ? src.fields : {};
        for (const [k] of WJL_CATEGORIES[type].fields) {
            const v = rawFields[k] !== undefined ? rawFields[k] : src[k];
            if (v !== undefined && v !== null && v !== '') {
                fields[k] = Array.isArray(v) ? v.map(String) : String(v);
            }
        }
        const quality = WJL_QUALITY_ORDER.includes(src.quality) ? src.quality : 'pending';
        return {
            id,
            type,
            subtype: String(src.subtype || ''),
            name,
            aliases: WJL_Util.toArray(src.aliases),
            tags: WJL_Util.toArray(src.tags),
            summary: String(src.summary || src.description || ''),
            fields,
            content: String(src.content || ''),
            source_ids: WJL_Util.toArray(src.source_ids || src.source_id),
            gender_basis: String(src.gender_basis || fields.gender_basis || ''),
            quality,
            adaptation_flag: !!src.adaptation_flag,
            status: ['active', 'review', 'conflict', 'deprecated'].includes(src.status) ? src.status : 'active',
            created_at: src.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            origin: o.origin || src.origin || 'import',
        };
    },

    normalizeDocument(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const source_id = String(src.source_id || src.id || '').trim();
        const title = String(src.title || '').trim();
        const content = String(src.content || src.text || '');
        if (!source_id) throw new Error('文档缺少 source_id');
        if (!title) throw new Error('文档 ' + source_id + ' 缺少 title');
        if (!content) throw new Error('文档 ' + source_id + ' 正文为空');
        return {
            source_id,
            source_file: String(src.source_file || ''),
            title,
            content,
            category: String(src.category || '未分类'),
            source_path: String(src.source_path || ''),
            source_hash: String(src.source_hash || WJL_Util.hash32(content).toString(16)),
            import_time: src.import_time || new Date().toISOString(),
        };
    },

    normalizeRelation(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const source_entity_id = String(src.source_entity_id || '');
        const target_entity_id = String(src.target_entity_id || '');
        const target_label = String(src.target_label || '');
        // 目标可以是资料库外对象（如法宝本体不在四类实体里），此时只保留名称
        if (!source_entity_id || (!target_entity_id && !target_label)) {
            throw new Error('关联缺少 source_entity_id，且没有 target_entity_id / target_label');
        }
        return {
            relation_id: String(src.relation_id || ('rel_' + WJL_Util.hash32(source_entity_id + '>' + (src.relation_type || 'related') + '>' + (target_entity_id || target_label)).toString(36))),
            source_entity_id,
            relation_type: String(src.relation_type || 'related'),
            target_entity_id,
            target_label,
            description: String(src.description || ''),
            source_ids: WJL_Util.toArray(src.source_ids),
        };
    },

    hasFemaleEvidence(e) {
        if (e.gender_basis && e.gender_basis.trim()) return true;
        if (e.fields && e.fields.gender_basis && String(e.fields.gender_basis).trim()) return true;
        if ((e.tags || []).some(t => /^(女|女性|女子|女性向|女主)$/.test(String(t).trim()))) return true;
        const hay = (e.summary || '') + (e.content || '') + JSON.stringify(e.fields || {});
        if (/女修|女仙|女子|少女|女性|女神|女帝|女尊|娘娘|圣女|师妹|师姐|女童/.test(hay)) {
            // 仅有泛化词时降低可信度，交给调用方判断
            return true;
        }
        return false;
    },

    realmRank(text) {
        const t = String(text || '');
        for (let i = WJL_REALMS.length - 1; i >= 0; i--) {
            if (t.includes(WJL_REALMS[i])) return i;
        }
        return -1;
    },
};

/* =========================================================================
 * 6. 检索与筛选引擎
 * ========================================================================= */

const WJL_Query = {
    haystack(e) {
        if (e.__hay) return e.__hay;
        const parts = [e.name, (e.aliases || []).join(' '), (e.tags || []).join(' '), e.summary, e.gender_basis];
        for (const v of Object.values(e.fields || {})) {
            parts.push(Array.isArray(v) ? v.join(' ') : String(v));
        }
        const hay = WJL_Util.norm(parts.join(' '));
        try { Object.defineProperty(e, '__hay', { value: hay, enumerable: false, configurable: true }); } catch { }
        return hay;
    },

    normalizeParams(input) {
        const p = input && typeof input === 'object' ? { ...input } : {};
        const f = (p.filters && typeof p.filters === 'object') ? p.filters : {};
        const merged = { ...p };
        delete merged.filters;
        for (const [k, v] of Object.entries(f)) if (merged[k] === undefined) merged[k] = v;
        const out = {
            category: merged.category || merged.type || '',
            keyword: String(merged.keyword || '').trim(),
            tags: WJL_Util.toArray(merged.tags),
            realm: String(merged.realm || '').trim(),
            realmMin: String(merged.realm_min || merged.realmMin || '').trim(),
            realmMax: String(merged.realm_max || merged.realmMax || '').trim(),
            race: String(merged.race || '').trim(),
            bloodline: String(merged.bloodline || '').trim(),
            grade: String(merged.grade || '').trim(),
            artifact_type: String(merged.artifact_type || '').trim(),
            species: String(merged.species || '').trim(),
            habitat: String(merged.habitat || '').trim(),
            domain: String(merged.domain || '').trim(),
            sect: String(merged.sect || '').trim(),
            canTransform: merged.can_transform === true || merged.canTransform === true,
            scope: ['entity', 'document', 'auto'].includes(String(merged.scope || '')) ? String(merged.scope) : 'entity',
            allowAdaptation: merged.allow_adaptation === undefined ? null : !!merged.allow_adaptation,
            allowPending: !!merged.allow_pending,
            excludeIds: WJL_Util.toArray(merged.exclude_ids),
            includeDeprecated: !!merged.include_deprecated,
            limit: WJL_Util.clamp(merged.limit === undefined ? 5 : merged.limit, 1, 50),
            count: WJL_Util.clamp(merged.count === undefined ? 1 : merged.count, 1, 10),
            randomMode: merged.random_mode === 'uniform' ? 'uniform' : 'weighted',
            seed: merged.seed === undefined ? null : merged.seed,
            excludeRecent: merged.exclude_recent !== false,
            recentWindow: WJL_Util.clamp(merged.recent_window === undefined ? 0 : merged.recent_window, 0, 200),
            detailLevel: WJL_DETAIL_LEVELS[merged.detail_level] ? merged.detail_level : 'standard',
        };
        if (!WJL_CATEGORIES[out.category]) out.category = '';
        return out;
    },

    /** 硬性条件：不满足直接淘汰 */
    hardFilter(e, p, ctx) {
        const s = ctx.settings || WJL_DEFAULT_SETTINGS;
        if (p.category && e.type !== p.category) return false;
        if (!p.includeDeprecated && e.status === 'deprecated') return false;
        if (!p.includeDeprecated && e.status === 'conflict') return false;

        const allowPending = p.allowPending || s.allowPending;
        const allowAdapt = p.allowAdaptation === null ? !!s.allowAdaptation : p.allowAdaptation;

        if (!allowPending && (e.quality === 'pending' || e.quality === 'conflict')) return false;
        if (!allowAdapt && (e.adaptation_flag || e.quality === 'adapted')) return false;
        if (p.excludeIds.includes(e.id)) return false;

        const female = WJL_Schema.hasFemaleEvidence(e);
        if (!female && !allowAdapt) return false;

        if (p.realm) {
            const rank = WJL_Schema.realmRank(e.fields.realm || e.fields.beast_rank || '');
            const want = WJL_Schema.realmRank(p.realm);
            if (want >= 0 && rank !== want) return false;
            if (want < 0 && !WJL_Util.norm(e.fields.realm || '').includes(WJL_Util.norm(p.realm))) return false;
        }
        if (p.realmMin) {
            const rank = WJL_Schema.realmRank(e.fields.realm || '');
            const min = WJL_Schema.realmRank(p.realmMin);
            if (rank < 0 || (min >= 0 && rank < min)) return false;
        }
        if (p.realmMax) {
            const rank = WJL_Schema.realmRank(e.fields.realm || '');
            const max = WJL_Schema.realmRank(p.realmMax);
            if (rank < 0 || (max >= 0 && rank > max)) return false;
        }
        const fieldMatch = (key, value) => {
            if (!value) return true;
            const v = e.fields[key];
            const vv = Array.isArray(v) ? v.join(' ') : String(v || '');
            return WJL_Util.norm(vv).includes(WJL_Util.norm(value));
        };
        if (!fieldMatch('race', p.race)) return false;
        if (!fieldMatch('bloodline', p.bloodline)) return false;
        if (!fieldMatch('grade', p.grade)) return false;
        if (!fieldMatch('artifact_type', p.artifact_type)) return false;
        if (!fieldMatch('species', p.species)) return false;
        if (!fieldMatch('habitat', p.habitat)) return false;
        if (!fieldMatch('domain', p.domain)) return false;
        if (!fieldMatch('sect', p.sect)) return false;
        if (p.canTransform && !String(e.fields.human_form_condition || '').trim()) return false;
        return true;
    },

    score(e, p) {
        let w = 1.0;
        const hay = WJL_Query.haystack(e);
        const nameNorm = WJL_Util.norm(e.name + ' ' + (e.aliases || []).join(' '));
        if (p.keyword) {
            const k = WJL_Util.norm(p.keyword);
            if (nameNorm.includes(k)) w += 3.0;
            else if (hay.includes(k)) w += 1.5;
        }
        for (const tag of p.tags) {
            const t = WJL_Util.norm(tag);
            if (nameNorm.includes(t)) w += 2.0;
            else if ((e.tags || []).some(x => WJL_Util.norm(x) === t)) w += 2.0;
            else if (hay.includes(t)) w += 1.0;
        }
        if (e.quality === 'verified') w += 0.6;
        if (e.quality === 'inferred') w += 0.3;
        if (e.tags && e.tags.length) w += Math.min(0.4, e.tags.length * 0.05);
        return w;
    },

    candidates(entities, p, ctx) {
        const pool = entities.filter(e => WJL_Query.hardFilter(e, p, ctx));
        return pool;
    },

    rank(entities, p) {
        return entities
            .map(e => ({ e, w: WJL_Query.score(e, p) }))
            .sort((a, b) => (b.w - a.w) || (a.e.id < b.e.id ? -1 : 1));
    },
};

/* =========================================================================
 * 7. 结果格式化（控制上下文占用）
 * ========================================================================= */

/* =========================================================================
 * 3.5 背景骨架（WJL_Profile）
 *
 * 插件产出的不是「一个人」，而是一份可以开始写卡的门面资料：
 *   女修：身份 / 所属门派 / 境界 / 灵根 / 主修功法 / 气质外形
 *   神佛：尊号 / 神职 / 道场 / 果位
 *   器灵：依附法宝 / 法宝类别 / 品阶 / 显化形态
 *   异兽：物种 / 血脉 / 品阶 / 栖息地
 * 门派、境界、灵根、功法从资料库原文池里随机配对（每条可回溯原文），
 * 姓名、性格、经历、台词一律交给模型。
 * ========================================================================= */

// 门派阵营：决定哪些身份能落在这个门派里（「魔修」不该出现在少林寺）
const WJL_SECT_ALIGN = [
    [/魔|血|幽冥|修罗|尸魂|白骨|合欢|五毒|万毒|毒/, '魔道'],
    [/妖|兽/, '妖族'],
    [/佛|寺|禅|金刚/, '佛门'],
    [/商会|坊/, '商盟'],
    [/联盟/, '联盟'],
];

const WJL_IDENTITY_ALIGN = [
    [/魔修/, ['魔道']],
    [/妖修|妖王/, ['妖族']],
    [/圣女|仙子|亲传弟子|真传弟子|内门弟子|外门弟子|执事弟子|师姐|师妹|峰主|宗主|掌门|宗门长老/, ['正道', '佛门', '世家', '殿阁', '门派', '宗门']],
    [/女帝|公主/, ['殿阁', '世家', '联盟', '妖族']],
    [/散修|丹修|道侣|红颜知己|护道者/, null],
];

function wjlSectAlign(name) {
    const n = String(name || '');
    for (const [re, align] of WJL_SECT_ALIGN) if (re.test(n)) return align;
    return '正道';
}

// 身份层级：2=掌门/长老一级，1=圣女/仙子/亲传，0=外门/内门/散修
const WJL_IDENTITY_TIER = [
    [/长老|宗主|掌门|峰主|女帝|妖王|公主|殿主|城主|家主/, 2],
    [/圣女|仙子|亲传弟子|真传弟子|执事弟子|师姐|魔修|妖修|丹修|护道者/, 1],
    [/外门弟子|内门弟子|师妹|散修|道侣|红颜知己/, 0],
];

function wjlIdentTier(name) {
    for (const [re, tier] of WJL_IDENTITY_TIER) if (re.test(String(name || ''))) return tier;
    return 1;
}

const WJL_Profile = {
    EMPTY: { sects: [], techniques: [], spirit_roots: [], realms: [], identities: [] },

    hasPools() {
        return !!(WJL_State.pools && WJL_State.pools.sects && WJL_State.pools.sects.length);
    },

    compose(entity, seed) {
        const f = (entity && entity.fields) || {};
        const pools = WJL_State.pools || WJL_Profile.EMPTY;
        const rng = WJL_Rng.fromSeed('wjl-bg|' + String(seed == null ? '' : seed) + '|' + entity.id);
        const pick = (arr) => (arr && arr.length ? arr[Math.floor(rng() * arr.length)] : null);
        const trim = (v, n) => (v == null || v === '' ? '' : WJL_Util.truncate(String(v).replace(/\s+/g, ' ').trim(), n || 46));

        const fields = {};
        const provenance = {};
        const add = (label, value, src) => {
            const v = trim(value);
            if (!v) return;
            fields[label] = v;
            if (src) provenance[label] = src;
        };

        let authored = [];
        let note = '';

        if (entity.type === 'female_cultivator') {
            // 身份：优先用原文里的身份描述；模板型名字（「圣女型」「神秘型」）不能当身份，
            // 退到资料库身份池，再退到「某宗弟子」这类通用身份。
            const rawId = f.relationships || f.gender_basis || '';
            let idText = rawId.indexOf('：') > 0 ? rawId.slice(rawId.indexOf('：') + 1) : rawId;
            idText = String(idText).split(/[、，,；;]/)[0].trim();
            // 身份必须是「身份词」：圣女/长老/弟子/掌门/散修/女帝/公主/师姐…；
            // 否则（如「圣母过度」「对敌人心慈手软」）一律退回身份池。
            const idWord = /(圣女|圣子|仙|神女|长老|掌门|宗主|弟子|门人|传人|散修|女帝|公主|师姐|师妹|师父|师尊|执事|护法|使者|阁主|殿主|岛主|城主|家主|妃|夫人|仙女|妖女|魔女|圣女|真人|真君|仙子|器灵|道侣|红颜)/.test(idText);
            const idBad = !idText || !idWord || idText.length > 20 || /型|模板|示例|核心|表现|过度|缺点|弱点/.test(idText);
            const identAlign = (name) => {
                const rule = WJL_IDENTITY_ALIGN.find(([re]) => re.test(name));
                return rule ? rule[1] : null;
            };
            const idRule = idBad ? null : identAlign(idText);
            const sects = pools.sects || [];
            const fitSects = idRule ? sects.filter(x => idRule.indexOf(wjlSectAlign(x.name)) >= 0) : [];
            const sect = pick(fitSects.length ? fitSects : sects);
            const align = wjlSectAlign(sect && sect.name);
            // 境界要先定：它决定身份层级（大罗不会是外门弟子）
            const highRealms = (pools.realms || []).filter(x => WJL_Schema.realmRank(x) >= 3);
            const realmName = f.realm || pick(highRealms.length ? highRealms : pools.realms);
            let identName = idBad ? '' : idText;
            if (!identName) {
                const rr = WJL_Schema.realmRank(realmName);
                const tiers = rr >= 9 ? [1, 2] : (rr >= 4 ? [1] : [0, 1]);
                const okIdents = (pools.identities || []).filter(x => {
                    const r = identAlign(x.name);
                    const tierOk = tiers.indexOf(wjlIdentTier(x.name)) >= 0;
                    return tierOk && (!r || r.indexOf(align) >= 0);
                });
                identName = (pick(okIdents.length ? okIdents : (pools.identities || [])) || {}).name || '宗门弟子';
            }
            // 散修本来就没有门派：标签改成「出身门派」，语义才不矛盾
            const wanderer = /散修|游历/.test(identName);
            if (sect) add(wanderer ? '出身门派' : '所属门派', sect.kind ? sect.name + '（' + sect.kind + '）' : sect.name, sect.source_ids);
            add('身份', identName, idBad ? 'library' : 'entity');
            add('境界', realmName, f.realm ? 'entity' : 'library');
            add('灵根', f.spirit_root || (pick(pools.spirit_roots) || {}).name, f.spirit_root ? 'entity' : 'library');
            // 主修功法：原文的「功法法术」字段常是「剑、琴、扇」这种特长，不是功法名，
            // 只有看着像功法（结尾是 功/法/诀/经/术/掌/拳/指/神通…且不含顿号）才采用。
            const techText = String(f.techniques || '').trim();
            const techOk = techText && techText.length <= 14 && !/[、，,]/.test(techText)
                && /(功|法|诀|经|术|掌|拳|指|腿|步|身法|剑法|刀法|枪法|神通|真解|大道|录|篇|咒|阵)$/.test(techText);
            const tech = pick(pools.techniques);
            add('主修功法', techOk ? techText : (tech && tech.name), techOk ? 'entity' : 'library');
            add('气质外形', f.appearance, 'entity');
            authored = ['姓名', '年龄段与生日', '性格', '个人经历', '说话方式', '门派内的具体职务', '功法的招式细节'];
            note = '门派/境界/灵根/功法为资料库随机配对（各自有原文出处），角色本身由模型创作。';
        } else if (entity.type === 'female_deity') {
            add('尊号', f.title || entity.name, 'entity');
            add('神职', f.domain, 'entity');
            add('道场', f.daoist_site, 'entity');
            add('果位/神阶', f.divine_rank || f.buddhist_rank, 'entity');
            add('信众与香火', f.faith, 'entity');
            authored = ['具体化身形象', '灵验传闻', '信众口中的故事'];
            note = '尊号/神职/道场取自原文；化身细节与故事由模型创作。';
        } else if (entity.type === 'female_artifact_spirit') {
            add('依附法宝', f.artifact_name || entity.name, 'entity');
            add('法宝类别', f.artifact_type, 'entity');
            add('品阶', f.grade, 'entity');
            add('显化形态', f.manifestation_form, 'entity');
            add('能力与限制', f.abilities || f.limitations, 'entity');
            authored = ['器灵姓名', '女子形态与样貌', '性格', '认主经过', '与主人的相处方式'];
            note = '素材只给法宝名与形制：器灵的女性形态、样貌、性格由模型补全。';
        } else if (entity.type === 'female_beast') {
            add('物种', f.species || entity.name, 'entity');
            // 血脉常是整段来历，卡片里塞不下：截到第一个句号、最多 60 字
            const blood = String(f.bloodline || '');
            add('血脉', blood ? (blood.split('。')[0].slice(0, 60) + (blood.split('。')[0].length > 60 ? '…' : '')) : '', 'entity');
            add('品阶', f.beast_rank, 'entity');
            add('栖息地', f.habitat, 'entity');
            add('天赋神通', f.innate_abilities, 'entity');
            add('化形条件', f.human_form_condition, 'entity');
            authored = ['化形后的女子形象', '名字', '性格', '与人类的相处'];
            note = '物种/血脉/栖息地取自原文；化形后的女子样貌与性格由模型创作。';
        } else {
            add('名目', entity.name, 'entity');
            add('摘要', entity.summary, 'entity');
        }

        return {
            fields,
            provenance,
            created_by: '资料库随机配对（seed 可复现）',
            to_be_authored: authored,
            pools_ready: WJL_Profile.hasPools(),
            note,
        };
    },
};

const WJL_Format = {
    factLines(e, budget, level) {
        const def = WJL_CATEGORIES[e.type];
        if (!def) return [];
        const perKey = level === 'compact' ? 90 : level === 'standard' ? 160 : 400;
        const maxKeys = level === 'compact' ? 4 : level === 'standard' ? 10 : 99;
        const lines = [];
        for (const [key, label] of def.fields) {
            const raw = e.fields[key];
            if (raw === undefined || raw === null || raw === '') continue;
            const val = Array.isArray(raw) ? raw.join('、') : String(raw);
            lines.push(label + '：' + WJL_Util.truncate(val, perKey));
            if (lines.length >= maxKeys) break;
        }
        let text = lines.join('\n');
        if (text.length > budget) text = WJL_Util.truncate(text, budget);
        return text ? text.split('\n') : [];
    },

    entityToResult(e, level, maxChars, seed) {
        const def = WJL_CATEGORIES[e.type];
        const budget = Math.max(200, Math.floor((maxChars || 3200) / 2));
        const out = {
            id: e.id,
            name: e.name,
            category: e.type,
            category_label: def ? def.label : e.type,
            summary: WJL_Util.truncate(e.summary, level === 'compact' ? 90 : level === 'standard' ? 200 : 400),
            tags: (e.tags || []).slice(0, level === 'compact' ? 4 : 12),
            quality: e.quality,
            quality_label: WJL_QUALITY_LABEL[e.quality] || e.quality,
            adaptation_flag: !!e.adaptation_flag,
            gender_basis: WJL_Util.truncate(e.gender_basis, level === 'compact' ? 60 : 160),
            source_ids: (e.source_ids || []).slice(0, level === 'complete' ? 20 : 3),
        };
        const facts = {};
        for (const line of WJL_Format.factLines(e, budget, level)) {
            const idx = line.indexOf('：');
            if (idx > 0) facts[line.slice(0, idx)] = line.slice(idx + 1);
        }
        out.facts = facts;
        // 器灵素材约定：素材只给法宝名与形制，女子形态由模型自行补全
        if (e.type === 'female_artifact_spirit' && e.fields && e.fields.artifact_name
            && String(e.subtype || '').indexOf('法宝名') >= 0) {
            out.material_note = '素材只提供法宝名与形制；器灵的女性形态、样貌、性格由模型补全。';
        }
        // 背景骨架：门派/境界/灵根/功法这类「门面资料」由资料库随机配对，
        // 姓名、性格、经历、台词留给模型。
        out.background = WJL_Profile.compose(e, seed);
        if (level === 'complete' && e.content) out.content = WJL_Util.truncate(e.content, 800);
        return out;
    },

    results(results, level, extra) {
        const payload = {
            success: true,
            count: results.length,
            detail_level: level,
            results,
            warnings: [],
        };
        if (extra && Object.keys(extra).length) payload.meta = extra;
        return payload;
    },

    text(results, level) {
        if (!results.length) return '（无匹配素材）';
        return results.map((r, i) => {
            const head = `${i + 1}. ${r.name}（${r.category_label}｜${r.quality_label}）`;
            const body = Object.entries(r.facts || {}).map(([k, v]) => `   ${k}：${v}`).join('\n');
            const bg = r.background && r.background.fields
                ? Object.entries(r.background.fields).map(([k, v]) => `${k}：${v}`).join('；')
                : '';
            return head + (r.summary ? '\n   ' + r.summary : '')
                + (bg ? '\n   【背景骨架】' + bg : '')
                + (body ? '\n' + body : '');
        }).join('\n\n');
    },
};

/* =========================================================================
 * 8. 运行时状态与控制器
 * ========================================================================= */

const WJL_State = {
    loaded: false,
    entities: [],
    entityMap: new Map(),
    documents: [],
    relations: [],
    history: [],
    settings: { ...WJL_DEFAULT_SETTINGS },
    lastStats: { documents: 0, entities: 0, relations: 0, byType: {} },
    toolsRegistered: false,
    uiReady: false,
    pools: null,
};

const WJL_Controller = {
    async loadPools() {
        try {
            const meta = await WJL_DB.getMeta('pools');
            if (meta && meta.sects && meta.sects.length) {
                WJL_State.pools = meta;
                return meta;
            }
        } catch (err) { /* 旧库没有池子，用兜底 */ }
        WJL_State.pools = {
            sects: [], techniques: [], spirit_roots: [], identities: [],
            realms: WJL_REALMS.slice(),
        };
        return WJL_State.pools;
    },

    async reload() {
        WJL_State.docCache = null;
        await this.loadPools();
        WJL_State.entities = (await WJL_DB.getAll('entities')).map(e => {
            if (!e.fields) e.fields = {};
            return e;
        });
        WJL_State.entityMap = new Map(WJL_State.entities.map(e => [e.id, e]));
        WJL_State.relations = await WJL_DB.getAll('relations');
        WJL_State.history = (await WJL_DB.getAll('history')).sort((a, b) => a.seq - b.seq);
        const docs = await WJL_DB.count('documents');
        const byType = {};
        for (const e of WJL_State.entities) byType[e.type] = (byType[e.type] || 0) + 1;
        WJL_State.lastStats = {
            documents: docs,
            entities: WJL_State.entities.length,
            relations: WJL_State.relations.length,
            byType,
            favorites: await WJL_DB.count('favorites'),
        };
        WJL_State.loaded = true;
        return WJL_State.lastStats;
    },

    async stats() {
        if (!WJL_State.loaded) await this.reload();
        return WJL_State.lastStats;
    },

    recentIds(windowSize) {
        const n = WJL_Util.clamp(windowSize || WJL_State.settings.recentWindow || 20, 0, 500);
        if (!n) return [];
        const recent = WJL_State.history.slice(-n);
        const ids = [];
        for (const h of recent) for (const id of (h.ids || [])) ids.push(id);
        return Array.from(new Set(ids));
    },

    async search(rawParams) {
        const p = WJL_Query.normalizeParams(rawParams);
        if (p.scope === 'document') return this.searchDocuments(rawParams);
        const pool = WJL_Query.candidates(WJL_State.entities, p, { settings: WJL_State.settings });
        const ranked = WJL_Query.rank(pool, p).slice(0, p.limit);
        const maxChars = WJL_DETAIL_LEVELS[p.detailLevel];
        const results = ranked.map(r => WJL_Format.entityToResult(r.e, p.detailLevel, maxChars, p.seed));
        const payload = WJL_Format.results(results, p.detailLevel, {
            total_candidates: pool.length,
            applied: WJL_Controller.describeParams(p),
        });
        if (p.scope === 'auto' && results.length < p.limit) {
            const docs = await this.searchDocuments({ ...rawParams, scope: 'document', limit: p.limit - results.length });
            payload.documents = docs.payload.results || [];
            if (payload.documents.length) payload.warnings.push('实体不足，已附带资料库原文片段，可作为设定依据（注意：片段是设定文本，不是角色）。');
            else for (const w of (docs.payload.warnings || [])) payload.warnings.push(w);
        }
        return { ok: true, params: p, total: results.length, payload };
    },

    async ensureDocs() {
        if (WJL_State.docCache) return WJL_State.docCache;
        const docs = await WJL_DB.getAll('documents');
        WJL_State.docCache = docs.map(d => ({
            id: d.source_id,
            title: d.title || '',
            category: d.category || '',
            source_path: d.source_path || '',
            text: String(d.content || ''),
            lower: String(d.content || '').toLowerCase(),
        }));
        return WJL_State.docCache;
    },

    async searchDocuments(rawParams) {
        const p = WJL_Query.normalizeParams(rawParams);
        const kw = String(p.keyword || '').trim();
        const warnings = [];
        if (!kw) {
            return {
                ok: false,
                params: p,
                payload: { success: false, scope: 'document', count: 0, results: [], warnings: ['资料片段检索需要 keyword 参数'] },
            };
        }
        const docs = await this.ensureDocs();
        const needle = kw.toLowerCase();
        const limit = WJL_Util.clamp(p.limit || 5, 1, 8);
        const scored = [];
        for (const d of docs) {
            let score = 0;
            if (d.title.toLowerCase().includes(needle)) score += 6;
            const idx = d.lower.indexOf(needle);
            if (idx >= 0) {
                const hits = d.lower.split(needle).length - 1;
                score += 2 + Math.min(3, hits * 0.5);
            }
            if (score <= 0) continue;
            scored.push({ d, score, idx });
        }
        scored.sort((a, b) => b.score - a.score || (a.d.id < b.d.id ? -1 : 1));
        const results = scored.slice(0, limit).map(({ d, score, idx }) => {
            const start = Math.max(0, idx - 60);
            const snippet = d.text.slice(start, start + 240).replace(/\s+/g, ' ').trim();
            return {
                kind: 'document',
                id: d.id,
                title: d.title,
                category: d.category,
                source_path: d.source_path,
                snippet: (start > 0 ? '…' : '') + snippet + (start + 240 < d.text.length ? '…' : ''),
                score: Number(score.toFixed(2)),
            };
        });
        if (!results.length) warnings.push('资料库中没有包含该关键词的篇章，试试更短或更通用的词（如「器灵」「金丹」）。');
        return {
            ok: true,
            params: p,
            payload: {
                success: true,
                scope: 'document',
                count: results.length,
                results,
                warnings,
                meta: { matched: scored.length, scanned: docs.length, keyword: kw },
            },
        };
    },

    describeParams(p) {
        const d = [];
        if (p.category) d.push('类别=' + (WJL_CATEGORIES[p.category] ? WJL_CATEGORIES[p.category].label : p.category));
        if (p.keyword) d.push('关键词=' + p.keyword);
        if (p.tags.length) d.push('标签=' + p.tags.join('/'));
        if (p.realm) d.push('境界=' + p.realm);
        if (p.bloodline) d.push('血脉=' + p.bloodline);
        if (p.grade) d.push('品阶=' + p.grade);
        if (p.canTransform) d.push('须可化形');
        return d;
    },

    async generate(rawParams) {
        const p = WJL_Query.normalizeParams(rawParams);
        const warnings = [];
        const settled = { ...WJL_State.settings };
        const ctx = { settings: settled };

        let exclude = p.excludeIds.slice();
        if (p.excludeRecent) {
            const recent = this.recentIds(p.recentWindow || settled.recentWindow);
            exclude = Array.from(new Set(exclude.concat(recent)));
        }
        let pool = WJL_Query.candidates(WJL_State.entities, { ...p, excludeIds: exclude }, ctx);
        let relaxed = [];

        if (pool.length < p.count) {
            relaxed.push('候选不足，已放宽“近期去重”限制（可能需要允许重复素材）');
            pool = WJL_Query.candidates(WJL_State.entities, { ...p, excludeIds: p.excludeIds.slice() }, ctx);
        }
        if (pool.length === 0 && (p.allowPending || settled.allowPending) === false) {
            const retry = WJL_Query.candidates(WJL_State.entities, { ...p, excludeIds: p.excludeIds.slice(), allowPending: true }, ctx);
            if (retry.length) {
                pool = retry;
                relaxed.push('已包含“待核查”素材，请在使用时注明来源可信度');
            }
        }
        if (pool.length === 0) {
            return {
                ok: false,
                error: '没有满足条件的素材',
                params: p,
                payload: {
                    success: false,
                    count: 0,
                    results: [],
                    warnings: ['当前资料库中没有满足条件的候选，请放宽条件或先导入资料包'],
                },
            };
        }

        pool = pool.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
        const seed = p.seed === null || p.seed === '' ? null : p.seed;
        const rand = WJL_Rng.fromSeed(seed === null ? Math.floor(Math.random() * 0xffffffff) : seed);
        let picked;
        if (p.randomMode === 'uniform') {
            picked = WJL_Rng.sampleUniform(pool, p.count, rand);
        } else {
            const weights = pool.map(e => WJL_Query.score(e, p));
            picked = WJL_Rng.sampleWeighted(pool, weights, p.count, rand);
        }
        if (pool.length < p.count) relaxed.push(`符合条件的素材只有 ${pool.length} 条，少于请求的 ${p.count} 条`);

        const actualSeed = seed === null ? wjlStateSeed(rand) : seed;
        const maxChars = WJL_DETAIL_LEVELS[p.detailLevel];
        const results = picked.map(e => WJL_Format.entityToResult(e, p.detailLevel, maxChars, p.seed));

        await this.recordExtraction(picked.map(e => e.id), p, actualSeed);

        return {
            ok: true,
            params: p,
            seed: actualSeed,
            payload: WJL_Format.results(results, p.detailLevel, {
                seed: actualSeed,
                candidates: pool.length,
                relaxed: relaxed,
                warnings: relaxed,
            }),
        };
    },

    async recordExtraction(ids, p, seed) {
        const row = {
            ts: Date.now(),
            ids,
            category: p.category,
            params: { keyword: p.keyword, tags: p.tags, realm: p.realm },
            seed,
        };
        try {
            await WJL_DB.put('history', row);
            WJL_State.history.push(row);
            const all = WJL_State.history;
            if (all.length > 500) {
                const drop = all.splice(0, all.length - 500);
                for (const d of drop) await WJL_DB.delete('history', d.seq);
            }
        } catch (e) {
            console.warn('[万界仙录] 记录抽取历史失败', e);
        }
    },

    lookup(rawParams) {
        const p = rawParams && typeof rawParams === 'object' ? rawParams : {};
        const id = String(p.id || p.entity_id || '').trim();
        const name = String(p.name || p.keyword || '').trim();
        const level = WJL_DETAIL_LEVELS[p.detail_level] ? p.detail_level : 'standard';
        let hit = null;
        if (id) hit = WJL_State.entityMap.get(id) || null;
        if (!hit && name) {
            const n = WJL_Util.norm(name);
            hit = WJL_State.entities.find(e => WJL_Util.norm(e.name) === n)
                || WJL_State.entities.find(e => (e.aliases || []).some(a => WJL_Util.norm(a) === n))
                || WJL_State.entities.find(e => WJL_Util.norm(e.name).includes(n))
                || null;
        }
        if (!hit) {
            return { ok: false, payload: { success: false, count: 0, results: [], warnings: ['未找到对应实体，请先用 search 确认名称或 ID'] } };
        }
        const result = WJL_Format.entityToResult(hit, level, WJL_DETAIL_LEVELS[level]);
        return {
            ok: true,
            payload: WJL_Format.results([result], level, {
                relations: this.relationsOf(hit.id).length,
            }),
        };
    },

    relationsOf(entityId) {
        return WJL_State.relations.filter(r => r.source_entity_id === entityId || r.target_entity_id === entityId);
    },

    related(rawParams) {
        const p = rawParams && typeof rawParams === 'object' ? rawParams : {};
        const id = String(p.id || p.entity_id || '').trim();
        let base = id ? WJL_State.entityMap.get(id) : null;
        if (!base && p.name) {
            const n = WJL_Util.norm(p.name);
            base = WJL_State.entities.find(e => WJL_Util.norm(e.name) === n) || null;
        }
        if (!base) {
            return { ok: false, payload: { success: false, count: 0, results: [], warnings: ['未找到基准实体'] } };
        }
        const relType = String(p.relation_type || '').trim();
        const rels = this.relationsOf(base.id).filter(r => !relType || r.relation_type === relType);
        const level = WJL_DETAIL_LEVELS[p.detail_level] ? p.detail_level : 'standard';
        const results = [];
        const notes = [];
        for (const r of rels) {
            const otherId = r.source_entity_id === base.id ? r.target_entity_id : r.source_entity_id;
            const other = otherId ? WJL_State.entityMap.get(otherId) : null;
            if (!other && r.target_label) {
                notes.push(`外部关联：${r.target_label}（${r.relation_type}）${WJL_Util.truncate(r.description, 100)}`);
                continue;
            }
            if (other) {
                const item = WJL_Format.entityToResult(other, level, WJL_DETAIL_LEVELS[level]);
                item.relation_type = r.relation_type;
                item.relation_description = WJL_Util.truncate(r.description, 120);
                results.push(item);
                notes.push(`${base.name} —[${r.relation_type}]→ ${other.name}`);
            } else {
                notes.push(`${base.name} —[${r.relation_type}]→ ${otherId}（未收录该实体）`);
            }
        }
        return {
            ok: true,
            payload: WJL_Format.results(results.slice(0, 10), level, {
                base: { id: base.id, name: base.name },
                relation_count: rels.length,
                notes: notes.slice(0, 12),
                warnings: (results.length || notes.length) ? [] : ['该实体暂未建立关联数据'],
            }),
        };
    },

    async saveResult(rawParams) {
        const p = rawParams && typeof rawParams === 'object' ? rawParams : {};
        const id = String(p.entity_id || p.id || '').trim();
        const entity = id ? WJL_State.entityMap.get(id) : null;
        const row = {
            id: WJL_Util.uuid('fav'),
            entity_id: id || (entity ? entity.id : ''),
            name: String(p.name || (entity ? entity.name : '') || '未命名'),
            note: String(p.note || ''),
            snapshot: p.snapshot || (entity ? WJL_Format.entityToResult(entity, 'complete', 7600) : null),
            created_at: new Date().toISOString(),
        };
        if (!row.entity_id && !row.snapshot) {
            return { ok: false, payload: { success: false, warnings: ['需要提供 entity_id 或 snapshot 才能收藏'] } };
        }
        await WJL_DB.put('favorites', row);
        if (WJL_State.loaded) WJL_State.lastStats.favorites = (WJL_State.lastStats.favorites || 0) + 1;
        return { ok: true, payload: { success: true, count: 1, results: [{ id: row.id, name: row.name }], warnings: [] } };
    },
};

function wjlStateSeed(rand) {
    // 从未使用的随机源中派生一个展示用种子（不参与实际抽取结果）
    return Math.floor(rand() * 0xffffffff) >>> 0;
}

/* =========================================================================
 * 9. 导入 / 导出
 * ========================================================================= */

const WJL_Import = {
    parseJsonl(text, label) {
        const lines = String(text || '').split(/\r?\n/);
        const rows = [];
        const errors = [];
        lines.forEach((line, i) => {
            const t = line.trim();
            if (!t) return;
            try {
                rows.push(JSON.parse(t));
            } catch (e) {
                if (errors.length < 20) errors.push(`${label || 'jsonl'} 第 ${i + 1} 行：${e.message}`);
            }
        });
        return { rows, errors };
    },

    parseJson(text, label) {
        try {
            const data = JSON.parse(String(text || ''));
            if (Array.isArray(data)) return { rows: data, errors: [] };
            if (data && typeof data === 'object') {
                const rows = [];
                for (const key of ['documents', 'entities', 'relations']) {
                    if (Array.isArray(data[key])) {
                        for (const r of data[key]) rows.push({ __kind: key, ...r });
                    }
                }
                if (rows.length) return { rows, errors: [] };
                return { rows: [data], errors: [] };
            }
            return { rows: [], errors: [`${label} 内容不是对象或数组`] };
        } catch (e) {
            return { rows: [], errors: [`${label} JSON 解析失败：${e.message}`] };
        }
    },

    classify(rows) {
        const out = { documents: [], entities: [], relations: [], invalid: [] };
        for (const raw of rows) {
            const r = raw || {};
            const kind = r.__kind;
            try {
                if (kind === 'documents' || r.source_id || (r.content && r.title && !r.type)) {
                    out.documents.push(WJL_Schema.normalizeDocument(r));
                } else if (kind === 'entities' || r.type) {
                    out.entities.push(WJL_Schema.normalizeEntity(r));
                } else if (kind === 'relations' || (r.source_entity_id && (r.target_entity_id || r.target_label))) {
                    out.relations.push(WJL_Schema.normalizeRelation(r));
                } else {
                    out.invalid.push('无法识别的记录：' + WJL_Util.truncate(JSON.stringify(r), 80));
                }
            } catch (e) {
                out.invalid.push(e.message);
            }
        }
        return out;
    },

    /**
     * 导入一批文本（jsonl 或 json）。全部校验通过后才写入，避免半途失败清空资料库。
     */
    async importTexts(texts, opts) {
        const o = opts || {};
        const collected = { documents: [], entities: [], relations: [] };
        const errors = [];
        for (const t of texts) {
            const raw = String(t.text || '').trim();
            let parsed;
            if (raw.startsWith('[')) {
                parsed = this.parseJson(raw, t.label);
            } else if (raw.startsWith('{')) {
                // 数组式 JSON 走 parseJson；多行 JSONL 会因为整体解析失败再退回逐行解析
                const one = this.parseJson(raw, t.label);
                parsed = one.errors.length ? this.parseJsonl(raw, t.label) : one;
            } else {
                parsed = this.parseJsonl(raw, t.label);
            }
            errors.push(...parsed.errors);
            const cls = this.classify(parsed.rows);
            errors.push(...cls.invalid);
            collected.documents.push(...cls.documents);
            collected.entities.push(...cls.entities);
            collected.relations.push(...cls.relations);
        }
        const total = collected.documents.length + collected.entities.length + collected.relations.length;
        if (total === 0) {
            return { ok: false, error: '没有可导入的有效记录', errors: errors.slice(0, 20), counts: { documents: 0, entities: 0, relations: 0 } };
        }
        if (o.replace) {
            if (errors.length > total) throw new Error('错误记录多于有效记录，已中止导入以保护现有资料库');
            await WJL_DB.clearAll();
        }
        // 去重（同 ID 后者覆盖前者）
        const uniq = (arr, key) => {
            const m = new Map();
            for (const x of arr) m.set(x[key], x);
            return Array.from(m.values());
        };
        const docs = uniq(collected.documents, 'source_id');
        const ents = uniq(collected.entities, 'id');
        const rels = uniq(collected.relations, 'relation_id');
        if (o.onProgress) o.onProgress('documents', 0, docs.length);
        await WJL_DB.putMany('documents', docs, (d, t) => o.onProgress && o.onProgress('documents', d, t));
        await WJL_DB.putMany('entities', ents, (d, t) => o.onProgress && o.onProgress('entities', d, t));
        await WJL_DB.putMany('relations', rels, (d, t) => o.onProgress && o.onProgress('relations', d, t));
        await WJL_DB.setMeta('last_import', new Date().toISOString());
        await WJL_Controller.reload();
        return {
            ok: true,
            counts: { documents: docs.length, entities: ents.length, relations: rels.length },
            errors: errors.slice(0, 20),
        };
    },

    async exportAll() {
        return {
            format: 'wanjie-xianlu-backup',
            version: WJL_PACK_VERSION,
            exported_at: new Date().toISOString(),
            documents: await WJL_DB.getAll('documents'),
            entities: await WJL_DB.getAll('entities'),
            relations: await WJL_DB.getAll('relations'),
        };
    },

    async importBuiltinPack(baseUrl, onProgress) {
        const base = String(baseUrl || '').replace(/\/?$/, '/');
        onProgress && onProgress('index', 0, 1);
        const res = await fetch(base + 'knowledge/index.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error('读取内置资料包索引失败：HTTP ' + res.status);
        const index = await res.json();
        const texts = [];
        const fetchFile = async (rel) => {
            const r = await fetch(base + 'knowledge/' + rel, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`读取 ${rel} 失败：HTTP ${r.status}`);
            texts.push({ label: rel, text: await r.text() });
        };
        if (index.documents) await fetchFile(index.documents);
        for (const f of (index.entities || [])) await fetchFile(f);
        if (index.relations) await fetchFile(index.relations);
        // 门面素材池（门派/功法/灵根）。先读出来，等资料写库之后再落库——
        // importTexts(replace) 会清空 meta，先写会被冲掉。
        let poolData = null;
        if (index.pools) {
            try {
                const pr = await fetch(base + 'knowledge/' + index.pools, { cache: 'no-cache' });
                if (pr.ok) poolData = await pr.json();
            } catch (err) { /* 池子失败不影响主资料导入 */ }
        }
        const result = await this.importTexts(texts, { replace: true, onProgress });
        if (poolData) {
            try {
                await WJL_DB.setMeta('pools', poolData);
                WJL_State.pools = poolData;
            } catch (err) { /* 同上 */ }
        }
        if (result.ok) {
            WJL_State.settings.packImported = true;
            WJL_State.settings.packVersion = index.version || '';
            await WJL_DB.setMeta('pack', { version: index.version || '', imported_at: new Date().toISOString(), counts: result.counts });
        }
        return result;
    },
};

/* =========================================================================
 * 10. Function Tool
 * ========================================================================= */

const WJL_Tools = {
    defs() {
        const categoryEnum = Object.keys(WJL_CATEGORIES);
        const catDesc = categoryEnum.map(k => `${k}（${WJL_CATEGORIES[k].label}）`).join('、');
        return [
            {
                name: 'xianlu_search',
                displayName: '万界仙录·检索',
                description: '在本地修仙资料库中检索素材。scope=entity（默认）按条件检索四类角色素材；scope=document 检索资料库原文片段，用于查找「器灵怎么诞生」「金丹期有什么特点」这类设定规则；scope=auto 先查实体，实体不足时自动附带原文片段。返回的是资料库中既有内容及出处，不是创作结果。',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['entity', 'document', 'auto'], description: '检索范围，默认 entity' },
                        category: { type: 'string', enum: categoryEnum, description: '实体类别：' + catDesc + '（scope=document 时可省略）' },
                        keyword: { type: 'string', description: '自由文本关键词，例如“冰灵根”“剑修”“佛门”；scope=document 时为必填' },
                        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 高冷、剑修、上古血脉' },
                        realm: { type: 'string', description: '境界，如 金丹、元婴、化神' },
                        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 5' },
                        allow_pending: { type: 'boolean', description: '是否允许返回“待核查”素材，默认 false' },
                        detail_level: { type: 'string', enum: ['compact', 'standard', 'complete'], description: '返回详细程度' },
                    },
                    required: [],
                },
                action: (args) => {
                    return WJL_Controller.search(args).then(out => JSON.stringify(out.payload));
                },
            },
            {
                name: 'xianlu_generate',
                displayName: '万界仙录·抽取',
                description: '从本地修仙资料库中随机抽取角色素材（女修/神佛/器灵/异兽）。适合“随机生成一位元婴期女修”“抽一只可化形的上古异兽”这类需求。返回素材要点，角色描写由你完成。器灵类素材常常只给法宝名与形制（material_note 会注明），其女子形态、样貌、性格由你自行补全。',
                parameters: {
                    type: 'object',
                    properties: {
                        category: { type: 'string', enum: categoryEnum, description: '实体类别：' + catDesc },
                        count: { type: 'integer', minimum: 1, maximum: 10, description: '一次抽取的数量，1–10，默认 1；制卡时按需要填' },
                        filters: {
                            type: 'object',
                            description: '硬性条件（不满足即淘汰）',
                            properties: {
                                realm: { type: 'string', description: '境界' },
                                realm_min: { type: 'string', description: '最低境界' },
                                realm_max: { type: 'string', description: '最高境界' },
                                race: { type: 'string', description: '种族，如 人族、妖族' },
                                bloodline: { type: 'string', description: '血脉，如 上古、凤凰' },
                                grade: { type: 'string', description: '法宝品阶，如 仙器' },
                                artifact_type: { type: 'string', description: '法宝类别，如 剑、镜' },
                                species: { type: 'string', description: '异兽物种' },
                                habitat: { type: 'string', description: '栖息地' },
                                sect: { type: 'string', description: '宗门' },
                                can_transform: { type: 'boolean', description: '是否必须可化形' },
                                tags: { type: 'array', items: { type: 'string' }, description: '偏好标签，参与加权' },
                                keyword: { type: 'string', description: '关键词，参与加权' },
                            },
                        },
                        random_mode: { type: 'string', enum: ['weighted', 'uniform'], description: 'weighted=按标签匹配度加权，uniform=纯随机' },
                        seed: { type: 'integer', description: '随机种子；相同种子+相同数据=相同结果' },
                        exclude_recent: { type: 'boolean', description: '是否排除最近抽取过的素材，默认 true' },
                        detail_level: { type: 'string', enum: ['compact', 'standard', 'complete'], description: '返回详细程度，默认 standard' },
                    },
                    required: ['category'],
                },
                action: (args) => {
                    return WJL_Controller.generate(args).then(out => JSON.stringify(out.payload));
                },
            },
            {
                name: 'xianlu_lookup',
                displayName: '万界仙录·详情',
                description: '按实体 ID 或名称查看完整资料。当用户想深入了解某个已检索到的角色、法宝、器灵或异兽时调用。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '实体 ID，例如 cult_0001' },
                        name: { type: 'string', description: '实体名称（ID 未知时使用）' },
                        detail_level: { type: 'string', enum: ['compact', 'standard', 'complete'], description: '返回详细程度' },
                    },
                },
                action: (args) => JSON.stringify(WJL_Controller.lookup(args).payload),
            },
            {
                name: 'xianlu_related',
                displayName: '万界仙录·关联',
                description: '查询实体的关联对象，例如某器灵所属法宝、某女修的宗门、某异兽的血脉来源、某神佛的道场与法宝。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '基准实体 ID' },
                        name: { type: 'string', description: '基准实体名称' },
                        relation_type: { type: 'string', description: '只返回指定关系类型，如 belongs_to、artifact_of、habitat' },
                    },
                    required: [],
                },
                action: (args) => JSON.stringify(WJL_Controller.related(args).payload),
            },
            {
                name: 'xianlu_save_result',
                displayName: '万界仙录·收藏',
                description: '把用户确认的抽取结果保存到插件的收藏区（不会修改人物卡或原始资料）。',
                parameters: {
                    type: 'object',
                    properties: {
                        entity_id: { type: 'string', description: '被收藏的实体 ID' },
                        name: { type: 'string', description: '本次生成的角色名（原创时可填）' },
                        note: { type: 'string', description: '用户备注' },
                    },
                },
                action: (args) => WJL_Controller.saveResult(args).then(out => JSON.stringify(out.payload)),
            },
        ];
    },

    register() {
        const ctx = getStContext();
        if (!ctx || typeof ctx.registerFunctionTool !== 'function') {
            console.warn('[万界仙录] 当前 SillyTavern 版本不支持 Function Tool，已跳过注册');
            return false;
        }
        if (WJL_State.toolsRegistered) return true;
        for (const def of this.defs()) {
            ctx.registerFunctionTool({
                name: def.name,
                displayName: def.displayName,
                description: def.description,
                parameters: def.parameters,
                action: def.action,
                shouldRegister: () => !!WJL_State.settings.enabled && !!WJL_State.settings.toolsEnabled,
            });
        }
        WJL_State.toolsRegistered = true;
        console.log('[万界仙录] 已注册 5 个 Function Tool');
        return true;
    },

    unregister() {
        const ctx = getStContext();
        if (!ctx || typeof ctx.unregisterFunctionTool !== 'function' || !WJL_State.toolsRegistered) return;
        for (const def of this.defs()) ctx.unregisterFunctionTool(def.name);
        WJL_State.toolsRegistered = false;
    },
};

function getStContext() {
    if (WJL_State && WJL_State.ctx) return WJL_State.ctx;
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch (e) { /* ignore */ }
    return null;
}

/* =========================================================================
 * 11. Slash Command
 * ========================================================================= */

const WJL_Commands = {
    register() {
        const ctx = getStContext();
        if (!ctx || !ctx.SlashCommandParser || !ctx.SlashCommand) {
            console.warn('[万界仙录] 当前 SillyTavern 版本未暴露 SlashCommand API，跳过命令注册');
            return false;
        }
        const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = ctx;

        const run = async (named, unnamed) => {
            const args = named || {};
            const action = String(args.action || '').trim() || String(args.mode || '').trim();
            const free = Array.isArray(unnamed) ? unnamed.filter(x => x !== undefined && x !== null && x !== '').join(' ') : String(unnamed || '');
            const category = String(args.category || '').trim();
            const keyword = String(args.keyword || '').trim() || (action !== 'lookup' && action !== 'related' ? free : '');
            const detail = String(args.detail || args.detail_level || WJL_State.settings.detailLevel || 'standard');

            try {
                if (action === 'search') {
                    const out = await WJL_Controller.search({
                        category, keyword,
                        scope: String(args.scope || 'entity'),
                        tags: WJL_Util.toArray(args.tags),
                        realm: String(args.realm || ''),
                        limit: Number(args.limit || 5) || 5,
                        detail_level: detail,
                    });
                    if (out.payload.documents && out.payload.documents.length) {
                        return WJL_Format.text(out.payload.results, detail) + '\n\n〇 资料库原文片段\n' +
                            out.payload.documents.map(d => `· ${d.title}（${d.source_path}）\n  ${d.snippet}`).join('\n');
                    }
                    return WJL_Format.text(out.payload.results, detail);
                }
                if (action === 'generate') {
                    const out = await WJL_Controller.generate({
                        category, keyword,
                        tags: WJL_Util.toArray(args.tags),
                        realm: String(args.realm || ''),
                        bloodline: String(args.bloodline || ''),
                        grade: String(args.grade || ''),
                        count: Number(args.count || 1) || 1,
                        seed: args.seed === undefined || args.seed === '' ? null : args.seed,
                        detail_level: detail,
                    });
                    if (!out.ok) return '万界仙录：' + out.error;
                    const meta = out.payload.meta || {};
                    return `万界仙录·抽取（seed=${meta.seed}）\n` + WJL_Format.text(out.payload.results, detail);
                }
                if (action === 'lookup') {
                    const out = WJL_Controller.lookup({ id: String(args.id || ''), name: keyword, detail_level: detail });
                    if (!out.ok) return '万界仙录：未找到对应实体';
                    return WJL_Format.text(out.payload.results, detail);
                }
                if (action === 'related') {
                    const out = WJL_Controller.related({ id: String(args.id || ''), name: keyword, relation_type: String(args.relation || '') });
                    if (!out.ok) return '万界仙录：未找到基准实体';
                    const notes = (out.payload.meta && out.payload.meta.notes) || [];
                    return (notes.length ? notes.join('\n') : '（无关联记录）');
                }
                if (action === 'save') {
                    const out = await WJL_Controller.saveResult({ entity_id: String(args.id || ''), name: keyword, note: String(args.note || '') });
                    return out.ok ? '万界仙录：已收藏 ' + out.payload.results[0].name : '万界仙录：收藏失败';
                }
                if (action === 'selftest') {
                    const r = await WJL_SelfTest.run();
                    return r.text;
                }
                if (action === 'stats') {
                    const s = await WJL_Controller.stats();
                    const byType = Object.entries(s.byType).map(([k, v]) => `${WJL_CATEGORIES[k] ? WJL_CATEGORIES[k].label : k} ${v}`).join(' / ');
                    return `万界仙录资料库：文档 ${s.documents} 篇 · 实体 ${s.entities} 条（${byType}） · 关联 ${s.relations} 条 · 收藏 ${s.favorites || 0}`;
                }
                return '用法：/xianlu action=search|generate|lookup|related|save|stats|selftest [category=…] [keyword=…] [realm=…] [count=…] [id=…]';
            } catch (e) {
                console.error('[万界仙录] 命令执行失败', e);
                return '万界仙录出错：' + e.message;
            }
        };

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'xianlu',
            aliases: ['万界仙录', 'wjl'],
            helpString: '万界仙录：检索或随机抽取本地修仙资料库素材。示例：<code>/xianlu action=generate category=female_cultivator realm=元婴期 count=1</code>',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({ name: 'action', description: 'search / generate / lookup / related / save / stats / selftest', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'category', description: 'female_cultivator / female_deity / female_artifact_spirit / female_beast', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'keyword', description: '检索关键词', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'tags', description: '标签，多个用逗号分隔', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'realm', description: '境界筛选', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'bloodline', description: '血脉筛选', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'grade', description: '法宝品阶筛选', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'count', description: '抽取数量', typeList: [ARGUMENT_TYPE.NUMBER] }),
                SlashCommandNamedArgument.fromProps({ name: 'limit', description: '检索条数', typeList: [ARGUMENT_TYPE.NUMBER] }),
                SlashCommandNamedArgument.fromProps({ name: 'id', description: '实体 ID', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'seed', description: '随机种子', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'detail', description: 'compact / standard / complete', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'note', description: '收藏备注', typeList: [ARGUMENT_TYPE.STRING] }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: '未使用命名参数时的关键词/名称', typeList: [ARGUMENT_TYPE.STRING], acceptsMultiple: true, isRequired: false }),
            ],
            callback: run,
        }));
        return true;
    },
};

/* =========================================================================
 * 11.5 自检（浏览器内一键验收）
 * ========================================================================= */

const WJL_SelfTest = {
    async run() {
        const lines = [];
        const fails = [];
        const ok = (cond, name, detail) => {
            lines.push((cond ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
            if (!cond) fails.push(name);
            return cond;
        };

        const ctx = getStContext();
        ok(!!ctx, 'SillyTavern 上下文', ctx ? '已连接' : 'getContext 不可用（扩展可能未在 ST 中运行）');

        let stats = null;
        try {
            stats = await WJL_Controller.stats();
        } catch (e) {
            ok(false, '资料库读取', String((e && e.message) || e));
        }
        if (stats) {
            ok(stats.entities > 0, '角色素材', stats.entities + ' 条');
            ok(stats.documents > 0, '原文文档', stats.documents + ' 篇');
            const byType = Object.entries(stats.byType || {}).filter(x => x[1] > 0)
                .map(x => `${(WJL_CATEGORIES[x[0]] && WJL_CATEGORIES[x[0]].label) || x[0]} ${x[1]}`).join(' / ');
            if (byType) lines.push('　分类：' + byType);
            try {
                const pack = await WJL_DB.getMeta('pack');
                if (pack && pack.counts) {
                    const same = pack.counts.entities === stats.entities && pack.counts.documents === stats.documents;
                    ok(same, '与资料包索引一致', same ? ('版本 ' + (pack.version || '-')) : `期望 文档 ${pack.counts.documents} / 实体 ${pack.counts.entities}`);
                }
            } catch (e) { /* 缺 meta 不算失败 */ }
        }

        try {
            const s = await WJL_Controller.search({ category: 'female_cultivator', limit: 3, detail_level: 'compact' });
            ok(s.payload.results.length > 0, '素材检索', s.payload.results.length + ' 条');
        } catch (e) { ok(false, '素材检索', String((e && e.message) || e)); }

        try {
            const d = await WJL_Controller.searchDocuments({ keyword: '器灵', limit: 3 });
            const hits = ((d.payload && d.payload.results) || []).length;
            ok(hits > 0, '原文检索', '关键词「器灵」命中 ' + hits + ' 篇');
        } catch (e) { ok(false, '原文检索', String((e && e.message) || e)); }

        try {
            const a = await WJL_Controller.generate({ category: 'female_cultivator', count: 1, seed: 20261121 });
            const b = await WJL_Controller.generate({ category: 'female_cultivator', count: 1, seed: 20261121, exclude_recent: false });
            const ida = a.payload.results.map(r => r.id).join(',');
            const idb = b.payload.results.map(r => r.id).join(',');
            ok(!!ida && ida === idb, '抽取可复现', ida === idb ? ida : (ida + ' ≠ ' + idb));
        } catch (e) { ok(false, '抽取可复现', String((e && e.message) || e)); }

        const toolNames = ['xianlu_search', 'xianlu_generate', 'xianlu_lookup', 'xianlu_related', 'xianlu_save_result'];
        ok(!!WJL_State.toolsRegistered, 'Function Tool 已注册', WJL_State.toolsRegistered ? (toolNames.length + ' 个：' + toolNames.join(' / ')) : '未注册，检查「允许 AI 调用」开关');
        if (ctx && typeof ctx.isToolCallingSupported === 'function') {
            try { ok(!!ctx.isToolCallingSupported(), '当前模型支持工具调用', ''); } catch (e) { /* 忽略 */ }
        }

        if (ctx && ctx.SlashCommandParser && ctx.SlashCommandParser.commands) {
            const cmds = ctx.SlashCommandParser.commands;
            const has = typeof cmds.has === 'function' && cmds.has('xianlu');
            ok(has, '斜杠命令 /xianlu', has ? '/万界仙录、/wjl 别名可用' : '未找到命令');
        }

        const doc = (typeof document !== 'undefined' && document) ? document : null;
        if (doc && typeof doc.getElementById === 'function') {
            const panel = doc.getElementById('wjl-panel');
            const tabs = panel && typeof panel.querySelectorAll === 'function' ? panel.querySelectorAll('[data-wjl-tab]').length : 0;
            ok(!!panel && tabs >= 7, '面板渲染', panel ? (tabs + ' 个页签') : '未挂载');
        } else {
            lines.push('· 面板渲染 — 跳过（无 DOM 环境）');
        }

        const text = '万界仙录自检（' + new Date().toLocaleString() + '）\n' + lines.join('\n') + '\n\n' +
            (fails.length ? ('✗ ' + fails.length + ' 项未通过：' + fails.join('、')) : '✓ 全部通过，可以开始使用');
        return { ok: fails.length === 0, lines: lines, fails: fails, text: text };
    },
};

/* =========================================================================
 * 12. 设置
 * ========================================================================= */

const WJL_Settings = {
    key: WJL_EXT_NAME,

    load(ctx) {
        const root = ctx && ctx.extensionSettings ? ctx.extensionSettings : (typeof extension_settings !== 'undefined' ? extension_settings : null);
        if (!root) return { ...WJL_DEFAULT_SETTINGS };
        const saved = root[WJL_EXT_NAME] || {};
        WJL_State.settings = { ...WJL_DEFAULT_SETTINGS, ...saved };
        return WJL_State.settings;
    },

    save(ctx) {
        const root = ctx && ctx.extensionSettings ? ctx.extensionSettings : (typeof extension_settings !== 'undefined' ? extension_settings : null);
        if (!root) return;
        root[WJL_EXT_NAME] = { ...WJL_State.settings };
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    },

    async apply(ctx) {
        const s = WJL_State.settings;
        WJL_Tools.unregister();
        if (s.enabled && s.toolsEnabled) WJL_Tools.register();
        this.applyPromptHint(ctx);
        this.save(ctx);
    },

    applyPromptHint(ctx) {
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
        const key = 'WJL_HINT';
        try {
            if (WJL_State.settings.enabled && WJL_State.settings.promptHintEnabled) {
                ctx.setExtensionPrompt(key, '当用户要求从修仙资料库检索、随机抽取或查询角色素材时，调用万界仙录的 xianlu_* 工具；普通剧情描写不要调用。', 1, 0);
            } else {
                ctx.setExtensionPrompt(key, '');
            }
        } catch (e) {
            console.warn('[万界仙录] 注入提示失败', e);
        }
    },
};

/* =========================================================================
 * 13. UI
 * ========================================================================= */

const WJL_Ui = {
    baseUrl() {
        if (typeof document === 'undefined') return '/' + 'scripts/extensions/third-party/' + WJL_EXT_NAME + '/';
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const hit = scripts.find(s => new RegExp(WJL_EXT_NAME + '/index\\.js').test(s.getAttribute('src') || ''));
        if (hit) return new URL('.', hit.src).href;
        return '/scripts/extensions/third-party/' + WJL_EXT_NAME + '/';
    },

    esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    tab: 'home',

    async mount(ctx) {
        if (WJL_State.uiReady) return;
        const host = document.getElementById('extensions_settings');
        if (!host) {
            console.warn('[万界仙录] 未找到扩展设置容器');
            return;
        }
        let html = '';
        try {
            if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
                html = await ctx.renderExtensionTemplateAsync(WJL_EXT_NAME, 'ui/panel');
            }
        } catch (e) {
            console.warn('[万界仙录] 模板加载失败，使用内置结构', e);
        }
        if (!html) html = '<div id="wjl-panel" class="wjl-panel"><div class="wjl-head">万界仙录</div><div class="wjl-body">模板缺失，请检查扩展文件。</div></div>';
        const wrap = document.createElement('div');
        wrap.className = 'inline-drawer';
        wrap.innerHTML = `<div class="inline-drawer-toggle inline-drawer-header"><b>万界仙录</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">${html}</div>`;
        host.appendChild(wrap);
        WJL_State.uiReady = true;
        this.bind(ctx);
        await this.refreshHome();
    },

    $(sel) {
        return document.querySelector(sel);
    },

    bind(ctx) {
        const root = this.$('#wjl-panel');
        if (!root) return;
        root.addEventListener('click', async (ev) => {
            const tabBtn = ev.target.closest('[data-wjl-tab]');
            if (tabBtn) {
                this.switchTab(tabBtn.getAttribute('data-wjl-tab'));
                return;
            }
            const actBtn = ev.target.closest('[data-wjl-act]');
            if (!actBtn) return;
            const act = actBtn.getAttribute('data-wjl-act');
            try {
                await this.handleAction(act, actBtn, ctx);
            } catch (e) {
                console.error('[万界仙录]', e);
                this.toast('操作失败：' + e.message, 'error');
            }
        });
        root.addEventListener('change', async (ev) => {
            const el = ev.target.closest('[data-wjl-setting]');
            if (el) {
                const key = el.getAttribute('data-wjl-setting');
                WJL_State.settings[key] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
                await WJL_Settings.apply(ctx);
                this.toast('设置已保存');
                return;
            }
            const browseSel = ev.target.closest('#wjl-browse-cat');
            if (browseSel) this.renderBrowse();
        });

        const fileInput = document.getElementById('wjl-file-input');
        if (fileInput) {
            fileInput.addEventListener('change', async () => {
                const files = Array.from(fileInput.files || []);
                if (!files.length) return;
                const progress = document.getElementById('wjl-import-progress');
                try {
                    const texts = [];
                    for (const f of files) texts.push({ label: f.name, text: await f.text() });
                    if (progress) progress.textContent = '正在解析…';
                    const res = await WJL_Import.importTexts(texts, {
                        onProgress: (stage, done, total) => {
                            if (progress) progress.textContent = `${stage} ${done}/${total}`;
                        },
                    });
                    if (!res.ok) {
                        if (progress) progress.textContent = '导入失败：' + res.error;
                        this.toast('导入失败：' + res.error, 'error');
                    } else {
                        if (progress) progress.textContent = `导入完成：文档 ${res.counts.documents} · 实体 ${res.counts.entities} · 关联 ${res.counts.relations}`;
                        this.toast('导入完成');
                        await this.refreshHome();
                    }
                } catch (e) {
                    if (progress) progress.textContent = '导入失败：' + e.message;
                    this.toast('导入失败：' + e.message, 'error');
                }
            });
        }
        this.syncSettingsUi();
    },

    syncSettingsUi() {
        document.querySelectorAll('[data-wjl-setting]').forEach(el => {
            const key = el.getAttribute('data-wjl-setting');
            const v = WJL_State.settings[key];
            if (el.type === 'checkbox') el.checked = !!v;
            else if (v !== undefined && v !== null) el.value = v;
        });
    },

    switchTab(tab) {
        this.tab = tab;
        document.querySelectorAll('[data-wjl-tab]').forEach(el => {
            el.classList.toggle('active', el.getAttribute('data-wjl-tab') === tab);
        });
        document.querySelectorAll('[data-wjl-pane]').forEach(el => {
            el.classList.toggle('hidden', el.getAttribute('data-wjl-pane') !== tab);
        });
        if (tab === 'browse') this.renderBrowse();
        if (tab === 'history') this.renderHistory();
        if (tab === 'home') this.refreshHome();
    },

    toast(msg, kind) {
        if (typeof toastr !== 'undefined') {
            const fn = kind === 'error' ? 'error' : 'success';
            toastr[fn](msg);
        } else {
            console.log('[万界仙录]', msg);
        }
    },

    async refreshHome() {
        const s = await WJL_Controller.stats();
        const el = (id) => document.getElementById(id);
        if (el('wjl-stat-docs')) el('wjl-stat-docs').textContent = s.documents;
        if (el('wjl-stat-entities')) el('wjl-stat-entities').textContent = s.entities;
        if (el('wjl-stat-relations')) el('wjl-stat-relations').textContent = s.relations;
        if (el('wjl-stat-fav')) el('wjl-stat-fav').textContent = s.favorites || 0;
        const grid = el('wjl-cat-grid');
        if (grid) {
            grid.innerHTML = Object.entries(WJL_CATEGORIES).map(([k, def]) => {
                const n = s.byType[k] || 0;
                return `<button class="wjl-cat" data-wjl-act="quick-generate" data-category="${k}">
                    <span class="wjl-cat-name">${this.esc(def.label)}</span>
                    <span class="wjl-cat-count">${n} 条</span>
                </button>`;
            }).join('');
        }
        this.renderHistory();
    },

    renderHistory() {
        const box = document.getElementById('wjl-history-list');
        if (!box) return;
        const rows = WJL_State.history.slice(-30).reverse();
        if (!rows.length) {
            box.innerHTML = '<div class="wjl-muted">暂无抽取记录</div>';
            return;
        }
        box.innerHTML = rows.map(h => {
            const names = (h.ids || []).map(id => {
                const e = WJL_State.entityMap.get(id);
                return e ? e.name : id;
            }).join('、');
            const t = new Date(h.ts).toLocaleString();
            return `<div class="wjl-hist-row"><span class="wjl-muted">${this.esc(t)}</span> ${this.esc(names)}
                <span class="wjl-muted">seed=${this.esc(h.seed)}</span></div>`;
        }).join('');
    },

    async renderBrowse() {
        const box = document.getElementById('wjl-browse-list');
        if (!box) return;
        const cat = document.getElementById('wjl-browse-cat')?.value || '';
        const kw = String(document.getElementById('wjl-browse-kw')?.value || '').trim();
        const view = await WJL_Controller.search({ category: cat, keyword: kw, limit: 20, detail_level: 'compact', allow_pending: true });
        const results = view.payload.results;
        if (!results.length) {
            box.innerHTML = '<div class="wjl-muted">没有匹配的条目</div>';
            return;
        }
        box.innerHTML = results.map(r => `
            <div class="wjl-item">
                <div class="wjl-item-head">
                    <b>${this.esc(r.name)}</b>
                    <span class="wjl-tag">${this.esc(r.category_label)}</span>
                    <span class="wjl-tag ${r.quality === 'verified' ? 'ok' : ''}">${this.esc(r.quality_label)}</span>
                </div>
                <div class="wjl-item-sum">${this.esc(r.summary || '')}</div>
                <div class="wjl-item-facts">${Object.entries(r.facts || {}).slice(0, 4).map(([k, v]) => `<span><i>${this.esc(k)}</i>：${this.esc(v)}</span>`).join('')}</div>
                <div class="wjl-item-actions">
                    <button data-wjl-act="detail" data-id="${this.esc(r.id)}">详情</button>
                    <button data-wjl-act="related" data-id="${this.esc(r.id)}">关联</button>
                    <button data-wjl-act="fav" data-id="${this.esc(r.id)}">收藏</button>
                </div>
            </div>`).join('');
    },

    renderDocHits(docs) {
        if (!docs || !docs.length) return '';
        return '<div class="wjl-section-title">资料库原文片段</div>' + docs.map(d => `
            <div class="wjl-item">
                <div class="wjl-item-head"><b>${this.esc(d.title)}</b><span class="wjl-tag">${this.esc(d.category)}</span></div>
                <div class="wjl-muted">${this.esc(d.source_path)}</div>
                <div class="wjl-content">${this.esc(d.snippet)}</div>
            </div>`).join('');
    },

    async handleAction(act, btn, ctx) {
        const id = btn.getAttribute('data-id');
        if (act === 'quick-generate') {
            const category = btn.getAttribute('data-category');
            const out = await WJL_Controller.generate({ category, count: 1, detail_level: 'standard' });
            const box = document.getElementById('wjl-quick-result');
            if (box) box.innerHTML = this.renderResults(out.payload);
            await this.refreshHome();
            return;
        }
        if (act === 'detail') {
            const out = WJL_Controller.lookup({ id, detail_level: 'complete' });
            document.getElementById('wjl-detail-box').innerHTML = this.renderResults(out.payload);
            this.switchTab('detail');
            return;
        }
        if (act === 'related') {
            const out = WJL_Controller.related({ id });
            document.getElementById('wjl-detail-box').innerHTML = this.renderResults(out.payload);
            this.switchTab('detail');
            return;
        }
        if (act === 'fav') {
            const out = await WJL_Controller.saveResult({ entity_id: id });
            this.toast(out.ok ? '已收藏' : '收藏失败', out.ok ? 'success' : 'error');
            return;
        }
        if (act === 'browse-refresh') {
            this.renderBrowse();
            return;
        }
        if (act === 'run-search') {
            const category = document.getElementById('wjl-search-cat').value;
            const keyword = document.getElementById('wjl-search-kw').value;
            const tags = WJL_Util.toArray(document.getElementById('wjl-search-tags').value);
            const realm = document.getElementById('wjl-search-realm').value;
            const scopeEl = document.getElementById('wjl-search-scope');
            const scope = scopeEl ? scopeEl.value : 'entity';
            const out = await WJL_Controller.search({ category, keyword, tags, realm, scope, limit: 10, detail_level: 'standard' });
            document.getElementById('wjl-search-result').innerHTML = this.renderResults(out.payload) +
                this.renderDocHits(out.payload.documents);
            return;
        }
        if (act === 'run-generate') {
            const category = document.getElementById('wjl-gen-cat').value;
            const count = Number(document.getElementById('wjl-gen-count').value || 1);
            const realm = document.getElementById('wjl-gen-realm').value;
            const bloodline = document.getElementById('wjl-gen-blood').value;
            const canTransform = document.getElementById('wjl-gen-transform').checked;
            const seedRaw = document.getElementById('wjl-gen-seed').value;
            const out = await WJL_Controller.generate({
                category, count, realm, bloodline,
                can_transform: canTransform,
                seed: seedRaw === '' ? null : seedRaw,
                detail_level: 'standard',
            });
            document.getElementById('wjl-gen-result').innerHTML = this.renderResults(out.payload);
            await this.refreshHome();
            return;
        }
        if (act === 'selftest') {
            const box = document.getElementById('wjl-selftest-out');
            if (box) box.textContent = '自检中…';
            this.toast('开始自检…');
            const r = await WJL_SelfTest.run();
            if (box) box.textContent = r.text;
            this.toast(r.ok ? '自检通过' : ('自检未通过：' + r.fails.join('、')), r.ok ? 'success' : 'error');
            return;
        }
        if (act === 'import-builtin') {
            this.toast('开始导入内置资料包…');
            const res = await WJL_Import.importBuiltinPack(this.baseUrl(), (stage, done, total) => {
                const el = document.getElementById('wjl-import-progress');
                if (el) el.textContent = `${stage} ${done}/${total}`;
            });
            await this.refreshHome();
            this.toast(res.ok ? `导入完成：文档 ${res.counts.documents} · 实体 ${res.counts.entities} · 关联 ${res.counts.relations}` : ('导入失败：' + res.error), res.ok ? 'success' : 'error');
            return;
        }
        if (act === 'import-file') {
            const input = document.getElementById('wjl-file-input');
            input.value = '';
            input.click();
            return;
        }
        if (act === 'export') {
            const data = await WJL_Import.exportAll();
            const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `wanjie-xianlu-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            return;
        }
        if (act === 'clear') {
            if (!confirm('确定清空本地资料库？此操作不可撤销，建议先导出备份。')) return;
            await WJL_DB.clearAll();
            await WJL_Controller.reload();
            await this.refreshHome();
            this.toast('资料库已清空');
            return;
        }
    },

    renderResults(payload) {
        if (!payload) return '';
        if (!payload.success) {
            return `<div class="wjl-muted">${this.esc((payload.warnings || ['无结果'])[0])}</div>`;
        }
        const meta = payload.meta || {};
        const allWarn = (payload.warnings || []).concat(meta.warnings || []);
        const warn = allWarn.length ? `<div class="wjl-warn">${allWarn.map(w => this.esc(w)).join('<br>')}</div>` : '';
        return warn + payload.results.map(r => `
            <div class="wjl-item">
                <div class="wjl-item-head"><b>${this.esc(r.name)}</b>
                    <span class="wjl-tag">${this.esc(r.category_label)}</span>
                    <span class="wjl-tag ${r.quality === 'verified' ? 'ok' : ''}">${this.esc(r.quality_label)}</span>
                    <span class="wjl-muted">${this.esc(r.id)}</span>
                </div>
                <div class="wjl-item-sum">${this.esc(r.summary || '')}</div>
                <table class="wjl-facts">${Object.entries(r.facts || {}).map(([k, v]) => `<tr><th>${this.esc(k)}</th><td>${this.esc(v)}</td></tr>`).join('')}</table>
                ${r.content ? `<div class="wjl-content">${this.esc(r.content)}</div>` : ''}
                <div class="wjl-muted">出处：${this.esc((r.source_ids || []).join(', '))}</div>
            </div>`).join('');
    },
};

/* =========================================================================
 * 14. 初始化
 * ========================================================================= */

async function wjlInit() {
    const ctx = getStContext();
    if (!ctx) {
        console.warn('[万界仙录] 未检测到 SillyTavern 上下文，插件未初始化');
        return;
    }
    WJL_State.ctx = ctx;
    WJL_Settings.load(ctx);
    try {
        await WJL_DB.open();
        await WJL_Controller.reload();
    } catch (e) {
        console.error('[万界仙录] 资料库初始化失败', e);
    }
    WJL_Tools.register();
    WJL_Settings.apply(ctx);
    WJL_Commands.register();
    try {
        await WJL_Ui.mount(ctx);
    } catch (e) {
        console.error('[万界仙录] 界面初始化失败', e);
    }
    console.log('[万界仙录] 初始化完成', WJL_State.lastStats);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { wjlInit(); });
    } else {
        setTimeout(() => { wjlInit(); }, 0);
    }
}
