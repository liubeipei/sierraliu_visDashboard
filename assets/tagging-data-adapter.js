/**
 * tagging-data-adapter v0.1.0
 * 把 4 套打标 xlsx 标准化成统一 RowSchema
 * 暴露：window.TaggingDataAdapter.parse(input, opts) → {meta, rows, stats, warnings}
 *
 * input: SheetJS workbook | rows[] (sheet_to_json 结果) | {sheets:{name:rows[]}}
 * opts: { dataType:'t2i'|'i2i', imageMode:'single'|'multi', turnMode:'single'|'multi' }
 */
(function () {
  'use strict';

  // ---------- utils ----------
  function stripJsonFence(s) {
    if (typeof s !== 'string') return s;
    return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  function safeParseJSON(s) {
    if (s == null) return null;
    if (typeof s === 'object') return s;
    if (typeof s !== 'string') return null;
    const t = stripJsonFence(s);
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  function pickFirst(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return null;
  }
  function asStr(v) { return v == null ? '' : String(v); }
  function asNum(v, dft) {
    if (v == null || v === '') return dft;
    const n = Number(v);
    return Number.isFinite(n) ? n : dft;
  }
  function asArr(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === '') return [];
    if (typeof v === 'string') {
      const p = safeParseJSON(v);
      if (Array.isArray(p)) return p;
      // fallback: split by comma/semicolon
      return v.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    }
    return [v];
  }
  function splitDash(s, depth) {
    const parts = (s ? String(s) : '').split('-');
    const out = [];
    for (let i = 0; i < depth; i++) out.push(parts[i] || '');
    return out;
  }
  function normalizeRows(input) {
    // input may be: array of objects | XLSX workbook | {sheets:{name:rows}} | {SheetNames,Sheets}
    if (Array.isArray(input)) return input;
    if (input && input.SheetNames && input.Sheets && typeof XLSX !== 'undefined') {
      const sheetName = input.SheetNames[0];
      return XLSX.utils.sheet_to_json(input.Sheets[sheetName], { defval: '' });
    }
    if (input && input.sheets) {
      const firstKey = Object.keys(input.sheets)[0];
      return input.sheets[firstKey];
    }
    return [];
  }

  // ---------- adapters per schema ----------

  function adaptI2iRow(r, opts) {
    const prompt = pickFirst(r, ['modelprompt', 'prompt', 'user_prompt']) || '';
    const inputUrls = asArr(r.image_urls_external || r.image_urls_input || r.image_url_1 || '');
    const outputUrls = asArr(r.image_urls || r.output_image_urls || '');
    const abilityFull = asStr(pickFirst(r, ['ability_tags', 'ability_full']) || '');
    const [aL1, aL2, aL3, aL4] = splitDash(abilityFull, 4);
    const sceneStr = asStr(pickFirst(r, ['scene_tags_str', 'scene_primary']) || '');
    const [sL1, sL2] = splitDash(sceneStr, 2);
    const outputForm = asStr(r.output_form_tag || '');
    const isMultiOut = /多图|组合/.test(outputForm);
    const confidence = asStr(r.confidence || 'high').toLowerCase();
    const isTaggable = asNum(r.is_taggable_int, 1);
    const searchNeed = asStr(r.search_need_label || '');

    const outputFormJson = safeParseJSON(r.output_form_json);
    const imageInputRole = outputFormJson?.image_input_role || null;

    const flags = [];
    if (confidence === 'low') flags.push('low_confidence');
    if (isTaggable === 0) flags.push('not_taggable');

    return {
      id: asStr(r['数据ID'] || r.id || r.traceid || ''),
      session_id: asStr(r.cid || r.session_id || r.traceid || ''),
      data_type: 'i2i',
      image_mode: opts.imageMode,
      turn_mode: opts.turnMode,

      prompt,
      prompt_history: [{ prompt, files: inputUrls.map(u => ({ url: u })) }],
      turn_count: 1,
      convidx: asNum(r.convidx, 0),

      input_image_urls: inputUrls,
      output_image_urls: outputUrls,
      image_count_in: asNum(r.image_count || r.attachment_cnt, inputUrls.length),
      image_count_out: outputUrls.length,

      ability_l1: aL1, ability_l2: aL2, ability_l3: aL3, ability_l4: aL4,
      ability_full: abilityFull,
      ability_tags_all: abilityFull ? [abilityFull] : [],

      scene_target: sceneStr,
      scene_target_l1: sL1, scene_target_l2: sL2,
      scene_session: sceneStr,

      output_form: outputForm,
      is_multi_image_output: isMultiOut,
      image_input_role: imageInputRole,

      intent_clarity: '',
      expression_type: '',
      search_need: searchNeed,

      confidence,
      is_taggable: isTaggable,
      reject_reason: asStr(r.reject_reason || ''),

      is_dissatisfied: false,
      dissatisfaction_emotion: '',
      dissatisfaction_severity: '',
      retry_count: 0,
      retry_type: '',

      is_sensitive: false,
      sensitive_categories: [],

      reasoning: asStr(r.reasoning || ''),
      raw_extras: {
        traceid: r.traceid,
        ability_json: safeParseJSON(r.ability_json),
        scene_json: safeParseJSON(r.scene_json),
        output_form_json: outputFormJson,
        search_json: safeParseJSON(r.search_json),
        image_descriptions: r.image_descriptions,
      },

      badcase_flags: flags,
      is_badcase: flags.length > 0,
    };
  }

  function adaptT2iMultiTurnRow(r, opts) {
    const prompt = asStr(r.prompt || r.合并后prompt || '');
    const promptHistory = safeParseJSON(r.prompt_history) || [];
    const convidx = asNum(r.convidx, 0);
    const queryindex = asNum(r.queryindex, 0);
    const turnCount = Math.max(promptHistory.length, queryindex + 1, 1);

    const outputUrls = asArr(r['图片URL'] || r.图片URL || '');
    const sceneTarget = asStr(r['场景标签'] || r.场景标签 || '');
    const [sL1, sL2] = splitDash(sceneTarget, 2);
    const sceneSession = asStr(r['融合单轮的场景标签'] || '');

    // 能力考点打标结果 是 ```json {ability_tags:[...]} ```
    const abilityTagging = safeParseJSON(r['能力考点打标结果']) || {};
    const abilityTagsAll = asArr(abilityTagging.ability_tags || r['能力考点'] || '');
    const abilityFull = abilityTagsAll[0] || '';
    const [aL1, aL2, aL3, aL4] = splitDash(abilityFull, 4);

    const isMultiOut = String(r['是否生成多图'] || '').toLowerCase() === 'true' || r['是否生成多图'] === true;
    const outputForm = isMultiOut ? '多图输出' : '单图输出';

    const sensitive = safeParseJSON(r['敏感类标签']) || {};
    const intentClarity = (sensitive.intent_clarity)
      || (asStr(r['是否意图清晰']) === '清晰' ? 'clear' : asStr(r['是否意图清晰']) === '模糊' ? 'ambiguous' : '');
    const expressionType = sensitive.expression_type || asStr(r['生图表达特征']);

    const searchDep = safeParseJSON(r['搜索依赖度结果']) || {};
    const searchNeed = searchDep.search_dependency || '';

    const isDissat = asStr(r['是否不满']) === '是';
    const retryCount = asNum(r['重试次数'], 0);
    const dissatEmotion = asStr(r['反馈情绪']);

    const isSensitive = asStr(r['请求是否敏感']) === '是';

    const flags = [];
    if (isDissat) flags.push('dissatisfied');
    if (retryCount >= 3) flags.push('retry_high');
    if (isSensitive) flags.push('sensitive');
    if (intentClarity === 'ambiguous') flags.push('intent_ambiguous');

    return {
      id: asStr(r['数据ID'] || ''),
      session_id: asStr(r.cid || r.traceid || ''),
      data_type: 't2i',
      image_mode: opts.imageMode,
      turn_mode: opts.turnMode,

      prompt,
      prompt_history: promptHistory,
      turn_count: turnCount,
      convidx,

      input_image_urls: [],
      output_image_urls: outputUrls,
      image_count_in: 0,
      image_count_out: outputUrls.length,

      ability_l1: aL1, ability_l2: aL2, ability_l3: aL3, ability_l4: aL4,
      ability_full: abilityFull,
      ability_tags_all: abilityTagsAll,

      scene_target: sceneTarget,
      scene_target_l1: sL1, scene_target_l2: sL2,
      scene_session: sceneSession,

      output_form: outputForm,
      is_multi_image_output: isMultiOut,
      image_input_role: null,

      intent_clarity: intentClarity,
      expression_type: expressionType,
      search_need: searchNeed,

      confidence: 'high', // t2i 多轮 schema 缺独立 confidence
      is_taggable: 1,
      reject_reason: '',

      is_dissatisfied: isDissat,
      dissatisfaction_emotion: dissatEmotion,
      dissatisfaction_severity: asStr(r['不满程度']),
      retry_count: retryCount,
      retry_type: asStr(r['重试类型']),

      is_sensitive: isSensitive,
      sensitive_categories: asArr(sensitive.sensitive_categories || []),

      reasoning: asStr(r['能力考点原因'] || sensitive.reason || ''),
      raw_extras: {
        traceid: r.traceid,
        merged_result: safeParseJSON(r['多轮融合单条结果']),
        ability_tagging_raw: abilityTagging,
        search_dep_raw: searchDep,
        round_detail: asStr(r['轮次明细']),
        session_traits: safeParseJSON(r['sesion特性']),
        category_scoring: safeParseJSON(r['分类']),
        scoring_result: safeParseJSON(r['打分结果']),
        scene_scoring: safeParseJSON(r['场景打标']),
        multi_image_basis: asStr(r['生成多图依据']),
        multi_image_ability_tags: asArr(r['多图能力标签']),
        multi_image_scene: asStr(r['多图生成应用场景']),
      },

      badcase_flags: flags,
      is_badcase: isDissat || retryCount >= 3,
    };
  }

  // ---------- stats compute ----------
  function tally(rows, key) {
    const m = new Map();
    for (const r of rows) {
      const v = r[key];
      const list = Array.isArray(v) ? v : (v != null && v !== '' ? [v] : []);
      for (const x of list) {
        const k = String(x);
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }
  function computeStats(rows) {
    const total = rows.length;
    const badcase = rows.filter(r => r.is_badcase).length;
    const dissat = rows.filter(r => r.is_dissatisfied).length;
    const retryHigh = rows.filter(r => (r.retry_count || 0) >= 3).length;
    const lowConf = rows.filter(r => r.confidence === 'low').length;
    const notTaggable = rows.filter(r => r.is_taggable === 0).length;
    const intentAmbiguous = rows.filter(r => r.intent_clarity === 'ambiguous').length;
    const multiImg = rows.filter(r => r.is_multi_image_output).length;
    const avgTurn = rows.reduce((a, r) => a + (r.turn_count || 1), 0) / Math.max(1, total);

    return {
      total,
      badcase, badcase_rate: total ? badcase / total : 0,
      dissat, dissat_rate: total ? dissat / total : 0,
      retry_high: retryHigh, retry_high_rate: total ? retryHigh / total : 0,
      low_conf: lowConf, low_conf_rate: total ? lowConf / total : 0,
      not_taggable: notTaggable, not_taggable_rate: total ? notTaggable / total : 0,
      intent_ambiguous: intentAmbiguous, intent_ambiguous_rate: total ? intentAmbiguous / total : 0,
      multi_image_output: multiImg, multi_image_rate: total ? multiImg / total : 0,
      avg_turn: avgTurn,

      ability_l1: tally(rows, 'ability_l1'),
      ability_full: tally(rows, 'ability_full'),
      scene_target_l1: tally(rows, 'scene_target_l1'),
      scene_target: tally(rows, 'scene_target'),
      output_form: tally(rows, 'output_form'),
      confidence: tally(rows, 'confidence'),
      search_need: tally(rows, 'search_need'),
      intent_clarity: tally(rows, 'intent_clarity'),
      expression_type: tally(rows, 'expression_type'),
      dissat_emotion: tally(rows.filter(r => r.is_dissatisfied), 'dissatisfaction_emotion'),
      dissat_severity: tally(rows.filter(r => r.is_dissatisfied), 'dissatisfaction_severity'),
      retry_type: tally(rows.filter(r => (r.retry_count || 0) > 0), 'retry_type'),
      badcase_flags: tally(rows, 'badcase_flags'),
    };
  }

  function longTailTags(stats, threshold) {
    threshold = threshold || 0.02;
    const total = stats.total;
    const tagging = (stats.ability_full || []).filter(([, c]) => c / total < threshold);
    return {
      threshold,
      ability_full: tagging,
      scene_target: (stats.scene_target || []).filter(([, c]) => c / total < threshold),
    };
  }

  // ---------- main entry ----------
  function parse(input, opts) {
    opts = opts || {};
    opts.dataType = opts.dataType || 'i2i';
    opts.imageMode = opts.imageMode || 'single';
    opts.turnMode = opts.turnMode || 'single';

    const rawRows = normalizeRows(input);
    const warnings = [];

    // 收集 xlsx 实际列名（按首行 keys 顺序，并合并所有行的 keys 防止首行字段缺失）
    const seenKeys = new Set();
    const rawColumns = [];
    for (const r of rawRows) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) {
        if (!seenKeys.has(k)) { seenKeys.add(k); rawColumns.push(k); }
      }
      if (rawColumns.length > 200) break; // 安全上限
    }

    let adapter;
    if (opts.dataType === 't2i' && opts.turnMode === 'multi') adapter = adaptT2iMultiTurnRow;
    else if (opts.dataType === 't2i' && opts.turnMode === 'single') adapter = adaptT2iMultiTurnRow;
    else adapter = adaptI2iRow;

    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      try {
        const std = adapter(rawRows[i], opts);
        // 把原始 row 挂到标准 row 上，供前端列配置/表格直接读取
        std._raw = rawRows[i];
        if (std.id || std.prompt) rows.push(std);
      } catch (e) {
        warnings.push({ row: i + 2, error: String(e && e.message || e) });
      }
    }

    const stats = computeStats(rows);
    const longTail = longTailTags(stats, 0.02);

    return {
      meta: {
        data_type: opts.dataType,
        image_mode: opts.imageMode,
        turn_mode: opts.turnMode,
        total_rows: rows.length,
        raw_rows: rawRows.length,
        raw_columns: rawColumns,
        generated_at: new Date().toISOString(),
      },
      rows,
      stats,
      long_tail: longTail,
      warnings,
    };
  }

  // expose
  if (typeof window !== 'undefined') {
    window.TaggingDataAdapter = { parse, _internal: { adaptI2iRow, adaptT2iMultiTurnRow, computeStats, safeParseJSON } };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parse };
  }
})();
