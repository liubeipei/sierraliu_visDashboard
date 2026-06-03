/**
 * tagging-weekly-dashboard v0.1.0
 * 渲染「自动化打标看板」PRD 的按周聚合 + 周环比追踪视图。
 * 依赖：ECharts(window.echarts) + window.TaggingWeeklyAggregator
 * 暴露：window.TaggingWeeklyDashboard.render(container, { weeks, taxonomy, dimension, granularity, onConfigChange })
 *   weeks: [{ id, label, parsed }]（按时间升序）
 */
(function () {
  'use strict';

  const AGG = () => window.TaggingWeeklyAggregator;
  const charts = [];
  const observers = [];

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pct(v, d) { return v == null ? '—' : (v * 100).toFixed(d == null ? 1 : d) + '%'; }
  function shortLabel(v, n) { v = String(v); return v.length > n ? v.slice(0, n - 1) + '…' : v; }

  function disposeAll() {
    while (observers.length) { try { observers.pop().disconnect(); } catch (e) { /* noop */ } }
    while (charts.length) {
      const c = charts.pop();
      try { c.dispose(); } catch (e) { /* noop */ }
    }
  }
  function mkChart(parent, height) {
    const box = el('div', 'tvd-chart-canvas');
    box.style.height = (height || 300) + 'px';
    parent.appendChild(box);
    const c = echarts.init(box);
    charts.push(c);
    // 监听容器尺寸变化（网格列数变化 / 侧栏收起 / 窗口缩放）自动重绘，避免图表错位、溢出到相邻图
    if (typeof ResizeObserver !== 'undefined') {
      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { try { c.resize(); } catch (e) { /* noop */ } });
      });
      ro.observe(box);
      observers.push(ro);
    }
    return c;
  }
  const LINE_COLORS = ['#5B8FF9', '#5AD8A6', '#F6BD16', '#E8684A', '#6DC8EC', '#9270CA', '#FF9D4D', '#269A99', '#FF99C3', '#5D7092'];

  function signed(v, percent) {
    if (v == null || Math.abs(v) < 1e-9) return '持平';
    const s = percent ? (Math.abs(v) * 100).toFixed(1) + '%' : Math.abs(v);
    return (v > 0 ? '↑' : '↓') + s;
  }

  // 规则版精简洞察（离线可用）
  function buildRuleInsight(series) {
    const last = series.latest, prev = series.previous;
    if (!last) return '暂无数据。';
    const t = series.trends;
    const i = t.coverageRate.length - 1;
    const d = (arr) => prev ? arr[i] - arr[i - 1] : null;
    const lines = [];
    lines.push(`本周（${last.label}）共 ${last.summary.total} 条样本，命中考点 ${last.summary.coverage.hit}/${last.summary.coverage.total}（覆盖率 ${(last.summary.coverage.rate * 100).toFixed(1)}%${prev ? '，环比 ' + signed(d(t.coverageRate), true) : ''}）。`);
    if (prev) {
      lines.push(`集中度 CR5 ${(last.summary.concentration.cr5 * 100).toFixed(1)}%（${signed(d(t.cr5), true)}）、CR10 ${(last.summary.concentration.cr10 * 100).toFixed(1)}%（${signed(d(t.cr10), true)}）→ 分布${d(t.cr5) > 0 ? '更集中' : d(t.cr5) < 0 ? '更分散' : '基本稳定'}。`);
      lines.push(`用户行为：保存率 ${(last.summary.behavior.saveRate * 100).toFixed(1)}%（${signed(d(t.saveRate), true)}）、点赞率 ${(last.summary.behavior.likeRate * 100).toFixed(2)}%（${signed(d(t.likeRate), true)}）、点踩率 ${(last.summary.behavior.unlikeRate * 100).toFixed(2)}%（${signed(d(t.unlikeRate), true)}）。`);
      lines.push(`Badcase ${last.summary.badcase.count} 条 / ${(last.summary.badcase.rate * 100).toFixed(2)}%（${series.badcase.wow ? '环比 ' + signed(series.badcase.wow.rateDelta, true) : ''}）。`);
    }
    if (series.added.length) lines.push(`新增考点 ${series.added.length} 个，最高命中：${series.added.slice(0, 3).map(p => p[0] + '(' + p[1] + ')').join('、')}。`);
    if (series.removed.length) lines.push(`消失考点 ${series.removed.length} 个：${series.removed.slice(0, 3).map(p => p[0]).join('、')}。`);
    const up = series.rankRows.filter(r => r.status === 'up').sort((a, b) => b.delta - a.delta)[0];
    const down = series.rankRows.filter(r => r.status === 'down').sort((a, b) => a.delta - b.delta)[0];
    if (up) lines.push(`排名上升最快：${up.kp}（${up.old}→${up.cur}）。`);
    if (down) lines.push(`排名下降最快：${down.kp}（${down.old}→${down.cur}）。`);
    if (series.badcase.highRate[0]) {
      const h = series.badcase.highRate[0];
      lines.push(`高 Badcase 率考点：${h.kp}（${(h.rate * 100).toFixed(1)}%，${h.badcase}/${h.sample}）。`);
    }
    if (series.behaviorWarnings.length) lines.push(`⚠️ ${series.behaviorWarnings.length} 个考点点踩率环比上升≥5%，需关注：${series.behaviorWarnings.slice(0, 3).map(w => w.kp).join('、')}。`);
    return lines.map(s => '• ' + s).join('\n');
  }

  // 给 LLM 的紧凑数据摘要
  function buildLlmSummary(series) {
    const out = [];
    out.push('周序列：' + series.labels.join(' → '));
    const t = series.trends;
    const fmt = (arr, p) => arr.map(v => v == null ? '-' : (p ? (v * 100).toFixed(1) + '%' : v)).join(', ');
    out.push('考点覆盖率: ' + fmt(t.coverageRate, true));
    out.push('CR5: ' + fmt(t.cr5, true) + ' | CR10: ' + fmt(t.cr10, true));
    out.push('保存率: ' + fmt(t.saveRate, true) + ' | 点赞率: ' + fmt(t.likeRate, true) + ' | 点踩率: ' + fmt(t.unlikeRate, true));
    out.push('Badcase数: ' + fmt(t.badcaseCount) + ' | Badcase率: ' + fmt(t.badcaseRate, true));
    if (series.added.length) out.push('本周新增考点(Top): ' + series.added.slice(0, 8).map(p => `${p[0]}(${p[1]})`).join('; '));
    if (series.removed.length) out.push('本周消失考点(Top): ' + series.removed.slice(0, 8).map(p => `${p[0]}(${p[1]})`).join('; '));
    out.push('本周Top考点排名(命中量): ' + series.rankRows.map(r => `${r.kp}#${r.cur}(${r.hit})`).join('; '));
    if (series.badcase.highRate.length) out.push('高Badcase率考点: ' + series.badcase.highRate.slice(0, 6).map(o => `${o.kp}=${(o.rate * 100).toFixed(1)}%(${o.badcase}/${o.sample})`).join('; '));
    if (series.behaviorWarnings.length) out.push('点踩率异动预警: ' + series.behaviorWarnings.map(w => `${w.kp}(+${(w.delta * 100).toFixed(1)}%)`).join('; '));
    return out.join('\n');
  }

  // LLM 洞察富文本渲染：加粗/猜想/百分比高亮
  function renderInsightMd(text) {
    let h = escapeHtml(text);
    // **重点** → 主色加粗
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b style="color:var(--primary);">$1</b>');
    // *(猜想)* 或 (猜想) → 黄色标记
    h = h.replace(/\*?\((猜想)\)\*?/g, '<span style="color:#b45309;background:#fef3c7;padding:0 5px;border-radius:3px;font-weight:600;">（$1）</span>');
    // 其余 *斜体* → 着色
    h = h.replace(/\*([^*]+)\*/g, '<span style="color:#9270CA;">$1</span>');
    // 百分比 / 数字+条 高亮
    h = h.replace(/(\d+(?:\.\d+)?%)/g, '<b style="color:#3b6ed9;">$1</b>');
    // 列表项与换行
    h = h.replace(/^[\s]*[-•]\s?/gm, '· ');
    h = h.replace(/\n/g, '<br/>');
    return h;
  }

  function section(container, title, desc) {
    const sec = el('section', 'tvd-section');
    sec.appendChild(el('h2', 'tvd-section-title', escapeHtml(title)));
    if (desc) sec.appendChild(el('div', 'tvd-chart-title', escapeHtml(desc)));
    container.appendChild(sec);
    return sec;
  }

  // ===== KPI 卡（最新周 + WoW） =====
  function renderKpis(container, series) {
    const latest = series.latest, prev = series.previous;
    if (!latest) return;
    const t = series.trends;
    const lastIdx = t.coverageRate.length - 1;
    const wow = (arr) => (prev ? arr[lastIdx] - arr[lastIdx - 1] : null);
    const cards = [
      { label: '考点覆盖率', value: pct(latest.summary.coverage.rate), sub: `${latest.summary.coverage.hit}/${latest.summary.coverage.total}`, delta: wow(t.coverageRate), tone: 'info' },
      { label: '集中度 CR5', value: pct(latest.summary.concentration.cr5), delta: wow(t.cr5), tone: 'neutral' },
      { label: '集中度 CR10', value: pct(latest.summary.concentration.cr10), delta: wow(t.cr10), tone: 'neutral' },
      { label: '保存率', value: pct(latest.summary.behavior.saveRate), sub: `${latest.summary.behavior.save} 条`, delta: wow(t.saveRate), tone: 'ok', goodUp: true },
      { label: '点赞率', value: pct(latest.summary.behavior.likeRate), sub: `${latest.summary.behavior.like} 条`, delta: wow(t.likeRate), tone: 'ok', goodUp: true },
      { label: '点踩率', value: pct(latest.summary.behavior.unlikeRate), sub: `${latest.summary.behavior.unlike} 条`, delta: wow(t.unlikeRate), tone: 'warn', goodUp: false },
      { label: 'Badcase 率', value: pct(latest.summary.badcase.rate), sub: `${latest.summary.badcase.count} 条`, delta: wow(t.badcaseRate), tone: 'danger', goodUp: false },
    ];
    const grid = el('div', 'tvd-kpi-grid');
    for (const c of cards) {
      const card = el('div', 'tvd-kpi-card tvd-tone-' + c.tone);
      card.appendChild(el('div', 'tvd-kpi-label', escapeHtml(c.label)));
      card.appendChild(el('div', 'tvd-kpi-value', escapeHtml(c.value)));
      let subHtml = c.sub ? escapeHtml(c.sub) : '';
      if (c.delta != null && Math.abs(c.delta) > 1e-9) {
        const up = c.delta > 0;
        const good = c.goodUp == null ? null : (up === c.goodUp);
        const color = good == null ? 'var(--muted)' : (good ? 'var(--ok)' : 'var(--danger)');
        const arrow = up ? '▲' : '▼';
        subHtml += `<span style="margin-left:6px;color:${color};">${arrow} ${pct(Math.abs(c.delta))}</span>`;
      }
      if (subHtml) card.appendChild(el('div', 'tvd-kpi-sub', subHtml));
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }

  function lineChart(c, labels, seriesDefs, opts) {
    opts = opts || {};
    c.setOption({
      tooltip: { trigger: 'axis', valueFormatter: opts.percent ? (v) => v == null ? '—' : (v * 100).toFixed(2) + '%' : undefined },
      legend: seriesDefs.length > 1 ? { top: 0, type: 'scroll' } : undefined,
      grid: { left: 50, right: 24, top: seriesDefs.length > 1 ? 34 : 16, bottom: 30 },
      xAxis: { type: 'category', data: labels, name: opts.xName || '周', axisLabel: { color: '#444' } },
      yAxis: {
        type: 'value', name: opts.yName || '',
        axisLabel: { color: '#666', formatter: opts.percent ? (v) => (v * 100).toFixed(0) + '%' : undefined },
      },
      series: seriesDefs.map((s, i) => ({
        name: s.name, type: 'line', smooth: true, connectNulls: true,
        data: s.data, symbolSize: 7,
        lineStyle: { width: 2 }, itemStyle: { color: LINE_COLORS[i % LINE_COLORS.length] },
        label: opts.showLabel ? { show: true, formatter: (p) => opts.percent ? (p.value * 100).toFixed(1) + '%' : p.value } : undefined,
      })),
    });
  }

  function table(rows, headers) {
    const t = el('table', 'trw-table');
    t.style.width = '100%';
    const thead = el('thead');
    thead.innerHTML = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    t.appendChild(thead);
    const tb = el('tbody');
    tb.innerHTML = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    t.appendChild(tb);
    return t;
  }

  function render(container, cfg) {
    cfg = cfg || {};
    disposeAll();
    container.innerHTML = '';
    container.classList.add('tvd-root');

    const weeks = (cfg.weeks || []).slice();
    if (!weeks.length) {
      container.appendChild(el('div', 'tvd-empty', '尚无周数据，请在下方上传或确认 dataset 清单'));
      return;
    }

    const dimension = cfg.dimension || 'ability';
    const granularity = cfg.granularity || 'full';
    const taxonomy = cfg.taxonomy || {};

    // 外露分段按钮控件（替代下拉），返回带 .value getter 的对象，兼容旧的 dimSel.value 读法
    function segmented(items, current, onChange) {
      const wrap = el('div', 'tvd-seg');
      const st = { value: current };
      items.forEach((it) => {
        const b = el('button', 'tvd-seg-btn' + (it.key === current ? ' active' : ''), escapeHtml(it.label));
        b.dataset.key = it.key;
        b.addEventListener('click', () => {
          if (st.value === it.key) return;
          st.value = it.key;
          wrap.querySelectorAll('.tvd-seg-btn').forEach(x => x.classList.toggle('active', x.dataset.key === it.key));
          if (onChange) onChange(it.key);
        });
        wrap.appendChild(b);
      });
      return { el: wrap, get value() { return st.value; } };
    }
    function ctrlGroup(parent, label, ctlEl) {
      const g = el('div', 'tvd-ctrl-group');
      g.appendChild(el('span', 'tvd-ctrl-label', label));
      g.appendChild(ctlEl);
      parent.appendChild(g);
      return g;
    }

    // 顶部控制条
    const ctrls = el('div', 'tvd-ctrls');
    const dimSel = segmented(AGG().DIMENSIONS.map(d => ({ key: d.key, label: d.label })), dimension, () => { emitConfig(); paint(); });
    ctrlGroup(ctrls, '维度', dimSel.el);
    const granSel = segmented(AGG().GRANULARITY.map(g => ({ key: g.key, label: g.label })), granularity, () => { emitConfig(); paint(); });
    ctrlGroup(ctrls, '粒度', granSel.el);
    const topSel = segmented([{ key: '10', label: 'Top 10' }, { key: '20', label: 'Top 20' }], '10', () => paint());
    ctrlGroup(ctrls, '榜单', topSel.el);

    // 周选择：当前周 vs 基准周（趋势图始终展示全部周，环比类图表用所选两周）
    const weekOpts = weeks.map((w, i) => `<option value="${i}">${escapeHtml(w.label || ('第' + (i + 1) + '周'))}</option>`).join('');
    const curSel = el('select', 'tvd-filter');
    curSel.innerHTML = weekOpts;
    curSel.value = String(weeks.length - 1);
    curSel.disabled = weeks.length < 2;
    ctrlGroup(ctrls, '当前周', curSel);
    const baseSel = el('select', 'tvd-filter');
    baseSel.innerHTML = weekOpts;
    baseSel.value = String(Math.max(0, weeks.length - 2));
    baseSel.disabled = weeks.length < 2;
    ctrlGroup(ctrls, '对比基准', baseSel);

    const meta = el('span', 'tvd-ck-label', `共 ${weeks.length} 周`);
    meta.style.marginLeft = 'auto';
    ctrls.appendChild(meta);
    const insightBtn = el('button', 'tvd-banner-btn tvd-banner-btn-primary', '🔍 一键洞察');
    ctrls.appendChild(insightBtn);
    container.appendChild(ctrls);

    function emitConfig() {
      if (typeof cfg.onConfigChange === 'function') {
        cfg.onConfigChange({ dimension: dimSel.value, granularity: granSel.value });
      }
    }
    curSel.addEventListener('change', () => {
      // 基准周默认跟随当前周的前一周，但用户可再自由调整
      const ci = parseInt(curSel.value, 10);
      if (parseInt(baseSel.value, 10) >= ci) baseSel.value = String(Math.max(0, ci - 1));
      paint();
    });
    baseSel.addEventListener('change', () => paint());

    const body = el('div');
    container.appendChild(body);

    let lastSeries = null;
    let insightMount = null;

    function paint() {
      disposeAll();
      body.innerHTML = '';
      const topN = parseInt(topSel.value, 10) || 10;
      const summarized = weeks.map(w => ({
        id: w.id, label: w.label,
        summary: AGG().summarizeWeek(w.parsed, { dimension: dimSel.value, granularity: granSel.value, taxonomy }),
      }));
      const currentIndex = Math.min(weeks.length - 1, Math.max(0, parseInt(curSel.value, 10) || weeks.length - 1));
      let prevIndex = parseInt(baseSel.value, 10);
      if (isNaN(prevIndex) || prevIndex === currentIndex) prevIndex = currentIndex - 1;
      const series = AGG().buildSeries(summarized, { topN, currentIndex, prevIndex });
      lastSeries = series;
      const curLab = series.latest ? series.latest.label : '本周';
      const baseLab = series.previous ? series.previous.label : '—';
      const cmpLabel = series.previous ? `${baseLab} → ${curLab}` : `${curLab}（无对比周）`;

      const dimLabel = (AGG().DIMENSIONS.find(d => d.key === dimSel.value) || {}).label || '考点';
      const curWeek = weeks[currentIndex];
      const baseWeek = weeks[prevIndex];
      const hint = (sec, txt) => { const t = sec.querySelector('.tvd-section-title'); if (t) t.insertAdjacentHTML('beforeend', `<span class="tvd-hint">${txt}</span>`); };

      // ============ 层级 1 · 概览 ============
      layer(body, '1', '概览 · Overview', `${curLab} 关键指标与一键洞察`);
      renderKpis(body, series);
      insightMount = el('div');
      body.appendChild(insightMount);

      // ============ 层级 2 · 结构与分布 ============
      layer(body, '2', '结构与分布 · Structure', `${dimLabel}的类目构成、覆盖广度与集中度`);
      const l1Cur = AGG().summarizeWeek(curWeek.parsed, { dimension: dimSel.value, granularity: 'l1', taxonomy });

      const secStruct = section(body, `📊 ${dimLabel}一级类目占比 & 覆盖 / 集中度`);
      hint(secStruct, '🔍 点击柱状查看 case');
      const gS = el('div', 'tvd-grid-2'); secStruct.appendChild(gS);
      const l1Block = el('div', 'tvd-chart-block tvd-clickable');
      l1Block.appendChild(el('div', 'tvd-chart-title', `${curLab} · 一级类目占比（横向柱状）`));
      gS.appendChild(l1Block);
      shareBarChart(mkChart(l1Block, Math.max(260, l1Cur.hitMap.size * 30 + 50)), [{ label: curLab, summary: l1Cur }], {
        color: '#5B8FF9',
        onClick: (name) => openCases(`${name} · ${curLab} 全部 case`, casesFor(curWeek, name, { granularity: 'l1' }), `一级类目「${name}」`),
      });
      const covBlock = el('div', 'tvd-chart-block');
      covBlock.appendChild(el('div', 'tvd-chart-title', '覆盖率 & 集中度 CR5/CR10（全部周趋势）'));
      gS.appendChild(covBlock);
      lineChart(mkChart(covBlock, 300), series.labels, [
        { name: '覆盖率', data: series.trends.coverageRate },
        { name: 'CR5', data: series.trends.cr5 },
        { name: 'CR10', data: series.trends.cr10 },
      ], { percent: true, yName: '比率' });

      // 二级类目占比（横向柱状，展示全部 L2；有对比周则双周分组）
      const secL2 = section(body, series.previous ? `📊 二级类目占比（${cmpLabel} · 全部 L2）` : `📊 ${curLab} 二级类目占比（全部 L2）`);
      hint(secL2, '🔍 点击柱状查看 case');
      const l2Weeks = [baseWeek, curWeek].filter(Boolean).map(w => ({ label: w.label, summary: AGG().summarizeWeek(w.parsed, { dimension: dimSel.value, granularity: 'l2', taxonomy }) }));
      const l2Count = new Set([].concat(...l2Weeks.map(w => [...w.summary.hitMap.keys()]))).size;
      shareBarChart(mkChart(secL2, Math.max(320, l2Count * (l2Weeks.length > 1 ? 30 : 24) + 70)), l2Weeks, {
        onClick: (name) => openCases(`${name} · ${curLab} 全部 case`, casesFor(curWeek, name, { granularity: 'l2' }), `二级类目「${name}」`),
      });

      // ============ 层级 3 · 排名与变动 ============
      layer(body, '3', '排名与变动 · Ranking', `Top ${topN} ${dimLabel}排名、环比位移与周增减`);

      const sec3 = section(body, `🏆 Top ${topN} ${dimLabel}排名（${cmpLabel} 位移）`);
      hint(sec3, '🔍 点击行查看 case');
      const rankTbl = table(series.rankRows.map(r => {
        let mark = '<span style="color:var(--muted)">—</span>';
        if (r.status === 'new') mark = '<span style="color:var(--primary)">NEW</span>';
        else if (r.status === 'up') mark = `<span style="color:var(--ok)">▲ ${r.delta}</span>`;
        else if (r.status === 'down') mark = `<span style="color:var(--danger)">▼ ${Math.abs(r.delta)}</span>`;
        return [r.cur || '—', escapeHtml(r.kp), r.hit, r.old || '—', mark];
      }), ['本周排名', dimLabel, '命中量', '上周排名', '变动']);
      sec3.appendChild(rankTbl);
      attachRowClicks(rankTbl, series.rankRows.map(r => r.kp), (kp) => openCases(`${kp} · ${curLab} 全部 case`, casesFor(curWeek, kp), `${dimLabel}「${kp}」`));

      if (series.previous) {
        const sec3b = section(body, `📊 ${dimLabel}排名变化哑铃图（${cmpLabel}）`);
        sec3b.appendChild(el('div', 'tvd-chart-title', '●上周 → ●本周，越靠左排名越高；绿色上升 / 红色下降'));
        rankChangeChart(mkChart(sec3b, Math.max(360, series.rankRows.length * 34)), series.rankRows);
      }

      if (series.previous) {
        const sec2 = section(body, `🔼 周增 / 🔽 周减${dimLabel}（${cmpLabel}）`);
        hint(sec2, '🔍 点击行查看 case');
        const g2 = el('div', 'tvd-grid-2'); sec2.appendChild(g2);
        const addBlock = el('div', 'tvd-list-block');
        addBlock.appendChild(el('div', 'tvd-list-title', `周增${dimLabel} · ${series.added.length} 项`));
        if (series.added.length) {
          const t = table(series.added.slice(0, 30).map(([k, c]) => [escapeHtml(k), `<b style="color:var(--ok)">+${c}</b>`]), [dimLabel, '本周命中量']);
          addBlock.appendChild(t);
          attachRowClicks(t, series.added.slice(0, 30).map(p => p[0]), (kp) => openCases(`${kp} · ${curLab} case`, casesFor(curWeek, kp), `本周新增「${kp}」`));
        } else addBlock.appendChild(el('div', 'tvd-empty', '无新增'));
        g2.appendChild(addBlock);
        const rmBlock = el('div', 'tvd-list-block');
        rmBlock.appendChild(el('div', 'tvd-list-title', `周减${dimLabel} · ${series.removed.length} 项`));
        if (series.removed.length) {
          const t = table(series.removed.slice(0, 30).map(([k, c]) => [escapeHtml(k), `<span style="color:var(--muted)">上周 ${c}</span>`]), [dimLabel, '上周命中量']);
          rmBlock.appendChild(t);
          attachRowClicks(t, series.removed.slice(0, 30).map(p => p[0]), (kp) => openCases(`${kp} · ${baseLab} case`, casesFor(baseWeek, kp), `上周「${kp}」（本周消失）`));
        } else rmBlock.appendChild(el('div', 'tvd-empty', '无消失'));
        g2.appendChild(rmBlock);
      }

      // ============ 层级 4 · 用户行为 ============
      layer(body, '4', '用户行为 · Behavior', '整体保存/点赞/点踩趋势、Top 考点行为热力与异动');

      const sec4 = section(body, '👍 用户行为构成 & 趋势');
      hint(sec4, '🔍 点击扇区查看 case');
      const g4 = el('div', 'tvd-grid-2'); sec4.appendChild(g4);
      const behDonutBlock = el('div', 'tvd-chart-block tvd-clickable');
      behDonutBlock.appendChild(el('div', 'tvd-chart-title', `${curLab} · 行为动作构成（保存/点赞/点踩）`));
      g4.appendChild(behDonutBlock);
      const bsum = series.latest.summary;
      donutChart(mkChart(behDonutBlock, 300), [['保存', bsum.behavior.save], ['点赞', bsum.behavior.like], ['点踩', bsum.behavior.unlike]], {
        colors: ['#5AD8A6', '#5B8FF9', '#E8684A'], centerLabel: '行为',
        onClick: (name) => { const m = { '保存': 'save', '点赞': 'like', '点踩': 'unlike' }; openCases(`${curLab} · ${name} case`, casesFor(curWeek, null, { behavior: m[name] }), `${name}行为`); },
      });
      const behTrendBlock = el('div', 'tvd-chart-block');
      behTrendBlock.appendChild(el('div', 'tvd-chart-title', '保存 / 点赞 / 点踩率（全部周趋势）'));
      g4.appendChild(behTrendBlock);
      lineChart(mkChart(behTrendBlock, 300), series.labels, [
        { name: '保存率', data: series.trends.saveRate },
        { name: '点赞率', data: series.trends.likeRate },
        { name: '点踩率', data: series.trends.unlikeRate },
      ], { percent: true, yName: '比率' });

      const sec5 = section(body, `🔥 Top ${topN} ${dimLabel}行为率 by 周（热力图）`);
      hint(sec5, '🔍 点击格子查看 case');
      const behCtrl = el('div', 'tvd-ctrls');
      const behSel = el('select', 'tvd-filter');
      behSel.innerHTML = `<option value="save">保存率</option><option value="like">点赞率</option><option value="unlike">点踩率</option>`;
      behCtrl.appendChild(el('span', 'tvd-ck-label', '行为：'));
      behCtrl.appendChild(behSel);
      sec5.appendChild(behCtrl);
      const heatBox = el('div'); sec5.appendChild(heatBox);
      function paintHeat() {
        heatBox.innerHTML = '';
        const c = mkChart(heatBox, Math.max(320, series.focusKps.length * 30 + 80));
        heatmap(c, series.labels, series.focusKps, series.behaviorMatrix[behSel.value]);
        c.getZr().setCursorStyle('pointer');
        c.on('click', (p) => {
          const wi = p.value[0], ki = p.value[1];
          const wk = weeks[wi], kp = series.focusKps[ki];
          if (!wk || kp == null) return;
          openCases(`${kp} · ${series.labels[wi]} · ${BEH_LABEL[behSel.value]} case`, casesFor(wk, kp, { behavior: behSel.value }), `${dimLabel}「${kp}」｜${BEH_LABEL[behSel.value]}`);
        });
      }
      behSel.addEventListener('change', paintHeat);
      paintHeat();

      if (series.behaviorWarnings.length) {
        const secW = section(body, '🚨 行为异动预警（点踩率环比上升 ≥ 5%）');
        hint(secW, '🔍 点击行查看点踩 case');
        const t = table(series.behaviorWarnings.map(w => [
          escapeHtml(w.kp),
          `<span style="color:var(--danger)">${pct(w.cur)}</span>`,
          pct(w.old),
          `<b style="color:var(--danger)">▲ ${pct(w.delta)}</b>`,
        ]), [dimLabel, '本周点踩率', '上周点踩率', '环比上升']);
        secW.appendChild(t);
        attachRowClicks(t, series.behaviorWarnings.map(w => w.kp), (kp) => openCases(`${kp} · ${curLab} 点踩 case`, casesFor(curWeek, kp, { behavior: 'unlike' }), `异动「${kp}」`));
      }

      // ============ 层级 5 · Badcase 质量 ============
      layer(body, '5', 'Badcase 质量 · Quality', 'Badcase 率趋势、考点归因与高发预警');

      const sec6 = section(body, '⚠️ Badcase 率趋势 & 一级类目归因');
      hint(sec6, '🔍 点击扇区查看 Badcase');
      const g6 = el('div', 'tvd-grid-2'); sec6.appendChild(g6);
      const b6a = el('div', 'tvd-chart-block'); b6a.appendChild(el('div', 'tvd-chart-title', 'Badcase 率 by 周')); g6.appendChild(b6a);
      lineChart(mkChart(b6a, 280), series.labels, [{ name: 'Badcase 率', data: series.trends.badcaseRate }], { percent: true, showLabel: true });
      const bcDonutBlock = el('div', 'tvd-chart-block tvd-clickable');
      bcDonutBlock.appendChild(el('div', 'tvd-chart-title', `${curLab} · Badcase 一级类目归因`));
      g6.appendChild(bcDonutBlock);
      donutChart(mkChart(bcDonutBlock, 280), [...l1Cur.badcaseByKp.entries()].sort((a, b) => b[1] - a[1]), {
        colors: ['#E8684A', '#F6BD16', '#FF9D4D', '#9270CA', '#5D7092', '#6DC8EC', '#FF99C3'], centerLabel: 'Bad',
        onClick: (name) => openCases(`${name} · ${curLab} Badcase`, casesFor(curWeek, name, { granularity: 'l1', onlyBadcase: true }), `一级类目「${name}」Badcase`),
      });

      const secBd = section(body, `📊 ${curLab} Badcase ${dimLabel}分布 Top ${topN}`);
      hint(secBd, '🔍 点击柱状查看 Badcase');
      if (series.badcase.lastByKp.length) {
        barChart(mkChart(secBd, Math.max(220, Math.min(series.badcase.lastByKp.length, topN) * 26 + 50)), series.badcase.lastByKp.slice(0, topN), {
          onClick: (kp) => openCases(`${kp} · ${curLab} Badcase`, casesFor(curWeek, kp, { onlyBadcase: true }), `${dimLabel}「${kp}」Badcase`),
        });
      } else secBd.appendChild(el('div', 'tvd-empty', '本周无 Badcase'));

      const secHi = section(body, `🔺 高 Badcase 率 & 新增高发${dimLabel}`);
      hint(secHi, '🔍 点击行查看 Badcase');
      const g6c = el('div', 'tvd-grid-2'); secHi.appendChild(g6c);
      const hbBlock = el('div', 'tvd-list-block');
      hbBlock.appendChild(el('div', 'tvd-list-title', `高 Badcase 率${dimLabel} Top ${topN}（样本≥5）`));
      if (series.badcase.highRate.length) {
        const t = table(series.badcase.highRate.map(o => [
          escapeHtml(o.kp), `<b style="color:var(--danger)">${pct(o.rate)}</b>`, `${o.badcase}/${o.sample}`,
        ]), [dimLabel, 'Badcase 率', 'Badcase/样本']);
        hbBlock.appendChild(t);
        attachRowClicks(t, series.badcase.highRate.map(o => o.kp), (kp) => openCases(`${kp} · ${curLab} Badcase`, casesFor(curWeek, kp, { onlyBadcase: true }), `高 Badcase 率「${kp}」`));
      } else hbBlock.appendChild(el('div', 'tvd-empty', '无'));
      g6c.appendChild(hbBlock);

      const nbBlock = el('div', 'tvd-list-block');
      nbBlock.appendChild(el('div', 'tvd-list-title', '新增 Badcase 高发（本周进入榜单）'));
      if (series.badcase.newHigh.length) {
        const t = table(series.badcase.newHigh.map(o => [
          escapeHtml(o.kp), `<span style="color:var(--primary)">NEW</span>`, o.badcase,
        ]), [dimLabel, '状态', '本周 Badcase 数']);
        nbBlock.appendChild(t);
        attachRowClicks(t, series.badcase.newHigh.map(o => o.kp), (kp) => openCases(`${kp} · ${curLab} Badcase`, casesFor(curWeek, kp, { onlyBadcase: true }), `新增高发「${kp}」`));
      } else nbBlock.appendChild(el('div', 'tvd-empty', '无新增高发'));
      g6c.appendChild(nbBlock);

      if (weeks.length > 1) {
        const sec7 = section(body, `📉 关注${dimLabel} Badcase 率周趋势`);
        const trendSeries = series.badcase.rateTrend
          .filter(o => o.series.some(v => v != null && v > 0))
          .slice(0, 8)
          .map(o => ({ name: shortLabel(o.kp, 16), data: o.series }));
        if (trendSeries.length) lineChart(mkChart(sec7, 320), series.labels, trendSeries, { percent: true });
        else sec7.appendChild(el('div', 'tvd-empty', `关注${dimLabel}暂无 Badcase`));
      }

      // ============ 层级 6 · Case 明细浏览 ============
      layer(body, '6', 'Case 明细浏览 · Cases', '按考点/行为筛选；点击图片放大，点击卡片展开详情');
      renderCaseBrowser(body, curWeek, series, dimLabel, curLab);
    }

    // ===== 底部 Case 浏览器（带筛选 + 分页） =====
    function renderCaseBrowser(container, curWeek, series, dimLabel, curLab) {
      const sec = section(container, `🗂️ Case 浏览器（${curLab}）`);
      const bar = el('div', 'tvd-case-toolbar');
      const kpSel = el('select', 'tvd-filter');
      kpSel.innerHTML = `<option value="">全部${dimLabel}</option>` + series.focusKps.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(shortLabel(k, 24))}</option>`).join('');
      const behSel = el('select', 'tvd-filter');
      behSel.innerHTML = `<option value="">全部行为</option><option value="save">保存</option><option value="like">点赞</option><option value="unlike">点踩</option>`;
      const bcWrap = el('label', 'tvd-ck'); const bcChk = el('input'); bcChk.type = 'checkbox';
      bcWrap.appendChild(bcChk); bcWrap.appendChild(document.createTextNode(' 仅 Badcase'));
      const search = el('input', 'tvd-search'); search.type = 'text'; search.placeholder = '搜索 prompt / 考点 / 场景…';
      const cntEl = el('span', 'tvd-ck-label', '');
      bar.appendChild(el('span', 'tvd-ck-label', `${dimLabel}：`)); bar.appendChild(kpSel);
      bar.appendChild(el('span', 'tvd-ck-label', '行为：')); bar.appendChild(behSel);
      bar.appendChild(bcWrap);
      bar.appendChild(search);
      bar.appendChild(cntEl);
      sec.appendChild(bar);
      const grid = el('div', 'tvd-case-grid'); sec.appendChild(grid);
      const moreWrap = el('div', 'tvd-pagination'); sec.appendChild(moreWrap);
      const PAGE = 24;
      let shown = 0, filtered = [];
      function renderMore() {
        filtered.slice(shown, shown + PAGE).forEach(r => grid.appendChild(caseCard(r)));
        shown = Math.min(shown + PAGE, filtered.length);
        cntEl.textContent = `共 ${filtered.length} 条，已展示 ${shown}`;
        moreWrap.innerHTML = '';
        if (shown < filtered.length) {
          const btn = el('button', 'tvd-btn', `加载更多（剩 ${filtered.length - shown}）`);
          btn.addEventListener('click', renderMore);
          moreWrap.appendChild(btn);
        }
      }
      function recompute() {
        filtered = casesFor(curWeek, kpSel.value || null, {
          behavior: behSel.value || undefined,
          onlyBadcase: bcChk.checked,
          search: search.value.trim() || undefined,
        });
        shown = 0; grid.innerHTML = ''; renderMore();
      }
      kpSel.addEventListener('change', recompute);
      behSel.addEventListener('change', recompute);
      bcChk.addEventListener('change', recompute);
      let st; search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(recompute, 250); });
      recompute();
    }

    // 哑铃图：每个考点一行，连线表示上周→本周排名移动（清晰不交叉）
    function rankChangeChart(c, rankRows) {
      const rows = rankRows.filter(r => r.cur).slice().sort((a, b) => a.cur - b.cur);
      if (!rows.length) { c.setOption({ title: { text: '无排名数据', left: 'center', top: 'center', textStyle: { color: '#999', fontSize: 13 } } }); return; }
      const cats = rows.map(r => shortLabel(r.kp, 16));
      const maxRank = Math.max(1, ...rows.map(r => Math.max(r.cur, r.old || r.cur)));
      const colorOf = (r) => r.status === 'up' ? '#16a34a' : r.status === 'down' ? '#ef4444' : '#94a3b8';

      // 连接线：每行一条（y 用类目索引，不会相互交叉）
      const connectors = rows.map((r, i) => ({
        type: 'line', silent: true, symbol: 'none', animation: false,
        lineStyle: { width: 2, color: colorOf(r) },
        data: [[r.old || r.cur, i], [r.cur, i]],
      }));

      c.setOption({
        tooltip: {
          trigger: 'item', confine: true,
          formatter: (p) => {
            const r = rows[p.value[1]];
            return `${escapeHtml(r.kp)}<br/>上周 #${r.old || '—'} → 本周 #${r.cur}（命中 ${r.hit}）`;
          },
        },
        grid: { left: 170, right: 56, top: 30, bottom: 36, containLabel: false },
        xAxis: { type: 'value', name: '排名', min: 1, max: maxRank, axisLabel: { color: '#666', formatter: (v) => '#' + v }, splitLine: { show: true, lineStyle: { color: '#eef1f5' } } },
        yAxis: { type: 'category', inverse: true, data: cats, axisLabel: { color: '#444', fontSize: 11 }, axisTick: { show: false } },
        series: [
          ...connectors,
          {
            name: '上周', type: 'scatter', symbolSize: 11, z: 5,
            itemStyle: { color: '#cbd5e1', borderColor: '#fff', borderWidth: 1 },
            data: rows.map((r, i) => [r.old || r.cur, i]),
            label: { show: true, position: 'left', distance: 6, color: '#94a3b8', fontSize: 10, formatter: (p) => '#' + (rows[p.value[1]].old || '—') },
          },
          {
            name: '本周', type: 'scatter', symbolSize: 13, z: 6,
            data: rows.map((r, i) => ({ value: [r.cur, i], itemStyle: { color: colorOf(r), borderColor: '#fff', borderWidth: 1 } })),
            label: { show: true, position: 'right', distance: 6, color: '#444', fontSize: 11, fontWeight: 'bold', formatter: (p) => '#' + rows[p.value[1]].cur },
          },
        ],
      });
    }

    function radarChart(c, weeksArr, dimLabel, maxAxes) {
      maxAxes = maxAxes || 8;
      // 指标 = 各周命中并集（按最新周命中量降序，取 Top maxAxes）
      const keySet = new Set();
      weeksArr.forEach(w => w.summary.hitMap.forEach((v, k) => keySet.add(k)));
      const last = weeksArr[weeksArr.length - 1];
      let keys = [...keySet].sort((a, b) => (last.summary.hitMap.get(b) || 0) - (last.summary.hitMap.get(a) || 0));
      if (!keys.length) { c.setOption({ title: { text: '无可用数据', left: 'center', top: 'center', textStyle: { color: '#999', fontSize: 13 } } }); return; }
      keys = keys.slice(0, maxAxes);
      const share = (w, k) => {
        const tot = w.summary.meta.totalHits || 0;
        return tot ? +((w.summary.hitMap.get(k) || 0) / tot * 100).toFixed(2) : 0;
      };
      let mx = 0;
      weeksArr.forEach(w => keys.forEach(k => { const v = share(w, k); if (v > mx) mx = v; }));
      // 指标名取末级（去掉父级前缀）更易读，完整名见 tooltip
      const shortName = (k) => { const parts = String(k).split('-'); return shortLabel(parts[parts.length - 1] || k, 10); };
      const indicator = keys.map(k => ({ name: shortName(k), max: Math.ceil(mx / 10) * 10 || 100 }));
      c.setOption({
        tooltip: {
          trigger: 'item', confine: true,
          formatter: (p) => `<b>${escapeHtml(p.name)}</b><br/>` + keys.map((k, i) => `${escapeHtml(k)}：${p.value[i]}%`).join('<br/>'),
        },
        legend: { type: 'scroll', top: 0, data: weeksArr.map(w => w.label) },
        radar: { indicator, radius: '60%', center: ['50%', '58%'], axisName: { color: '#444', fontSize: 11 }, splitNumber: 4 },
        series: [{
          type: 'radar', symbolSize: 5,
          data: weeksArr.map((w, i) => ({
            name: w.label,
            value: keys.map(k => share(w, k)),
            areaStyle: { opacity: i === weeksArr.length - 1 ? 0.18 : 0.06 },
            lineStyle: { color: LINE_COLORS[i % LINE_COLORS.length], width: 2 },
            itemStyle: { color: LINE_COLORS[i % LINE_COLORS.length] },
          })),
        }],
      });
    }

    function heatmap(c, xs, ys, matrix) {
      const data = [];
      let mx = 0;
      for (let yi = 0; yi < ys.length; yi++) {
        for (let xi = 0; xi < xs.length; xi++) {
          const v = matrix[yi] && matrix[yi][xi];
          const val = (v == null) ? '-' : +(v * 100).toFixed(2);
          if (v != null && v > mx) mx = v;
          data.push([xi, yi, val]);
        }
      }
      c.setOption({
        tooltip: {
          position: 'top',
          formatter: (p) => `${escapeHtml(ys[p.value[1]])}<br/>${xs[p.value[0]]}：<b>${p.value[2] === '-' ? '无样本' : p.value[2] + '%'}</b>`,
        },
        grid: { top: 10, left: 200, right: 24, bottom: 40 },
        xAxis: { type: 'category', data: xs, axisLabel: { color: '#444' } },
        yAxis: { type: 'category', data: ys.map(k => shortLabel(k, 22)), axisLabel: { color: '#444', fontSize: 11 } },
        visualMap: { min: 0, max: Math.max(mx * 100, 1), calculable: true, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#e8f0fe', '#5b8ff9', '#2c4f9e'] } },
        series: [{ type: 'heatmap', data, label: { show: true, formatter: (p) => p.value[2] === '-' ? '' : p.value[2] + '%', fontSize: 10 } }],
      });
    }

    function barChart(c, pairs, opts) {
      opts = opts || {};
      const top = pairs.slice().reverse();
      c.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 160, right: 30, top: 10, bottom: 30 },
        xAxis: { type: 'value', axisLabel: { color: '#666' } },
        yAxis: { type: 'category', data: top.map(p => shortLabel(p[0], 18)), axisLabel: { color: '#444' } },
        series: [{ type: 'bar', data: top.map(p => p[1]), barWidth: 14, itemStyle: { color: opts.color || '#E8684A' }, label: { show: true, position: 'right', color: '#444' } }],
      });
      if (opts.onClick) c.on('click', (p) => { const pair = top[p.dataIndex]; if (pair) opts.onClick(pair[0]); });
    }

    // ===== 圆环图（占比构成，可点击下钻 case） =====
    function donutChart(c, pairs, opts) {
      opts = opts || {};
      const data = pairs.filter(p => p[1] > 0).map(p => ({ name: String(p[0]), value: p[1] }));
      if (!data.length) { c.setOption({ title: { text: '无数据', left: 'center', top: 'center', textStyle: { color: '#999', fontSize: 13 } } }); return; }
      const total = data.reduce((a, d) => a + d.value, 0);
      c.setOption({
        tooltip: { trigger: 'item', confine: true, formatter: (p) => `${escapeHtml(p.name)}<br/><b>${p.value}</b>（${p.percent}%）` },
        legend: { type: 'scroll', orient: 'vertical', right: 4, top: 'middle', icon: 'circle', textStyle: { fontSize: 11, color: '#555' }, formatter: (n) => shortLabel(n, 11) },
        color: opts.colors || LINE_COLORS,
        graphic: opts.centerLabel ? [{ type: 'text', left: '38%', top: '52%', z: 10, style: { text: opts.centerLabel + '\n' + total, textAlign: 'center', textVerticalAlign: 'middle', fill: '#333', fontSize: 13, fontWeight: 'bold' } }] : undefined,
        series: [{
          type: 'pie', radius: ['46%', '70%'], center: ['38%', '52%'], avoidLabelOverlap: true, minShowLabelAngle: 8,
          itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
          label: { show: true, position: 'outside', formatter: (p) => p.percent + '%', fontSize: 11, color: '#555' },
          labelLine: { show: true, length: 6, length2: 8 },
          labelLayout: { hideOverlap: true },
          emphasis: { scale: true, scaleSize: 6 },
          data,
        }],
      });
      if (opts.onClick) { c.getZr().setCursorStyle('pointer'); c.on('click', (p) => { if (p.name) opts.onClick(p.name); }); }
    }

    // ===== 横向占比柱状图（支持单周或两周对比，显示占比%，可点击下钻） =====
    function shareBarChart(c, weeksArr, opts) {
      opts = opts || {};
      const keySet = new Set();
      weeksArr.forEach(w => w.summary.hitMap.forEach((v, k) => keySet.add(k)));
      const last = weeksArr[weeksArr.length - 1];
      let keys = [...keySet].sort((a, b) => (last.summary.hitMap.get(b) || 0) - (last.summary.hitMap.get(a) || 0));
      if (!keys.length) { c.setOption({ title: { text: '无数据', left: 'center', top: 'center', textStyle: { color: '#999', fontSize: 13 } } }); return; }
      if (opts.maxItems) keys = keys.slice(0, opts.maxItems);
      const multi = weeksArr.length > 1;
      const share = (w, k) => { const tot = w.summary.meta.totalHits || 0; return tot ? +((w.summary.hitMap.get(k) || 0) / tot * 100).toFixed(2) : 0; };
      const cats = keys.map(k => shortLabel(k, 18));
      c.setOption({
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true,
          formatter: (ps) => {
            const i = ps[0].dataIndex;
            return `<b>${escapeHtml(keys[i])}</b><br/>` + ps.map(p => `${p.marker}${escapeHtml(p.seriesName)}：<b>${p.value}%</b>（命中 ${weeksArr[p.seriesIndex].summary.hitMap.get(keys[i]) || 0}）`).join('<br/>');
          },
        },
        legend: multi ? { top: 0, data: weeksArr.map(w => w.label) } : undefined,
        grid: { left: 190, right: 56, top: multi ? 30 : 10, bottom: 24 },
        xAxis: { type: 'value', axisLabel: { color: '#666', formatter: (v) => v + '%' }, splitLine: { lineStyle: { color: '#eef1f5' } } },
        yAxis: { type: 'category', inverse: true, data: cats, axisLabel: { color: '#444', fontSize: 11 } },
        color: opts.colors || LINE_COLORS,
        series: weeksArr.map((w) => ({
          name: w.label, type: 'bar', barMaxWidth: multi ? 11 : 16, barGap: '20%',
          data: keys.map(k => share(w, k)),
          label: { show: true, position: 'right', formatter: (p) => p.value + '%', color: '#444', fontSize: multi ? 10 : 11 },
          labelLayout: { hideOverlap: true },
          itemStyle: multi ? undefined : { color: opts.color || '#5B8FF9', borderRadius: [0, 3, 3, 0] },
        })),
      });
      if (opts.onClick) { c.getZr().setCursorStyle('pointer'); c.on('click', (p) => { const k = keys[p.dataIndex]; if (k != null) opts.onClick(k); }); }
    }

    // ===== 层级分组标题 =====
    function layer(container, no, title, desc) {
      const wrap = el('div', 'tvd-layer');
      wrap.appendChild(el('div', 'tvd-layer-no', String(no)));
      const txt = el('div', 'tvd-layer-text');
      txt.appendChild(el('div', 'tvd-layer-title', escapeHtml(title)));
      if (desc) txt.appendChild(el('div', 'tvd-layer-desc', escapeHtml(desc)));
      wrap.appendChild(txt);
      wrap.appendChild(el('div', 'tvd-layer-line'));
      container.appendChild(wrap);
    }

    // ===== Case 下钻：按维度/粒度/行为过滤当前周明细行 =====
    const BEH_LABEL = { save: '保存', like: '点赞', unlike: '点踩' };
    function casesFor(weekObj, key, o) {
      o = o || {};
      const dim = dimSel.value;
      const gran = o.granularity || granSel.value;
      const defs = AGG().DEFAULT_DEFS;
      const rows = (weekObj && weekObj.parsed && weekObj.parsed.rows) || [];
      return rows.filter((r) => {
        if (key != null) {
          const keys = AGG().keysOf(r, dim, gran);
          if (!keys.includes(key)) return false;
        }
        const raw = r._raw || {};
        if (o.onlyBadcase && !defs.isBadcase(raw)) return false;
        if (o.behavior === 'save' && !defs.isSave(raw)) return false;
        if (o.behavior === 'like' && !defs.isLike(raw)) return false;
        if (o.behavior === 'unlike' && !defs.isUnlike(raw)) return false;
        if (o.search) {
          const hay = ((r.prompt || '') + ' ' + (r.ability_full || '') + ' ' + (r.scene_target || '')).toLowerCase();
          if (!hay.includes(o.search.toLowerCase())) return false;
        }
        return true;
      });
    }

    function caseCard(r) {
      const defs = AGG().DEFAULT_DEFS; const raw = r._raw || {};
      const imgs = (r.input_image_urls && r.input_image_urls.length) ? r.input_image_urls : [];
      const thumb = imgs[0];
      const badges = [];
      if (defs.isBadcase(raw)) badges.push('<span class="tvd-case-flag danger">Badcase</span>');
      if (defs.isUnlike(raw)) badges.push('<span class="tvd-case-flag warn">点踩</span>');
      if (defs.isLike(raw)) badges.push('<span class="tvd-case-flag ok">点赞</span>');
      if (defs.isSave(raw)) badges.push('<span class="tvd-case-flag ok">保存</span>');
      if (r.confidence === 'low') badges.push('<span class="tvd-case-flag info">low_conf</span>');
      const card = el('div', 'tvd-case-card');
      card.innerHTML = `
        ${thumb ? `<img class="tvd-thumb tvd-case-thumb" src="${escapeHtml(thumb)}" alt="case" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="tvd-case-noimg">无图片</div>'}
        <div class="tvd-case-body">
          <div class="tvd-case-prompt">${escapeHtml(shortLabel(r.prompt || '（无 prompt）', 72))}</div>
          <div class="tvd-case-tags">
            ${r.ability_full ? `<div class="tvd-case-tag" title="${escapeHtml(r.ability_full)}">🎯 ${escapeHtml(r.ability_full)}</div>` : ''}
            ${r.scene_target ? `<div class="tvd-case-tag" title="${escapeHtml(r.scene_target)}">🏷️ ${escapeHtml(r.scene_target)}</div>` : ''}
          </div>
          <div class="tvd-case-flags">${badges.join('')}</div>
        </div>
        <div class="tvd-case-detail"></div>`;
      const body = card.querySelector('.tvd-case-body');
      const detail = card.querySelector('.tvd-case-detail');
      body.addEventListener('click', () => {
        if (detail.classList.contains('show')) { detail.classList.remove('show'); return; }
        if (!detail.dataset.built) { detail.innerHTML = caseDetailHtml(r); detail.dataset.built = '1'; }
        detail.classList.add('show');
      });
      return card;
    }

    function caseDetailHtml(r) {
      const raw = r._raw || {};
      const rows = [];
      if (r.id) rows.push(`<div class="tvd-case-detail-row"><b>数据ID：</b>${escapeHtml(r.id)}</div>`);
      rows.push(`<div class="tvd-case-detail-row"><b>Prompt：</b>${escapeHtml(r.prompt || '—')}</div>`);
      if (r.ability_full) rows.push(`<div class="tvd-case-detail-row"><b>考点：</b>${escapeHtml(r.ability_full)}</div>`);
      if (r.scene_target) rows.push(`<div class="tvd-case-detail-row"><b>场景：</b>${escapeHtml(r.scene_target)}</div>`);
      if (r.output_form) rows.push(`<div class="tvd-case-detail-row"><b>输出形态：</b>${escapeHtml(r.output_form)}</div>`);
      if (r.search_need) rows.push(`<div class="tvd-case-detail-row"><b>搜索需求：</b>${escapeHtml(r.search_need)}</div>`);
      const beh = [];
      if (Number(raw.click_picture_save_cnt) > 0) beh.push('保存×' + raw.click_picture_save_cnt);
      if (Number(raw.like_cnt) > 0) beh.push('点赞×' + raw.like_cnt);
      if (Number(raw.unlike_cnt) > 0) beh.push('点踩×' + raw.unlike_cnt);
      rows.push(`<div class="tvd-case-detail-row"><b>用户行为：</b>${beh.length ? escapeHtml(beh.join('，')) : '无'}</div>`);
      if (r.reasoning) rows.push(`<div class="tvd-case-detail-row"><b>打标理由：</b>${escapeHtml(shortLabel(r.reasoning, 300))}</div>`);
      const ins = (r.input_image_urls || []);
      let imgHtml = '';
      if (ins.length) imgHtml += `<div class="tvd-case-detail-row"><b>输入图：</b></div><div class="tvd-case-detail-imgs">${ins.map(u => `<img class="tvd-thumb" src="${escapeHtml(u)}" referrerpolicy="no-referrer" />`).join('')}</div>`;
      return rows.join('') + imgHtml;
    }

    const CASE_LIMIT = 48;
    function openCases(title, rows, sub) {
      if (!cfg.openModal) return;
      const wrap = el('div', 'tvd-case-wrap');
      const cnt = rows.length;
      wrap.appendChild(el('div', 'tvd-case-sub', (sub ? sub + ' · ' : '') + `共 ${cnt} 条` + (cnt > CASE_LIMIT ? `（展示前 ${CASE_LIMIT}）` : '')));
      if (!cnt) { wrap.appendChild(el('div', 'tvd-empty', '无匹配 case')); cfg.openModal(title, wrap, { wide: true }); return; }
      const grid = el('div', 'tvd-case-grid');
      rows.slice(0, CASE_LIMIT).forEach((r) => grid.appendChild(caseCard(r)));
      wrap.appendChild(grid);
      cfg.openModal(title, wrap, { wide: true });
    }

    function attachRowClicks(tbl, keys, handler) {
      const trs = tbl.querySelectorAll('tbody tr');
      trs.forEach((tr, i) => {
        if (keys[i] == null) return;
        tr.classList.add('tvd-row-click');
        tr.addEventListener('click', () => handler(keys[i], i));
      });
    }

    function runInsight() {
      if (!lastSeries || !insightMount) return;
      const ruleText = buildRuleInsight(lastSeries);
      insightMount.innerHTML = `
        <div class="tvd-section" style="border-left:3px solid var(--primary); background:#f5f9ff;">
          <h2 class="tvd-section-title" style="display:flex;align-items:center;gap:8px;">
            <span>🔍 一键洞察</span>
            <span class="tvd-pill tvd-pill-info" style="font-weight:500;">规则版 · 客观指标</span>
            <span id="insightLlmTag" style="margin-left:auto;"></span>
            <button id="insightToggle" title="折叠/展开" style="cursor:pointer;border:1px solid var(--border);background:#fff;border-radius:6px;padding:3px 10px;font-size:12px;color:var(--muted);">收起 <span id="insightCaret">▾</span></button>
          </h2>
          <div id="insightContent">
            <div id="insightRule" style="white-space:pre-wrap;font-size:13px;line-height:1.9;color:var(--muted);"></div>
            <div id="insightLlm" style="margin-top:14px;"></div>
          </div>
        </div>
      `;
      insightMount.querySelector('#insightRule').textContent = ruleText;
      const toggle = insightMount.querySelector('#insightToggle');
      const content = insightMount.querySelector('#insightContent');
      const caret = insightMount.querySelector('#insightCaret');
      toggle.addEventListener('click', () => {
        const hidden = content.style.display === 'none';
        content.style.display = hidden ? '' : 'none';
        caret.textContent = hidden ? '▾' : '▸';
        toggle.firstChild.textContent = hidden ? '收起 ' : '展开 ';
      });
      insightMount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      const llm = window.TaggingLLMAnalyst;
      const cfg = llm && llm.getConfig ? llm.getConfig() : null;
      const llmBox = insightMount.querySelector('#insightLlm');
      const llmTag = insightMount.querySelector('#insightLlmTag');
      if (!llm || !llm.stream || !cfg || !cfg.apiKey) {
        llmBox.innerHTML = `<div class="tvd-img-tip">💡 已配置 LLM（「LLM 配置」填好 API Key）后，可在此追加 <b>🤖 智能洞察</b>（自动加粗高亮重点）。</div>`;
        return;
      }
      llmTag.innerHTML = `<span class="tvd-pill tvd-pill-warn" style="font-weight:500;">🤖 LLM 生成中…</span>`;
      llmBox.innerHTML = `
        <div style="border-left:3px solid #9270CA; background:#faf7ff; border-radius:8px; padding:12px 16px;">
          <div style="font-weight:700; color:#9270CA; margin-bottom:8px; display:flex; align-items:center; gap:6px;">🤖 LLM 智能洞察<span class="llm-streaming"></span></div>
          <div id="insightLlmText" style="font-size:13.5px; line-height:2; color:var(--text); font-weight:500;"></div>
        </div>`;
      const textEl = llmBox.querySelector('#insightLlmText');
      let buf = '';
      const system = '你是多模态生图打标分析师。基于按周聚合的指标摘要，用中文写"精简"的周环比洞察：先给1句总体结论，再用3-5个要点说明关键变化与可能原因（区分事实与*(猜想)*），最后给1-2条可落地建议。不要套话，数字引用摘要里的真实值。控制在250字内。';
      const user = '以下是本看板当前维度/粒度下的周指标摘要：\n\n' + buildLlmSummary(lastSeries);
      insightBtn.disabled = true;
      const cursor = llmBox.querySelector('.llm-streaming');
      llm.stream({
        system, user,
        onChunk: (d) => { buf += d; textEl.innerHTML = renderInsightMd(buf); },
        onDone: () => {
          textEl.innerHTML = renderInsightMd(buf);
          if (cursor) cursor.remove();
          llmTag.innerHTML = `<span class="tvd-pill tvd-pill-ok" style="font-weight:500;">🤖 LLM 完成</span>`;
          insightBtn.disabled = false;
        },
        onError: (e) => {
          if (cursor) cursor.remove();
          llmTag.innerHTML = `<span class="tvd-pill tvd-pill-danger" style="font-weight:500;">LLM 失败</span>`;
          textEl.innerHTML = '<span style="color:var(--danger);">智能洞察失败：' + escapeHtml(e.message) + '</span>（以上规则版结论仍可参考）';
          insightBtn.disabled = false;
        },
      });
    }
    insightBtn.addEventListener('click', runInsight);

    paint();

    if (!render._resizeBound) {
      window.addEventListener('resize', () => charts.forEach(c => { try { c.resize(); } catch (e) {} }));
      render._resizeBound = true;
    }
  }

  if (typeof window !== 'undefined') {
    window.TaggingWeeklyDashboard = { render };
  }
})();
