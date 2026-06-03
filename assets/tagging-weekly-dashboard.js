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

    // 顶部控制条
    const ctrls = el('div', 'tvd-ctrls');
    ctrls.appendChild(el('span', 'tvd-ck-label', '维度：'));
    const dimSel = el('select', 'tvd-filter');
    dimSel.innerHTML = AGG().DIMENSIONS.map(d => `<option value="${d.key}" ${d.key === dimension ? 'selected' : ''}>${d.label}</option>`).join('');
    ctrls.appendChild(dimSel);
    ctrls.appendChild(el('span', 'tvd-ck-label', '粒度：'));
    const granSel = el('select', 'tvd-filter');
    granSel.innerHTML = AGG().GRANULARITY.map(g => `<option value="${g.key}" ${g.key === granularity ? 'selected' : ''}>${g.label}</option>`).join('');
    ctrls.appendChild(granSel);
    ctrls.appendChild(el('span', 'tvd-ck-label', 'TopN：'));
    const topSel = el('select', 'tvd-filter');
    topSel.innerHTML = `<option value="10">Top 10</option><option value="20">Top 20</option>`;
    ctrls.appendChild(topSel);

    // 周选择：当前周 vs 基准周（趋势图始终展示全部周，环比类图表用所选两周）
    const weekOpts = weeks.map((w, i) => `<option value="${i}">${escapeHtml(w.label || ('第' + (i + 1) + '周'))}</option>`).join('');
    ctrls.appendChild(el('span', 'tvd-ck-label', '当前周：'));
    const curSel = el('select', 'tvd-filter');
    curSel.innerHTML = weekOpts;
    curSel.value = String(weeks.length - 1);
    curSel.disabled = weeks.length < 2;
    ctrls.appendChild(curSel);
    ctrls.appendChild(el('span', 'tvd-ck-label', '对比基准：'));
    const baseSel = el('select', 'tvd-filter');
    baseSel.innerHTML = weekOpts;
    baseSel.value = String(Math.max(0, weeks.length - 2));
    baseSel.disabled = weeks.length < 2;
    ctrls.appendChild(baseSel);

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
    dimSel.addEventListener('change', () => { emitConfig(); paint(); });
    granSel.addEventListener('change', () => { emitConfig(); paint(); });
    topSel.addEventListener('change', () => paint());
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

      renderKpis(body, series);
      insightMount = el('div');
      body.appendChild(insightMount);

      // ===== 1. 覆盖率 & 集中度 =====
      const sec1 = section(body, '📈 考点覆盖率 & 集中度（by 周）');
      const g1 = el('div', 'tvd-grid-2'); sec1.appendChild(g1);
      const b1a = el('div', 'tvd-chart-block'); b1a.appendChild(el('div', 'tvd-chart-title', '考点覆盖率')); g1.appendChild(b1a);
      lineChart(mkChart(b1a, 280), series.labels, [{ name: '覆盖率', data: series.trends.coverageRate }], { percent: true, yName: '覆盖率', showLabel: true });
      const b1b = el('div', 'tvd-chart-block'); b1b.appendChild(el('div', 'tvd-chart-title', '集中度 CR5 / CR10')); g1.appendChild(b1b);
      lineChart(mkChart(b1b, 280), series.labels, [
        { name: 'CR5', data: series.trends.cr5 },
        { name: 'CR10', data: series.trends.cr10 },
      ], { percent: true, yName: '占比' });

      // ===== 周增 / 周减考点 =====
      const sec2 = section(body, `🔼 周增 / 🔽 周减考点（${cmpLabel}）`);
      const g2 = el('div', 'tvd-grid-2'); sec2.appendChild(g2);
      const addBlock = el('div', 'tvd-list-block');
      addBlock.appendChild(el('div', 'tvd-list-title', `周增考点 · ${series.added.length} 项`));
      if (series.added.length) {
        addBlock.appendChild(table(series.added.slice(0, 30).map(([k, c]) => [escapeHtml(k), `<b style="color:var(--ok)">+${c}</b>`]), ['考点', '本周命中量']));
      } else addBlock.appendChild(el('div', 'tvd-empty', '无新增考点'));
      g2.appendChild(addBlock);
      const rmBlock = el('div', 'tvd-list-block');
      rmBlock.appendChild(el('div', 'tvd-list-title', `周减考点 · ${series.removed.length} 项`));
      if (series.removed.length) {
        rmBlock.appendChild(table(series.removed.slice(0, 30).map(([k, c]) => [escapeHtml(k), `<span style="color:var(--muted)">上周 ${c}</span>`]), ['考点', '上周命中量']));
      } else rmBlock.appendChild(el('div', 'tvd-empty', '无消失考点'));
      g2.appendChild(rmBlock);

      // ===== Top N 排名表 + 升降 =====
      const sec3 = section(body, `🏆 Top ${topN} 考点排名（${cmpLabel} 位移）`);
      const rankRows = series.rankRows.map(r => {
        let mark = '<span style="color:var(--muted)">—</span>';
        if (r.status === 'new') mark = '<span style="color:var(--primary)">NEW</span>';
        else if (r.status === 'up') mark = `<span style="color:var(--ok)">▲ ${r.delta}</span>`;
        else if (r.status === 'down') mark = `<span style="color:var(--danger)">▼ ${Math.abs(r.delta)}</span>`;
        return [r.cur || '—', escapeHtml(r.kp), r.hit, r.old || '—', mark];
      });
      sec3.appendChild(table(rankRows, ['本周排名', '考点', '命中量', '上周排名', '变动']));

      // ===== Top 排名变动（哑铃图）+ 结构雷达（并排）=====
      if (series.previous) {
        const sec3b = section(body, `📊 考点排名变化（${cmpLabel}）& 🕸️ L1 结构雷达`);
        const g3 = el('div', 'tvd-grid-2'); sec3b.appendChild(g3);

        const slopeBlock = el('div', 'tvd-chart-block');
        slopeBlock.style.overflow = 'hidden';
        slopeBlock.appendChild(el('div', 'tvd-chart-title', '排名变化（哑铃图：●上周 ●本周，越左排名越高）'));
        g3.appendChild(slopeBlock);
        const h = Math.max(360, series.rankRows.length * 34);
        rankChangeChart(mkChart(slopeBlock, h), series.rankRows);

        const radarBlock = el('div', 'tvd-chart-block');
        radarBlock.appendChild(el('div', 'tvd-chart-title', '一级类目占比结构（周对比）'));
        g3.appendChild(radarBlock);
        const dimLabel = (AGG().DIMENSIONS.find(d => d.key === dimSel.value) || {}).label || '';
        const radarWeeks = [weeks[prevIndex], weeks[currentIndex]].filter(Boolean);
        const l1Weeks = radarWeeks.map(w => ({
          label: w.label,
          summary: AGG().summarizeWeek(w.parsed, { dimension: dimSel.value, granularity: 'l1', taxonomy }),
        }));
        radarChart(mkChart(radarBlock, h), l1Weeks, dimLabel);
      }

      // ===== 整体行为趋势 =====
      const sec4 = section(body, '👍 整体用户行为（保存 / 点赞 / 点踩 率 · by 周）');
      lineChart(mkChart(sec4, 300), series.labels, [
        { name: '保存率', data: series.trends.saveRate },
        { name: '点赞率', data: series.trends.likeRate },
        { name: '点踩率', data: series.trends.unlikeRate },
      ], { percent: true, yName: '比率' });

      // ===== Top10 考点行为热力图 =====
      const sec5 = section(body, `🔥 Top ${topN} 考点行为率 by 周（热力图）`);
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
      }
      behSel.addEventListener('change', paintHeat);
      paintHeat();

      // ===== 行为异动预警 =====
      if (series.behaviorWarnings.length) {
        const secW = section(body, '🚨 考点行为异动预警（点踩率环比上升 ≥ 5%）');
        secW.appendChild(table(series.behaviorWarnings.map(w => [
          escapeHtml(w.kp),
          `<span style="color:var(--danger)">${pct(w.cur)}</span>`,
          pct(w.old),
          `<b style="color:var(--danger)">▲ ${pct(w.delta)}</b>`,
        ]), ['考点', '本周点踩率', '上周点踩率', '环比上升']));
      }

      // ===== Badcase =====
      const sec6 = section(body, '⚠️ Badcase 追踪与归因');
      const g6 = el('div', 'tvd-grid-2'); sec6.appendChild(g6);
      const b6a = el('div', 'tvd-chart-block'); b6a.appendChild(el('div', 'tvd-chart-title', 'Badcase 率 by 周')); g6.appendChild(b6a);
      lineChart(mkChart(b6a, 280), series.labels, [{ name: 'Badcase 率', data: series.trends.badcaseRate }], { percent: true, showLabel: true });
      const b6b = el('div', 'tvd-chart-block'); b6b.appendChild(el('div', 'tvd-chart-title', '最新周 Badcase 考点分布 Top')); g6.appendChild(b6b);
      barChart(mkChart(b6b, 280), series.badcase.lastByKp.slice(0, topN));

      // 高 Badcase 率考点
      const g6c = el('div', 'tvd-grid-2'); sec6.appendChild(g6c);
      const hbBlock = el('div', 'tvd-list-block');
      hbBlock.appendChild(el('div', 'tvd-list-title', `高 Badcase 率考点 Top ${topN}（样本≥5）`));
      if (series.badcase.highRate.length) {
        hbBlock.appendChild(table(series.badcase.highRate.map(o => [
          escapeHtml(o.kp), `<b style="color:var(--danger)">${pct(o.rate)}</b>`, `${o.badcase}/${o.sample}`,
        ]), ['考点', 'Badcase 率', 'Badcase/样本']));
      } else hbBlock.appendChild(el('div', 'tvd-empty', '无'));
      g6c.appendChild(hbBlock);

      const nbBlock = el('div', 'tvd-list-block');
      nbBlock.appendChild(el('div', 'tvd-list-title', '新增 Badcase 高发考点（本周进入榜单）'));
      if (series.badcase.newHigh.length) {
        nbBlock.appendChild(table(series.badcase.newHigh.map(o => [
          escapeHtml(o.kp), `<span style="color:var(--primary)">NEW</span>`, o.badcase,
        ]), ['考点', '状态', '本周 Badcase 数']));
      } else nbBlock.appendChild(el('div', 'tvd-empty', '无新增高发考点'));
      g6c.appendChild(nbBlock);

      // 考点 Badcase 率趋势（多系列）
      if (weeks.length > 1) {
        const sec7 = section(body, '📉 关注考点 Badcase 率周趋势');
        const trendSeries = series.badcase.rateTrend
          .filter(o => o.series.some(v => v != null && v > 0))
          .slice(0, 8)
          .map(o => ({ name: shortLabel(o.kp, 16), data: o.series }));
        if (trendSeries.length) lineChart(mkChart(sec7, 320), series.labels, trendSeries, { percent: true });
        else sec7.appendChild(el('div', 'tvd-empty', '关注考点暂无 Badcase'));
      }
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

    function radarChart(c, l1Weeks, dimLabel) {
      // 指标 = 各周 L1 命中并集（按最新周占比降序）
      const keySet = new Set();
      l1Weeks.forEach(w => w.summary.hitMap.forEach((v, k) => keySet.add(k)));
      const last = l1Weeks[l1Weeks.length - 1];
      const keys = [...keySet].sort((a, b) => (last.summary.hitMap.get(b) || 0) - (last.summary.hitMap.get(a) || 0));
      if (!keys.length) { c.setOption({ title: { text: '无可用 L1 数据', left: 'center', top: 'center', textStyle: { color: '#999', fontSize: 13 } } }); return; }
      const share = (w, k) => {
        const tot = w.summary.meta.totalHits || 0;
        return tot ? +((w.summary.hitMap.get(k) || 0) / tot * 100).toFixed(2) : 0;
      };
      let mx = 0;
      l1Weeks.forEach(w => keys.forEach(k => { const v = share(w, k); if (v > mx) mx = v; }));
      const indicator = keys.map(k => ({ name: shortLabel(k, 8), max: Math.ceil(mx / 10) * 10 || 100 }));
      c.setOption({
        tooltip: { trigger: 'item', confine: true },
        legend: { type: 'scroll', top: 0, data: l1Weeks.map(w => w.label) },
        radar: { indicator, radius: '62%', center: ['50%', '56%'], axisName: { color: '#444', fontSize: 11 } },
        series: [{
          type: 'radar', symbolSize: 5,
          data: l1Weeks.map((w, i) => ({
            name: w.label,
            value: keys.map(k => share(w, k)),
            areaStyle: { opacity: i === l1Weeks.length - 1 ? 0.18 : 0.06 },
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

    function barChart(c, pairs) {
      const top = pairs.slice().reverse();
      c.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 160, right: 30, top: 10, bottom: 30 },
        xAxis: { type: 'value', axisLabel: { color: '#666' } },
        yAxis: { type: 'category', data: top.map(p => shortLabel(p[0], 18)), axisLabel: { color: '#444' } },
        series: [{ type: 'bar', data: top.map(p => p[1]), barWidth: 14, itemStyle: { color: '#E8684A' }, label: { show: true, position: 'right', color: '#444' } }],
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

    topSel.addEventListener('change', paint);
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
