/**
 * tagging-weekly-aggregator v0.1.0
 * 按周聚合 + 周环比(WoW) 计算，服务于「自动化打标看板」PRD。
 * 输入：tagging-data-adapter 的 parsed 结果（rows 含 _raw 原始列）+ 考点/场景全集 taxonomy
 * 暴露：window.TaggingWeeklyAggregator
 *   .summarizeWeek(parsed, { granularity, dimension, taxonomy, defs }) -> WeekSummary
 *   .buildSeries(weeks, opts) -> 跨周序列与对比结构
 *   .GRANULARITY / .DIMENSIONS
 */
(function () {
  'use strict';

  const GRANULARITY = [
    { key: 'l1', label: '一级类目' },
    { key: 'l2', label: '二级类目' },
    { key: 'full', label: '完整路径' },
  ];
  const DIMENSIONS = [
    { key: 'ability', label: '考点(能力标签)' },
    { key: 'scene', label: '场景标签' },
  ];

  function num(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  // 默认行为/Badcase 口径（口径已与用户确认）
  const DEFAULT_DEFS = {
    isSave: (raw) => num(raw.click_picture_save_cnt) > 0,
    isLike: (raw) => num(raw.like_cnt) > 0,
    isUnlike: (raw) => num(raw.unlike_cnt) > 0,
    isBadcase: (raw) => num(raw.unlike_cnt) > 0, // 点踩视为 Badcase
  };

  // 一行可能含多个考点/场景（用 ，,;；、 分隔），需拆分为多标签
  function rawTagsOf(row, dimension) {
    const s = dimension === 'scene' ? (row.scene_target || '') : (row.ability_full || '');
    if (!s) return [];
    return String(s).split(/[，,;；、]+/).map(x => x.trim()).filter(Boolean);
  }
  function levelKey(tag, granularity) {
    const parts = String(tag).split('-');
    if (granularity === 'l1') return parts[0] || '';
    if (granularity === 'l2') return parts.length >= 2 ? parts[0] + '-' + parts[1] : tag;
    return tag;
  }
  // 取某行在指定维度/粒度下的考点 key 列表（去重，空值返回 []）
  function keysOf(row, dimension, granularity) {
    const set = new Set();
    for (const t of rawTagsOf(row, dimension)) {
      const k = levelKey(t, granularity);
      if (k) set.add(k);
    }
    return [...set];
  }
  // 兼容旧调用：返回首个 key
  function keyOf(row, dimension, granularity) {
    return keysOf(row, dimension, granularity)[0] || '';
  }

  // 全量考点集合（覆盖率分母）：按维度+粒度从 taxonomy 派生
  function taxonomyKeys(taxonomy, dimension, granularity) {
    const items = (taxonomy && taxonomy[dimension] && taxonomy[dimension].items) || [];
    const set = new Set();
    for (const it of items) {
      let k = '';
      if (granularity === 'l1') k = it.l1 || '';
      else if (granularity === 'l2') k = it.l1 && it.l2 ? it.l1 + '-' + it.l2 : (it.full || '');
      else k = it.full || '';
      if (k) set.add(k);
    }
    return set;
  }

  function topPairs(map, n) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function summarizeWeek(parsed, opts) {
    opts = opts || {};
    const dimension = opts.dimension || 'ability';
    const granularity = opts.granularity || 'full';
    const defs = Object.assign({}, DEFAULT_DEFS, opts.defs || {});
    const taxonomy = opts.taxonomy || {};
    const rows = (parsed && parsed.rows) || [];
    const total = rows.length;

    const hitMap = new Map();       // 考点 -> 命中量
    const saveByKp = new Map();      // 考点 -> 保存数
    const likeByKp = new Map();
    const unlikeByKp = new Map();
    const cntByKp = new Map();       // 考点 -> 样本数（用于行为率分母）
    const badcaseByKp = new Map();   // 考点 -> badcase 数

    let save = 0, like = 0, unlike = 0, badcase = 0, hitRows = 0;

    for (const r of rows) {
      const raw = r._raw || {};
      const isSave = defs.isSave(raw);
      const isLike = defs.isLike(raw);
      const isUnlike = defs.isUnlike(raw);
      const isBad = defs.isBadcase(raw);
      if (isSave) save++;
      if (isLike) like++;
      if (isUnlike) unlike++;
      if (isBad) badcase++;

      const keys = keysOf(r, dimension, granularity);
      if (keys.length) hitRows++;
      for (const k of keys) {
        hitMap.set(k, (hitMap.get(k) || 0) + 1);
        cntByKp.set(k, (cntByKp.get(k) || 0) + 1);
        if (isSave) saveByKp.set(k, (saveByKp.get(k) || 0) + 1);
        if (isLike) likeByKp.set(k, (likeByKp.get(k) || 0) + 1);
        if (isUnlike) unlikeByKp.set(k, (unlikeByKp.get(k) || 0) + 1);
        if (isBad) badcaseByKp.set(k, (badcaseByKp.get(k) || 0) + 1);
      }
    }

    const totalHits = [...hitMap.values()].reduce((a, b) => a + b, 0) || 0;
    const sortedHits = [...hitMap.entries()].sort((a, b) => b[1] - a[1]);
    const sumTopN = (n) => sortedHits.slice(0, n).reduce((a, p) => a + p[1], 0);

    const taxoSet = taxonomyKeys(taxonomy, dimension, granularity);
    const taxoTotal = taxoSet.size;
    const hitDistinct = hitMap.size;
    // 覆盖率分母优先用 taxonomy；无 taxonomy 时退化为已命中并集
    const coverageTotal = taxoTotal || hitDistinct;
    const hitInTaxo = taxoTotal
      ? [...hitMap.keys()].filter(k => taxoSet.has(k)).length
      : hitDistinct;

    return {
      meta: { dimension, granularity, total, totalHits },
      total,
      // 1. 覆盖率
      coverage: {
        hit: hitInTaxo,
        total: coverageTotal,
        rate: coverageTotal ? hitInTaxo / coverageTotal : 0,
        distinctHit: hitDistinct,
      },
      // 2. 集中度
      concentration: {
        cr5: totalHits ? sumTopN(5) / totalHits : 0,
        cr10: totalHits ? sumTopN(10) / totalHits : 0,
      },
      // 2.1 整体行为
      behavior: {
        save, like, unlike,
        saveRate: total ? save / total : 0,
        likeRate: total ? like / total : 0,
        unlikeRate: total ? unlike / total : 0,
      },
      // 3. Badcase
      badcase: {
        count: badcase,
        rate: total ? badcase / total : 0,
      },
      // 明细 map（供跨周对比）
      hitMap,
      cntByKp,
      saveByKp,
      likeByKp,
      unlikeByKp,
      badcaseByKp,
      ranking: sortedHits, // [ [考点, 命中量], ... ] 降序
    };
  }

  function rateFromMaps(numMap, denMap, key) {
    const den = denMap.get(key) || 0;
    if (!den) return null;
    return (numMap.get(key) || 0) / den;
  }

  // 跨周序列 + 对比
  function buildSeries(weeks, opts) {
    opts = opts || {};
    const topN = opts.topN || 10;
    // weeks: [{ id, label, summary }]，按时间升序
    const labels = weeks.map(w => w.label);

    const coverageRate = weeks.map(w => w.summary.coverage.rate);
    const cr5 = weeks.map(w => w.summary.concentration.cr5);
    const cr10 = weeks.map(w => w.summary.concentration.cr10);
    const saveRate = weeks.map(w => w.summary.behavior.saveRate);
    const likeRate = weeks.map(w => w.summary.behavior.likeRate);
    const unlikeRate = weeks.map(w => w.summary.behavior.unlikeRate);
    const badcaseCount = weeks.map(w => w.summary.badcase.count);
    const badcaseRate = weeks.map(w => w.summary.badcase.rate);

    // 当前周 / 基准周（默认最新一周 vs 上一周，可由 opts 指定任意两周对比）
    const ci = (opts.currentIndex != null && weeks[opts.currentIndex]) ? opts.currentIndex : weeks.length - 1;
    let pi = (opts.prevIndex != null && weeks[opts.prevIndex] != null) ? opts.prevIndex : ci - 1;
    const last = weeks[ci] || null;
    const prev = (pi >= 0 && pi !== ci) ? weeks[pi] : null;
    const focusKps = (last ? last.summary.ranking.slice(0, topN) : []).map(p => p[0]);

    // 周增/周减考点（最新 vs 上一周）
    let added = [], removed = [];
    if (last && prev) {
      const curMap = last.summary.hitMap;
      const prevMap = prev.summary.hitMap;
      for (const [k, c] of curMap.entries()) {
        if (!(prevMap.get(k) > 0)) added.push([k, c]);
      }
      for (const [k, c] of prevMap.entries()) {
        if (!(curMap.get(k) > 0)) removed.push([k, c]);
      }
      added.sort((a, b) => b[1] - a[1]);
      removed.sort((a, b) => b[1] - a[1]);
    }

    // Top 排名变动（最新 vs 上一周）
    function rankMap(week) {
      const m = new Map();
      week.summary.ranking.forEach(([k], i) => m.set(k, i + 1));
      return m;
    }
    const curRank = last ? rankMap(last) : new Map();
    const prevRank = prev ? rankMap(prev) : new Map();
    const rankRows = focusKps.map(k => {
      const cur = curRank.get(k) || null;
      const old = prevRank.get(k) || null;
      let delta = null, status = 'flat';
      if (cur && old) { delta = old - cur; status = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'; }
      else if (cur && !old) { status = 'new'; }
      return {
        kp: k,
        cur, old, delta, status,
        hit: last.summary.hitMap.get(k) || 0,
      };
    });

    // Top10 考点 行为率 by 周（热力图矩阵）
    function behaviorMatrix(kind) {
      // kind: save|like|unlike
      const numKey = kind + 'ByKp';
      return focusKps.map(kp => weeks.map(w => {
        const r = rateFromMaps(w.summary[numKey], w.summary.cntByKp, kp);
        return r == null ? null : r;
      }));
    }

    // 考点行为异动预警：unlike 率 WoW 上升超阈值
    const warnThreshold = opts.warnThreshold == null ? 0.05 : opts.warnThreshold;
    const behaviorWarnings = [];
    if (last && prev) {
      for (const kp of focusKps) {
        const cur = rateFromMaps(last.summary.unlikeByKp, last.summary.cntByKp, kp);
        const old = rateFromMaps(prev.summary.unlikeByKp, prev.summary.cntByKp, kp);
        if (cur != null && old != null && (cur - old) >= warnThreshold) {
          behaviorWarnings.push({ kp, cur, old, delta: cur - old });
        }
      }
    }

    // Badcase 归因
    function badcaseByKpForWeek(week) {
      return [...week.summary.badcaseByKp.entries()].sort((a, b) => b[1] - a[1]);
    }
    const lastBadcaseByKp = last ? badcaseByKpForWeek(last) : [];
    // 高 Badcase 率考点（最新周）：badcase / 该考点样本数，要求样本数>=最小阈值
    const minSample = opts.minSample || 5;
    let highBadcaseRate = [];
    if (last) {
      highBadcaseRate = [...last.summary.cntByKp.entries()]
        .filter(([k, c]) => c >= minSample)
        .map(([k, c]) => ({ kp: k, sample: c, badcase: last.summary.badcaseByKp.get(k) || 0, rate: (last.summary.badcaseByKp.get(k) || 0) / c }))
        .filter(o => o.badcase > 0)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, topN);
    }
    // 考点 Badcase 率周趋势（关注集合）
    const badcaseRateTrend = focusKps.map(kp => ({
      kp,
      series: weeks.map(w => {
        const den = w.summary.cntByKp.get(kp) || 0;
        return den ? (w.summary.badcaseByKp.get(kp) || 0) / den : null;
      }),
    }));
    // 新增 Badcase 高发考点：最新周进入 badcase Top 榜，但上一周不在
    let newBadcaseHigh = [];
    if (last && prev) {
      const prevTop = new Set(badcaseByKpForWeek(prev).slice(0, topN).map(p => p[0]));
      newBadcaseHigh = lastBadcaseByKp.slice(0, topN)
        .filter(([k]) => !prevTop.has(k))
        .map(([k, c]) => ({ kp: k, badcase: c }));
    }

    return {
      labels, focusKps,
      trends: { coverageRate, cr5, cr10, saveRate, likeRate, unlikeRate, badcaseCount, badcaseRate },
      added, removed,
      rankRows,
      behaviorMatrix: { save: behaviorMatrix('save'), like: behaviorMatrix('like'), unlike: behaviorMatrix('unlike') },
      behaviorWarnings,
      badcase: {
        lastByKp: lastBadcaseByKp,
        highRate: highBadcaseRate,
        rateTrend: badcaseRateTrend,
        newHigh: newBadcaseHigh,
        wow: (last && prev) ? {
          countDelta: last.summary.badcase.count - prev.summary.badcase.count,
          rateDelta: last.summary.badcase.rate - prev.summary.badcase.rate,
        } : null,
      },
      latest: last, previous: prev,
    };
  }

  if (typeof window !== 'undefined') {
    window.TaggingWeeklyAggregator = {
      GRANULARITY, DIMENSIONS, DEFAULT_DEFS,
      summarizeWeek, buildSeries, keyOf, keysOf, taxonomyKeys,
    };
  }
})();
