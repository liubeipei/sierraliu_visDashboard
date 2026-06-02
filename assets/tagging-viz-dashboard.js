/**
 * tagging-viz-dashboard v0.1.0
 * 把 tagging-data-adapter 的标准 JSON 渲染成 dashboard
 * 暴露：window.TaggingVizDashboard.render(container, parsed, options)
 * 依赖：ECharts (window.echarts) — 主 HTML 通过 CDN 加载
 */
(function () {
  'use strict';

  // ---------- helpers ----------
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }
  function fmtNum(v) { return (v == null ? 0 : v).toLocaleString(); }
  function topN(arr, n) { return (arr || []).slice(0, n); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- KPI cards ----------
  function hasBadcaseSignal(parsed) {
    const s = parsed.stats || {};
    if ((s.badcase || 0) > 0) return true;
    if ((s.dissat || 0) > 0) return true;
    if ((s.retry_high || 0) > 0) return true;
    if ((s.low_conf || 0) > 0) return true;
    if ((s.not_taggable || 0) > 0) return true;
    return false;
  }

  function buildBadcaseCards(parsed) {
    const s = parsed.stats;
    const meta = parsed.meta;
    const isMultiTurn = meta.turn_mode === 'multi';
    const cards = [
      { label: isMultiTurn ? '总 Session 数' : '总样本数', value: fmtNum(s.total), tone: 'neutral' },
      { label: 'Badcase 占比', value: fmtPct(s.badcase_rate), sub: `${s.badcase} 条`, tone: 'danger' },
      { label: '多图输出占比', value: fmtPct(s.multi_image_rate), sub: `${s.multi_image_output} 条`, tone: 'info' },
    ];
    if (isMultiTurn) {
      cards.push({ label: '不满 Session 占比', value: fmtPct(s.dissat_rate), sub: `${s.dissat} 条`, tone: 'warn' });
      cards.push({ label: '高重试 Session 占比', value: fmtPct(s.retry_high_rate), sub: `重试≥3次 ${s.retry_high} 条`, tone: 'warn' });
      cards.push({ label: '平均轮次', value: s.avg_turn.toFixed(2), tone: 'neutral' });
    } else {
      cards.push({ label: '低置信占比', value: fmtPct(s.low_conf_rate), sub: `${s.low_conf} 条`, tone: 'warn' });
      cards.push({ label: '不可评测占比', value: fmtPct(s.not_taggable_rate), sub: `${s.not_taggable} 条`, tone: 'warn' });
    }
    return cards;
  }

  function buildLabelShareCards(parsed) {
    const s = parsed.stats || {};
    const total = Math.max(1, s.total || 0);
    const pick = (arr) => (arr || []).filter(([k]) => k && k !== '').slice(0, 3);
    const topScene = pick(s.scene_target);
    const topAbility = pick(s.ability_full);
    const topOutput = pick(s.output_form);

    const cards = [
      { label: '总样本数', value: fmtNum(s.total), tone: 'neutral' },
    ];

    if (topScene[0]) {
      cards.push({
        label: `TOP 场景标签占比`,
        value: fmtPct(topScene[0][1] / total),
        sub: `${topScene[0][0]} · ${topScene[0][1]} 条`,
        tone: 'info',
      });
    }
    if (topAbility[0]) {
      cards.push({
        label: `TOP 能力标签占比`,
        value: fmtPct(topAbility[0][1] / total),
        sub: `${topAbility[0][0]} · ${topAbility[0][1]} 条`,
        tone: 'ok',
      });
    }
    if (topOutput[0]) {
      cards.push({
        label: `TOP 输出形态占比`,
        value: fmtPct(topOutput[0][1] / total),
        sub: `${topOutput[0][0]} · ${topOutput[0][1]} 条`,
        tone: 'warn',
      });
    }

    const top3SceneCount = topScene.reduce((a, [, c]) => a + c, 0);
    if (top3SceneCount > 0) {
      cards.push({
        label: 'TOP3 场景覆盖率',
        value: fmtPct(top3SceneCount / total),
        sub: `前 3 标签合计 ${top3SceneCount} 条`,
        tone: 'neutral',
      });
    }
    return cards.slice(0, 6);
  }

  function normalizeLlmCards(cards) {
    const allowedTone = new Set(['danger', 'warn', 'info', 'neutral', 'ok']);
    return (cards || []).slice(0, 6).map(c => ({
      label: String(c.label || '指标'),
      value: String(c.value || '-'),
      sub: c.sub ? String(c.sub) : '',
      tone: allowedTone.has(c.tone) ? c.tone : 'neutral',
    })).filter(c => c.label && c.value);
  }

  function renderKPI(container, parsed) {
    const defaultMode = hasBadcaseSignal(parsed) ? 'badcase' : 'label_share';
    let currentMode = defaultMode;
    let llmCards = null;

    const head = el('div', 'tvd-ctrls');
    const modeSel = el('select', 'tvd-filter');
    modeSel.innerHTML = `
      <option value="badcase">Badcase 视角</option>
      <option value="label_share">标签占比视角</option>
    `;
    modeSel.value = currentMode;
    const llmBtn = el('button', 'tvd-btn', '🤖 LLM 推荐 KPI');
    const tip = el('span', 'tvd-ck-label', '');
    if (!hasBadcaseSignal(parsed)) tip.textContent = '当前数据 badcase 信号较弱，默认使用标签占比视角';
    head.appendChild(el('span', 'tvd-ck-label', 'KPI 视角：'));
    head.appendChild(modeSel);
    head.appendChild(llmBtn);
    head.appendChild(tip);
    container.appendChild(head);

    const wrap = el('div', 'tvd-kpi-grid');
    container.appendChild(wrap);

    function getCards() {
      if (llmCards && llmCards.length) return llmCards;
      return currentMode === 'label_share' ? buildLabelShareCards(parsed) : buildBadcaseCards(parsed);
    }
    function paintCards() {
      wrap.innerHTML = '';
      const cards = getCards();
      for (const c of cards) {
        const card = el('div', 'tvd-kpi-card tvd-tone-' + c.tone);
        card.appendChild(el('div', 'tvd-kpi-label', escapeHtml(c.label)));
        card.appendChild(el('div', 'tvd-kpi-value', escapeHtml(c.value)));
        if (c.sub) card.appendChild(el('div', 'tvd-kpi-sub', escapeHtml(c.sub)));
        wrap.appendChild(card);
      }
    }

    modeSel.addEventListener('change', () => {
      currentMode = modeSel.value;
      llmCards = null; // 手动切换时回到规则卡片
      tip.textContent = currentMode === 'label_share' ? '已切换为标签占比 KPI' : '已切换为 Badcase KPI';
      paintCards();
    });

    llmBtn.addEventListener('click', async () => {
      if (!window.TaggingLLMAnalyst || typeof window.TaggingLLMAnalyst.suggestKpiCards !== 'function') {
        tip.textContent = 'LLM 模块不可用';
        return;
      }
      llmBtn.disabled = true;
      const old = llmBtn.textContent;
      llmBtn.textContent = '⏳ 生成中...';
      tip.textContent = '';
      try {
        const cfg = window.TaggingLLMAnalyst.getConfig();
        if (!cfg.apiKey) throw new Error('请先在「LLM 配置」填写 API Key');
        const result = await window.TaggingLLMAnalyst.suggestKpiCards({ parsed, config: cfg });
        currentMode = result.mode === 'label_share' ? 'label_share' : 'badcase';
        modeSel.value = currentMode;
        llmCards = normalizeLlmCards(result.cards);
        tip.textContent = '已应用 LLM 推荐 KPI';
        paintCards();
      } catch (e) {
        tip.textContent = 'LLM 推荐失败：' + e.message;
      } finally {
        llmBtn.disabled = false;
        llmBtn.textContent = old;
      }
    });

    paintCards();
  }

  // ---------- chart helpers ----------
  function makeChartBlock(title, height) {
    const block = el('div', 'tvd-chart-block');
    block.appendChild(el('div', 'tvd-chart-title', escapeHtml(title)));
    const c = el('div', 'tvd-chart-canvas');
    c.style.height = (height || 320) + 'px';
    block.appendChild(c);
    return { block, canvas: c };
  }
  function barOption(pairs, opts) {
    opts = opts || {};
    const top = topN(pairs.filter(([k]) => k !== ''), opts.topN || 15);
    const cats = top.map(p => p[0]);
    const vals = top.map(p => p[1]);
    const colors = ['#5B8FF9', '#5AD8A6', '#5D7092', '#F6BD16', '#E8684A', '#6DC8EC', '#9270CA', '#FF9D4D', '#269A99', '#FF99C3'];
    return {
      grid: { left: 140, right: 40, top: 20, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', axisLabel: { color: '#666' } },
      yAxis: { type: 'category', data: cats.reverse(), axisLabel: { color: '#444', formatter: (v) => v.length > 18 ? v.slice(0, 17) + '…' : v } },
      series: [{
        type: 'bar',
        data: vals.reverse(),
        itemStyle: { color: (p) => colors[p.dataIndex % colors.length] },
        label: { show: true, position: 'right', color: '#444' },
        barWidth: 16,
      }],
    };
  }
  function pieOption(pairs, opts) {
    opts = opts || {};
    const data = (pairs || []).filter(([k]) => k !== '').slice(0, 12).map(([n, v]) => ({ name: n, value: v }));
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', orient: 'vertical', right: 10, top: 20, bottom: 20, textStyle: { color: '#444' } },
      series: [{
        type: 'pie', radius: ['35%', '70%'], center: ['38%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false }, labelLine: { show: false },
        data,
      }],
    };
  }

  // ---------- distribution sections ----------
  function renderAbilityScene(container, parsed) {
    const grid = el('div', 'tvd-grid-2');
    const a = makeChartBlock('一级能力分布', 320);
    const b = makeChartBlock('TOP15 完整能力路径', 380);
    const c = makeChartBlock('一级场景分布', 320);
    const d = makeChartBlock('TOP10 完整场景标签', 320);
    grid.appendChild(a.block); grid.appendChild(b.block);
    grid.appendChild(c.block); grid.appendChild(d.block);
    container.appendChild(grid);

    echarts.init(a.canvas).setOption(barOption(parsed.stats.ability_l1, { topN: 12 }));
    echarts.init(b.canvas).setOption(barOption(parsed.stats.ability_full, { topN: 15 }));
    echarts.init(c.canvas).setOption(barOption(parsed.stats.scene_target_l1 || [], { topN: 12 }));
    echarts.init(d.canvas).setOption(barOption(parsed.stats.scene_target, { topN: 10 }));
  }

  function renderTriple(container, parsed) {
    const meta = parsed.meta;
    const grid = el('div', 'tvd-grid-3');

    const a = makeChartBlock('输出形态分布', 280);
    const b = makeChartBlock(meta.data_type === 't2i' ? '搜索依赖度' : '搜索需求', 280);
    const c = makeChartBlock(meta.turn_mode === 'multi' ? '意图清晰度' : '置信度', 280);

    grid.appendChild(a.block); grid.appendChild(b.block); grid.appendChild(c.block);
    container.appendChild(grid);

    echarts.init(a.canvas).setOption(pieOption(parsed.stats.output_form));
    echarts.init(b.canvas).setOption(pieOption(parsed.stats.search_need));
    if (meta.turn_mode === 'multi') {
      echarts.init(c.canvas).setOption(pieOption(parsed.stats.intent_clarity));
    } else {
      echarts.init(c.canvas).setOption(pieOption(parsed.stats.confidence));
    }
  }

  function renderMultiTurnExtras(container, parsed) {
    if (parsed.meta.turn_mode !== 'multi') return;
    const grid = el('div', 'tvd-grid-2');
    const a = makeChartBlock('表达型态分布', 280);
    const b = makeChartBlock('重试类型分布', 280);
    grid.appendChild(a.block); grid.appendChild(b.block);
    container.appendChild(grid);

    echarts.init(a.canvas).setOption(pieOption(parsed.stats.expression_type));
    echarts.init(b.canvas).setOption(pieOption(parsed.stats.retry_type));
  }

  // ---------- badcase section ----------
  function renderBadcase(container, parsed) {
    const wrap = el('section', 'tvd-section tvd-badcase-section');
    wrap.appendChild(el('h2', 'tvd-section-title', '⚠️ Badcase 主要分布'));

    const summary = el('div', 'tvd-badcase-summary');
    const s = parsed.stats;
    summary.innerHTML = `
      <span class="tvd-pill tvd-pill-danger">Badcase ${fmtNum(s.badcase)} 条 / ${fmtPct(s.badcase_rate)}</span>
      ${s.dissat ? `<span class="tvd-pill tvd-pill-warn">不满 ${fmtNum(s.dissat)} 条</span>` : ''}
      ${s.retry_high ? `<span class="tvd-pill tvd-pill-warn">高重试 ${fmtNum(s.retry_high)} 条</span>` : ''}
      ${s.low_conf ? `<span class="tvd-pill tvd-pill-warn">低置信 ${fmtNum(s.low_conf)} 条</span>` : ''}
      ${s.not_taggable ? `<span class="tvd-pill tvd-pill-warn">不可评测 ${fmtNum(s.not_taggable)} 条</span>` : ''}
    `;
    wrap.appendChild(summary);

    // badcase 子集分布
    const bcRows = parsed.rows.filter(r => r.is_badcase);
    if (bcRows.length === 0) {
      wrap.appendChild(el('div', 'tvd-empty', '🎉 当前数据无 badcase'));
      container.appendChild(wrap);
      return;
    }
    const tally = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const v = r[key]; if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    const grid = el('div', 'tvd-grid-2');
    const a = makeChartBlock('Badcase 标签命中分布', 280);
    const b = makeChartBlock('Badcase 子集 · 一级能力分布', 280);
    const c = makeChartBlock('Badcase 子集 · 一级场景分布', 280);

    let d;
    if (parsed.meta.turn_mode === 'multi') {
      d = makeChartBlock('不满情绪 × 不满程度', 280);
    } else {
      d = makeChartBlock('Badcase 子集 · 输出形态', 280);
    }

    grid.appendChild(a.block); grid.appendChild(b.block); grid.appendChild(c.block); grid.appendChild(d.block);
    wrap.appendChild(grid);
    container.appendChild(wrap);

    echarts.init(a.canvas).setOption(barOption(parsed.stats.badcase_flags, { topN: 8 }));
    echarts.init(b.canvas).setOption(barOption(tally(bcRows, 'ability_l1'), { topN: 10 }));
    echarts.init(c.canvas).setOption(barOption(tally(bcRows, 'scene_target_l1'), { topN: 10 }));

    if (parsed.meta.turn_mode === 'multi') {
      // 二维矩阵：emotion × severity
      const emos = [...new Set(bcRows.map(r => r.dissatisfaction_emotion).filter(Boolean))];
      const sevs = [...new Set(bcRows.map(r => r.dissatisfaction_severity).filter(Boolean))];
      const cells = [];
      let mx = 0;
      for (let yi = 0; yi < emos.length; yi++) {
        for (let xi = 0; xi < sevs.length; xi++) {
          const v = bcRows.filter(r => r.dissatisfaction_emotion === emos[yi] && r.dissatisfaction_severity === sevs[xi]).length;
          if (v > mx) mx = v;
          cells.push([xi, yi, v]);
        }
      }
      echarts.init(d.canvas).setOption({
        tooltip: { position: 'top' },
        grid: { top: 10, left: 100, right: 30, bottom: 60 },
        xAxis: { type: 'category', data: sevs, axisLabel: { color: '#444' } },
        yAxis: { type: 'category', data: emos, axisLabel: { color: '#444' } },
        visualMap: { min: 0, max: Math.max(mx, 1), orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#fff7ec', '#fdbb84', '#e34a33'] } },
        series: [{ type: 'heatmap', data: cells, label: { show: true } }],
      });
    } else {
      echarts.init(d.canvas).setOption(barOption(tally(bcRows, 'output_form'), { topN: 6 }));
    }
  }

  // ---------- long tail ----------
  function renderLongTail(container, parsed) {
    if (!parsed.long_tail) return;
    const wrap = el('section', 'tvd-section');
    wrap.appendChild(el('h2', 'tvd-section-title', `🔭 长尾标签（占比 < ${(parsed.long_tail.threshold * 100).toFixed(0)}%）`));

    const grid = el('div', 'tvd-grid-2');
    const ab = el('div', 'tvd-list-block');
    ab.appendChild(el('div', 'tvd-list-title', `能力路径 · 共 ${parsed.long_tail.ability_full.length} 项`));
    const abList = el('div', 'tvd-list');
    for (const [tag, c] of parsed.long_tail.ability_full.slice(0, 50)) {
      const item = el('div', 'tvd-list-item');
      item.innerHTML = `<span class="tvd-list-tag">${escapeHtml(tag)}</span><span class="tvd-list-count">${c}</span>`;
      abList.appendChild(item);
    }
    ab.appendChild(abList);

    const sb = el('div', 'tvd-list-block');
    sb.appendChild(el('div', 'tvd-list-title', `场景标签 · 共 ${parsed.long_tail.scene_target.length} 项`));
    const sbList = el('div', 'tvd-list');
    for (const [tag, c] of parsed.long_tail.scene_target.slice(0, 50)) {
      const item = el('div', 'tvd-list-item');
      item.innerHTML = `<span class="tvd-list-tag">${escapeHtml(tag)}</span><span class="tvd-list-count">${c}</span>`;
      sbList.appendChild(item);
    }
    sb.appendChild(sbList);

    grid.appendChild(ab); grid.appendChild(sb);
    wrap.appendChild(grid);
    container.appendChild(wrap);
  }

  // ---------- crosstab matrix ----------
  // 维度定义：每行返回字符串值（空值过滤）。某些维度返回数组（多标签）则展开计数
  const DIMS = [
    { key: 'ability_l1', label: '能力 L1' },
    { key: 'ability_l2', label: '能力 L2' },
    { key: 'ability_full', label: '能力路径' },
    { key: 'scene_target_l1', label: '场景 L1' },
    { key: 'scene_target', label: '场景标签' },
    { key: 'output_form', label: '输出形态' },
    { key: 'search_need', label: '搜索需求' },
    { key: 'confidence', label: '置信度' },
    { key: 'intent_clarity', label: '意图清晰度' },
    { key: 'expression_type', label: '表达型' },
    { key: 'retry_type', label: '重试类型' },
    { key: 'dissatisfaction_emotion', label: '反馈情绪' },
    { key: 'dissatisfaction_severity', label: '不满程度' },
  ];
  function dimAvailable(parsed, key) {
    // 若该维度全为空则不可用
    return parsed.rows.some(r => r[key] != null && r[key] !== '');
  }
  function buildCross(parsed, kx, ky, opts) {
    opts = opts || {};
    const topN = opts.topN || 10;
    const onlyBadcase = !!opts.onlyBadcase;
    const rows = parsed.rows.filter(r => !onlyBadcase || r.is_badcase);

    const xCount = new Map(), yCount = new Map();
    const cellMap = new Map(); // key=`${y}|${x}`
    for (const r of rows) {
      const xv = r[kx]; const yv = r[ky];
      if (!xv || !yv) continue;
      xCount.set(xv, (xCount.get(xv) || 0) + 1);
      yCount.set(yv, (yCount.get(yv) || 0) + 1);
      const k = `${yv}\u0000${xv}`;
      cellMap.set(k, (cellMap.get(k) || 0) + 1);
    }
    const xs = [...xCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(p => p[0]);
    const ys = [...yCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(p => p[0]);
    const data = [];
    let mx = 0;
    for (let yi = 0; yi < ys.length; yi++) {
      for (let xi = 0; xi < xs.length; xi++) {
        const v = cellMap.get(`${ys[yi]}\u0000${xs[xi]}`) || 0;
        if (v > mx) mx = v;
        data.push([xi, yi, v]);
      }
    }
    return { xs, ys, data, max: mx, total: rows.length };
  }
  function renderCrosstab(container, parsed) {
    const wrap = el('section', 'tvd-section');
    wrap.appendChild(el('h2', 'tvd-section-title', '🧩 标签交叉矩阵 (Crosstab)'));

    const ctrls = el('div', 'tvd-ctrls');
    const dimXOpts = DIMS.filter(d => dimAvailable(parsed, d.key));
    const dimYOpts = dimXOpts;

    const selX = el('select', 'tvd-filter');
    selX.innerHTML = dimXOpts.map(d => `<option value="${d.key}">${d.label}</option>`).join('');
    const selY = el('select', 'tvd-filter');
    selY.innerHTML = dimYOpts.map(d => `<option value="${d.key}">${d.label}</option>`).join('');

    // 默认选项
    const defaultX = parsed.meta.data_type === 't2i' ? 'scene_target_l1' : 'scene_target_l1';
    const defaultY = 'ability_l1';
    selX.value = dimXOpts.find(d => d.key === defaultX) ? defaultX : dimXOpts[0].key;
    selY.value = dimYOpts.find(d => d.key === defaultY) ? defaultY : dimYOpts[1]?.key || dimYOpts[0].key;

    const topNInput = el('select', 'tvd-filter');
    topNInput.innerHTML = `<option value="8">TOP 8</option><option value="10" selected>TOP 10</option><option value="15">TOP 15</option><option value="20">TOP 20</option>`;
    const onlyBadCk = el('label', 'tvd-ck');
    onlyBadCk.innerHTML = `<input type="checkbox" /> 仅 Badcase`;

    const xLabel = el('span', 'tvd-ck-label', '行：');
    const yLabel = el('span', 'tvd-ck-label', '列：');

    ctrls.appendChild(yLabel); ctrls.appendChild(selY);
    ctrls.appendChild(xLabel); ctrls.appendChild(selX);
    ctrls.appendChild(topNInput);
    ctrls.appendChild(onlyBadCk);
    wrap.appendChild(ctrls);

    const canvas = el('div', 'tvd-chart-canvas');
    canvas.style.height = '460px';
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const chart = echarts.init(canvas);
    function repaint() {
      const kx = selX.value, ky = selY.value;
      const topN = parseInt(topNInput.value, 10) || 10;
      const onlyBad = onlyBadCk.querySelector('input').checked;
      const built = buildCross(parsed, kx, ky, { topN, onlyBadcase: onlyBad });
      const total = built.total || 1;
      chart.setOption({
        tooltip: {
          position: 'top',
          formatter: (p) => {
            const yv = built.ys[p.value[1]] || '';
            const xv = built.xs[p.value[0]] || '';
            const v = p.value[2];
            return `${escapeHtml(yv)} × ${escapeHtml(xv)}<br/>样本数：<b>${v}</b><br/>占${onlyBad ? 'Badcase' : '总样本'}：${(v / total * 100).toFixed(2)}%`;
          },
        },
        grid: { top: 40, left: 160, right: 30, bottom: 100 },
        xAxis: {
          type: 'category', data: built.xs, splitArea: { show: true },
          axisLabel: { color: '#444', rotate: 30, fontSize: 11, formatter: v => v.length > 12 ? v.slice(0, 11) + '…' : v },
        },
        yAxis: {
          type: 'category', data: built.ys, splitArea: { show: true },
          axisLabel: { color: '#444', fontSize: 11, formatter: v => v.length > 16 ? v.slice(0, 15) + '…' : v },
        },
        visualMap: {
          min: 0, max: Math.max(built.max, 1),
          orient: 'horizontal', left: 'center', bottom: 8,
          inRange: { color: ['#e8f0fe', '#5b8ff9', '#3b6ed9', '#2c4f9e'] },
          textStyle: { fontSize: 11 },
        },
        series: [{
          type: 'heatmap',
          data: built.data,
          label: {
            show: true,
            color: '#222',
            fontSize: 11,
            formatter: (p) => p.value[2] > 0 ? p.value[2] : '',
          },
          emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' } },
        }],
      });
    }
    selX.addEventListener('change', repaint);
    selY.addEventListener('change', repaint);
    topNInput.addEventListener('change', repaint);
    onlyBadCk.querySelector('input').addEventListener('change', repaint);
    repaint();

    // resize observer
    new ResizeObserver(() => chart.resize()).observe(canvas);
  }

  // ---------- main table ----------
  // 默认"标准化"列定义（来自 adapter 标准化输出）
  // source 标记：'std' = 标准化派生字段；'raw' = xlsx 原始列
  const DEFAULT_COLUMNS = [
    { key: 'id', label: 'ID', visible: true, source: 'std', cls: 'tvd-c-id', render: (r) => escapeHtml(r.id) },
    { key: 'prompt', label: 'Prompt', visible: true, source: 'std', cls: 'tvd-c-prompt',
      render: (r) => {
        const s = (r.prompt || '').slice(0, 80);
        return `<span title="${escapeHtml(r.prompt)}">${escapeHtml(s)}${r.prompt && r.prompt.length > 80 ? '…' : ''}</span>`;
      } },
    { key: 'ability_full', label: '能力(标准化)', visible: true, source: 'std', render: (r) => escapeHtml(r.ability_full || '-') },
    { key: 'ability_l1', label: '能力 L1', visible: false, source: 'std', render: (r) => escapeHtml(r.ability_l1 || '-') },
    { key: 'scene_target', label: '场景(标准化)', visible: true, source: 'std', render: (r) => escapeHtml(r.scene_target || '-') },
    { key: 'scene_target_l1', label: '场景 L1', visible: false, source: 'std', render: (r) => escapeHtml(r.scene_target_l1 || '-') },
    { key: 'output_form', label: '输出形态', visible: true, source: 'std', render: (r) => escapeHtml(r.output_form || '-') },
    { key: 'turn_count', label: '轮次', visible: true, source: 'std', render: (r) => r.turn_count || 1 },
    { key: 'convidx', label: '目标轮 idx', visible: false, source: 'std', render: (r) => r.convidx || 0 },
    { key: 'image_count_in', label: '输入图数', visible: false, source: 'std', render: (r) => r.image_count_in || 0 },
    { key: 'image_count_out', label: '输出图数', visible: false, source: 'std', render: (r) => r.image_count_out || 0 },
    { key: 'confidence', label: '置信度', visible: false, source: 'std', render: (r) => escapeHtml(r.confidence || '-') },
    { key: 'is_taggable', label: '可评测', visible: false, source: 'std', render: (r) => r.is_taggable ? '✓' : '✗' },
    { key: 'search_need', label: '搜索需求', visible: false, source: 'std', render: (r) => escapeHtml(r.search_need || '-') },
    { key: 'intent_clarity', label: '意图清晰', visible: false, source: 'std', render: (r) => escapeHtml(r.intent_clarity || '-') },
    { key: 'expression_type', label: '表达型', visible: false, source: 'std', render: (r) => escapeHtml(r.expression_type || '-') },
    { key: 'is_dissatisfied', label: '是否不满', visible: false, source: 'std', render: (r) => r.is_dissatisfied ? '是' : '否' },
    { key: 'dissatisfaction_emotion', label: '反馈情绪', visible: false, source: 'std', render: (r) => escapeHtml(r.dissatisfaction_emotion || '-') },
    { key: 'dissatisfaction_severity', label: '不满程度', visible: false, source: 'std', render: (r) => escapeHtml(r.dissatisfaction_severity || '-') },
    { key: 'retry_count', label: '重试次数', visible: false, source: 'std', render: (r) => r.retry_count || 0 },
    { key: 'retry_type', label: '重试类型', visible: false, source: 'std', render: (r) => escapeHtml(r.retry_type || '-') },
    { key: 'is_sensitive', label: '敏感', visible: false, source: 'std', render: (r) => r.is_sensitive ? '⚠️' : '-' },
    { key: 'badcase_flags', label: '标记', visible: true, source: 'std',
      render: (r) => {
        const flags = (r.badcase_flags || []).map(f =>
          `<span class="tvd-pill tvd-pill-${f === 'dissatisfied' || f === 'retry_high' ? 'danger' : 'warn'}">${escapeHtml(f)}</span>`).join(' ');
        return flags || '<span class="tvd-pill tvd-pill-ok">OK</span>';
      } },
    { key: 'thumb', label: '缩略图', visible: false, source: 'std',
      render: (r) => {
        const u = (r.output_image_urls && r.output_image_urls[0]) || (r.input_image_urls && r.input_image_urls[0]) || '';
        return u ? `<img src="${escapeHtml(u)}" class="tvd-thumb tvd-thumb-mini" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=tvd-img-err>×</span>'"/>` : '-';
      } },
  ];
  // 公开列定义供外部读取（仅返回 meta，不带 render）
  function getDefaultColumns() {
    return DEFAULT_COLUMNS.map(c => ({ key: c.key, label: c.label, visible: c.visible, source: c.source }));
  }

  // 渲染器：原始列（来自 r._raw[key]）
  function rawColumnRender(rawKey) {
    return (r) => {
      const v = r._raw ? r._raw[rawKey] : undefined;
      if (v == null || v === '') return '<span style="color:#bbb;">-</span>';
      const s = String(v);
      // 如果是 URL 类型 → 链接；如果太长 → 截断 + title
      if (/^https?:\/\//.test(s)) {
        return `<a href="${escapeHtml(s)}" target="_blank" rel="noreferrer">🔗 ${escapeHtml(s.slice(0, 40))}…</a>`;
      }
      const short = s.length > 100 ? s.slice(0, 100) + '…' : s;
      return `<span title="${escapeHtml(s)}">${escapeHtml(short)}</span>`;
    };
  }

  // 综合所有可选列：std + raw (按 parsed.meta.raw_columns 顺序)
  // raw 列默认 visible: false，让用户自己挑
  function buildAllColumnDefs(parsed) {
    const all = DEFAULT_COLUMNS.slice();
    const rawCols = (parsed && parsed.meta && parsed.meta.raw_columns) || [];
    for (const rk of rawCols) {
      // 排除掉一些过长的 JSON 字段（默认不出现在选项里？— 还是出现，让用户自己选）
      all.push({
        key: 'raw:' + rk,
        label: rk,
        visible: false,
        source: 'raw',
        rawKey: rk,
        render: rawColumnRender(rk),
      });
    }
    return all;
  }
  // 暴露给外部（列配置面板）：仅 meta，不带 render
  function getAllColumnsMeta(parsed) {
    return buildAllColumnDefs(parsed).map(c => ({
      key: c.key, label: c.label, visible: c.visible, source: c.source, rawKey: c.rawKey,
    }));
  }

  function imgTag(u, cls) {
    if (!u) return '';
    return `<img src="${escapeHtml(u)}" class="${cls}" referrerpolicy="no-referrer" crossorigin="anonymous" loading="lazy" onerror="this.classList.add('tvd-img-broken'); this.dataset.url='${escapeHtml(u)}';" />`;
  }

  function renderTable(container, parsed) {
    const wrap = el('section', 'tvd-section');
    wrap.appendChild(el('h2', 'tvd-section-title', '📋 数据明细'));

    // 获取列配置：优先 parsed.columnConfig（用户保存）→ 否则用 DEFAULT_COLUMNS 中 visible:true 的子集
    function getColumns() {
      const allDefs = buildAllColumnDefs(parsed);  // 含 std + raw
      const cfg = parsed.columnConfig;
      if (!cfg) return allDefs.filter(c => c.visible);
      const out = [];
      for (const item of cfg) {
        if (!item.visible) continue;
        const def = allDefs.find(c => c.key === item.key);
        if (!def) continue;
        out.push(Object.assign({}, def, { label: item.label || def.label }));
      }
      return out.length ? out : allDefs.filter(c => c.visible);
    }

    const ctrls = el('div', 'tvd-ctrls');
    const search = el('input', 'tvd-search');
    search.placeholder = '搜索 prompt / 能力 / 场景 / id...';
    const filter = el('select', 'tvd-filter');
    filter.innerHTML = `
      <option value="">全部样本</option>
      <option value="badcase">仅 Badcase</option>
      <option value="dissatisfied">仅不满</option>
      <option value="retry_high">仅高重试</option>
      <option value="low_confidence">仅低置信</option>
    `;
    const colCfgBtn = el('button', 'tvd-btn', '⚙️ 配置列');
    ctrls.appendChild(search);
    ctrls.appendChild(filter);
    ctrls.appendChild(colCfgBtn);
    wrap.appendChild(ctrls);

    const tbl = el('div', 'tvd-table');
    wrap.appendChild(tbl);
    container.appendChild(wrap);

    const PAGE = 25;
    let page = 0;
    function getFiltered() {
      const kw = search.value.trim().toLowerCase();
      const f = filter.value;
      return parsed.rows.filter(r => {
        if (f === 'badcase' && !r.is_badcase) return false;
        if (f === 'dissatisfied' && !r.is_dissatisfied) return false;
        if (f === 'retry_high' && (r.retry_count || 0) < 3) return false;
        if (f === 'low_confidence' && r.confidence !== 'low') return false;
        if (!kw) return true;
        const blob = [r.id, r.prompt, r.ability_full, r.scene_target, r.session_id].join(' ').toLowerCase();
        return blob.indexOf(kw) >= 0;
      });
    }
    function rowHtml(r, cols) {
      const tds = cols.map(c => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('');
      return `<tr data-id="${escapeHtml(r.id)}">${tds}</tr>`;
    }
    function detailHtml(r) {
      const ph = (r.prompt_history || []).map((h, i) => {
        const hImgs = (h.files || []).map(f => imgTag(f.url || f, 'tvd-thumb tvd-thumb-in')).join('');
        return `<div class="tvd-turn">
          <span class="tvd-turn-no">第 ${i + 1} 轮</span>
          <div class="tvd-turn-prompt">${escapeHtml(h.prompt || '')}</div>
          ${hImgs ? `<div class="tvd-imgs" style="margin-top:6px;">${hImgs}</div>` : ''}
        </div>`;
      }).join('');
      const outImgs = (r.output_image_urls || []).slice(0, 6).map(u => imgTag(u, 'tvd-thumb')).join('');
      const inImgs = (r.input_image_urls || []).slice(0, 6).map(u => imgTag(u, 'tvd-thumb tvd-thumb-in')).join('');
      // URL 链接列表（兜底——图片加载不出来时可点开原始 URL）
      const allUrls = [
        ...(r.input_image_urls || []).map(u => ({ role: '输入', url: u })),
        ...(r.output_image_urls || []).map(u => ({ role: '输出', url: u })),
      ];
      const urlList = allUrls.length ? `<details class="tvd-url-list">
          <summary>📎 显示原始链接 (${allUrls.length})</summary>
          ${allUrls.map(o => `<div class="tvd-url-item"><span class="tvd-pill tvd-pill-info">${o.role}</span><a href="${escapeHtml(o.url)}" target="_blank" rel="noreferrer">${escapeHtml(o.url.slice(0, 100))}${o.url.length > 100 ? '…' : ''}</a></div>`).join('')}
        </details>` : '';
      return `
        <div class="tvd-detail">
          ${inImgs ? `<div class="tvd-detail-row"><b>输入参考图 (${(r.input_image_urls || []).length})</b><div class="tvd-imgs">${inImgs}</div></div>` : ''}
          ${outImgs ? `<div class="tvd-detail-row"><b>输出图 (${(r.output_image_urls || []).length})</b><div class="tvd-imgs">${outImgs}</div></div>` : ''}
          ${urlList ? `<div class="tvd-detail-row">${urlList}<div class="tvd-img-tip">提示：图片可能因 COS 鉴权过期或 referrer 限制而无法直接显示，可点击上方"原始链接"在新标签打开。</div></div>` : ''}
          ${ph ? `<div class="tvd-detail-row"><b>对话历史 / 多轮</b>${ph}</div>` : ''}
          ${r.reasoning ? `<div class="tvd-detail-row"><b>Reasoning</b><div class="tvd-reasoning">${escapeHtml(r.reasoning)}</div></div>` : ''}
        </div>
      `;
    }
    function paint() {
      const cols = getColumns();
      const all = getFiltered();
      const tot = all.length;
      const totalPage = Math.max(1, Math.ceil(tot / PAGE));
      if (page >= totalPage) page = totalPage - 1;
      const slice = all.slice(page * PAGE, (page + 1) * PAGE);
      tbl.innerHTML = `
        <table class="tvd-tbl">
          <thead><tr>${cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${slice.map(r => rowHtml(r, cols)).join('')}</tbody>
        </table>
        <div class="tvd-pagination">
          <span>共 ${tot} 条 · 第 ${page + 1} / ${totalPage} 页 · ${cols.length} 列</span>
          <button class="tvd-btn" data-act="prev" ${page === 0 ? 'disabled' : ''}>上一页</button>
          <button class="tvd-btn" data-act="next" ${page >= totalPage - 1 ? 'disabled' : ''}>下一页</button>
        </div>
      `;
      tbl.querySelectorAll('tbody tr').forEach(tr => {
        tr.addEventListener('click', (e) => {
          if (e.target.tagName === 'A' || e.target.tagName === 'IMG') return;
          const id = tr.dataset.id;
          const next = tr.nextElementSibling;
          if (next && next.classList.contains('tvd-detail-row-tr')) { next.remove(); return; }
          const r = parsed.rows.find(x => x.id === id);
          const dr = document.createElement('tr');
          dr.className = 'tvd-detail-row-tr';
          dr.innerHTML = `<td colspan="${cols.length}">${detailHtml(r)}</td>`;
          tr.after(dr);
        });
      });
      tbl.querySelectorAll('button[data-act]').forEach(b => {
        b.addEventListener('click', () => {
          if (b.dataset.act === 'prev') page--; else page++;
          paint();
        });
      });
    }
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { page = 0; paint(); }, 200); });
    filter.addEventListener('change', () => { page = 0; paint(); });
    colCfgBtn.addEventListener('click', () => {
      // 触发外部回调，让主页面打开列配置面板
      if (typeof parsed._onOpenColumnConfig === 'function') {
        parsed._onOpenColumnConfig(() => paint()); // 配置完后回调 repaint
      }
    });
    paint();
  }

  // ---------- main ----------
  function render(container, parsed, options) {
    options = options || {};
    container.innerHTML = '';
    container.classList.add('tvd-root');

    if (!parsed || !parsed.rows || parsed.rows.length === 0) {
      container.appendChild(el('div', 'tvd-empty', '尚无数据，请先上传 xlsx'));
      return;
    }

    const meta = parsed.meta;
    const banner = el('div', 'tvd-banner');
    banner.innerHTML = `
      <span class="tvd-pill tvd-pill-info">${meta.data_type === 't2i' ? '文生图' : '图生图'}</span>
      <span class="tvd-pill tvd-pill-info">${meta.image_mode === 'multi' ? '多图' : '单图'}</span>
      <span class="tvd-pill tvd-pill-info">${meta.turn_mode === 'multi' ? '多轮' : '单轮'}</span>
      <span class="tvd-meta">共 ${parsed.rows.length} 条 · 生成于 ${new Date(meta.generated_at).toLocaleString()}</span>
      <span class="tvd-banner-actions">
        ${options.onReupload ? `<button class="tvd-banner-btn" data-act="reupload">🔄 重新上传</button>` : ''}
        ${options.onGenerateReport ? `<button class="tvd-banner-btn tvd-banner-btn-primary" data-act="report">📄 生成分析报告</button>` : ''}
      </span>
    `;
    container.appendChild(banner);
    if (options.onReupload) {
      banner.querySelector('[data-act="reupload"]').addEventListener('click', options.onReupload);
    }
    if (options.onGenerateReport) {
      banner.querySelector('[data-act="report"]').addEventListener('click', options.onGenerateReport);
    }

    renderKPI(container, parsed);

    const sec1 = el('section', 'tvd-section');
    sec1.appendChild(el('h2', 'tvd-section-title', '📊 能力 & 场景分布'));
    container.appendChild(sec1);
    renderAbilityScene(sec1, parsed);

    const sec2 = el('section', 'tvd-section');
    sec2.appendChild(el('h2', 'tvd-section-title', '📐 输出形态 / 搜索 / 置信度'));
    container.appendChild(sec2);
    renderTriple(sec2, parsed);

    if (meta.turn_mode === 'multi') {
      const sec3 = el('section', 'tvd-section');
      sec3.appendChild(el('h2', 'tvd-section-title', '🌀 多轮特征'));
      container.appendChild(sec3);
      renderMultiTurnExtras(sec3, parsed);
    }

    if (options.showBadcaseSection !== false) renderBadcase(container, parsed);
    if (options.showCrosstab !== false) renderCrosstab(container, parsed);
    if (options.showLongTail !== false) renderLongTail(container, parsed);
    renderTable(container, parsed);
  }

  if (typeof window !== 'undefined') {
    window.TaggingVizDashboard = { render, getDefaultColumns, getAllColumnsMeta };
  }
})();
