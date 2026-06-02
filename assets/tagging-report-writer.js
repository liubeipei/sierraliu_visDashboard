/**
 * tagging-report-writer v0.1.0
 * 合成 t2i + i2i 双源分析报告 (Markdown)
 * 暴露：window.TaggingReportWriter
 *   .render(container, {t2i, i2i}, options)
 *   .toMarkdown({t2i, i2i}) → string
 */
(function () {
  'use strict';

  function fmtPct(v) { return v == null ? '-' : (v * 100).toFixed(1) + '%'; }
  function fmtNum(v) { return v == null ? '-' : Number(v).toLocaleString(); }
  function topN(arr, n) { return (arr || []).slice(0, n); }

  function tableRows(rows) {
    return rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
  }

  function overviewTable(t2i, i2i) {
    const ts = t2i ? t2i.stats : null;
    const is = i2i ? i2i.stats : null;
    const rows = [
      ['维度', '文生图 (t2i)', '图生图 (i2i)'],
      ['---', '---', '---'],
      ['总样本/Session 数', fmtNum(ts?.total), fmtNum(is?.total)],
      ['Badcase 占比', fmtPct(ts?.badcase_rate), fmtPct(is?.badcase_rate)],
      ['不满 Session 占比', fmtPct(ts?.dissat_rate), '-'],
      ['高重试占比 (≥3)', fmtPct(ts?.retry_high_rate), '-'],
      ['低置信占比', '-', fmtPct(is?.low_conf_rate)],
      ['不可评测占比', '-', fmtPct(is?.not_taggable_rate)],
      ['多图输出占比', fmtPct(ts?.multi_image_rate), fmtPct(is?.multi_image_rate)],
      ['平均轮次', ts?.avg_turn?.toFixed(2) || '-', '-'],
    ];
    return tableRows(rows);
  }

  function distSection(title, parsed, key, n) {
    if (!parsed) return '_无数据_';
    const top = topN(parsed.stats[key], n).filter(([k]) => k !== '');
    if (top.length === 0) return '_无数据_';
    const total = parsed.stats.total || 1;
    const rows = [
      ['排名', '标签', '样本数', '占比'],
      ['---', '---', '---', '---'],
      ...top.map((p, i) => [i + 1, p[0], p[1], fmtPct(p[1] / total)]),
    ];
    return tableRows(rows);
  }

  function badcaseSummary(parsed, label) {
    if (!parsed) return '_无数据_';
    const bcRows = parsed.rows.filter(r => r.is_badcase);
    if (bcRows.length === 0) return '🎉 该数据集无 badcase';

    const tally = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const v = r[key]; if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const total = parsed.stats.total;
    const lines = [];
    lines.push(`- **总 Badcase 数**：${bcRows.length} (${fmtPct(bcRows.length / total)})`);
    lines.push(`- **命中标签 TOP**：${topN(parsed.stats.badcase_flags, 5).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);
    lines.push(`- **集中能力 TOP5**：${topN(tally(bcRows, 'ability_l1'), 5).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);
    lines.push(`- **集中场景 TOP5**：${topN(tally(bcRows, 'scene_target_l1'), 5).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);

    if (parsed.meta.turn_mode === 'multi') {
      const dissatRows = bcRows.filter(r => r.is_dissatisfied);
      if (dissatRows.length) {
        lines.push(`- **不满 Session 数**：${dissatRows.length} 条`);
        lines.push(`  - 主要情绪：${topN(tally(dissatRows, 'dissatisfaction_emotion'), 3).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);
        lines.push(`  - 不满程度：${topN(tally(dissatRows, 'dissatisfaction_severity'), 3).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);
      }
      const retryRows = bcRows.filter(r => (r.retry_count || 0) >= 3);
      if (retryRows.length) {
        lines.push(`- **高重试 Session 数**：${retryRows.length} 条`);
        lines.push(`  - 主要重试类型：${topN(tally(retryRows, 'retry_type'), 3).map(p => `${p[0]}(${p[1]})`).join(' / ')}`);
      }
    }

    // 典型 case 3 条
    const samples = bcRows.slice(0, 3);
    if (samples.length) {
      lines.push('');
      lines.push('**典型 Case：**');
      for (const s of samples) {
        const promptShort = (s.prompt || '').slice(0, 100).replace(/\n/g, ' ');
        const flags = (s.badcase_flags || []).join(',');
        lines.push(`- \`${s.id}\` [${flags}] · 场景：${s.scene_target || '-'} · ${promptShort}${s.prompt && s.prompt.length > 100 ? '…' : ''}`);
      }
    }
    return lines.join('\n');
  }

  function longTailSection(parsed) {
    if (!parsed || !parsed.long_tail) return '_无数据_';
    const lt = parsed.long_tail;
    const total = parsed.stats.total || 1;
    const lines = [];
    lines.push(`- **能力路径长尾**：共 ${lt.ability_full.length} 项（占比 < ${(lt.threshold * 100).toFixed(0)}%）`);
    if (lt.ability_full.length) {
      lines.push('  - TOP10：' + topN(lt.ability_full, 10).map(p => `${p[0]}(${p[1]})`).join(' / '));
    }
    lines.push(`- **场景标签长尾**：共 ${lt.scene_target.length} 项`);
    if (lt.scene_target.length) {
      lines.push('  - TOP10：' + topN(lt.scene_target, 10).map(p => `${p[0]}(${p[1]})`).join(' / '));
    }
    return lines.join('\n');
  }

  function strategyHints({ t2i, i2i }) {
    const hints = [];
    function check(label, parsed) {
      if (!parsed) return;
      const s = parsed.stats;
      if (s.badcase_rate > 0.10) {
        hints.push(`【${label}】Badcase 占比 ${fmtPct(s.badcase_rate)} 偏高（>10%），建议优先治理。`);
      }
      if (parsed.meta.turn_mode === 'multi' && s.dissat_rate > 0.05) {
        const bcRows = parsed.rows.filter(r => r.is_dissatisfied);
        const tally = new Map();
        for (const r of bcRows) {
          if (r.scene_target_l1) tally.set(r.scene_target_l1, (tally.get(r.scene_target_l1) || 0) + 1);
        }
        const top3 = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(p => p[0]).join(' / ');
        hints.push(`【${label}】用户不满 Session 占比 ${fmtPct(s.dissat_rate)}，主要集中在场景：${top3}，建议重点提升这些场景的多轮一致性与意图识别。`);
      }
      if (parsed.meta.turn_mode === 'multi' && s.retry_high_rate > 0.05) {
        hints.push(`【${label}】高重试 Session 占比 ${fmtPct(s.retry_high_rate)}，提示生成结果与用户预期偏差较大，建议调研重试集中的 prompt 模式。`);
      }
      if (s.low_conf_rate > 0.08) {
        hints.push(`【${label}】低置信占比 ${fmtPct(s.low_conf_rate)} 偏高，建议补充打标 SP 中模糊场景的判定规则。`);
      }
      if (s.not_taggable_rate > 0.05) {
        hints.push(`【${label}】不可评测占比 ${fmtPct(s.not_taggable_rate)}，建议核查 reject_reason 是否存在共性。`);
      }
      const lt = parsed.long_tail;
      if (lt && parsed.stats.ability_full && lt.ability_full.length / Math.max(1, parsed.stats.ability_full.length) > 0.30) {
        hints.push(`【${label}】长尾标签占总标签数 ${(lt.ability_full.length / parsed.stats.ability_full.length * 100).toFixed(0)}%，体系略细碎，建议合并相似末端标签。`);
      }
      if (s.intent_ambiguous_rate > 0.20) {
        hints.push(`【${label}】意图模糊样本占比 ${fmtPct(s.intent_ambiguous_rate)}，建议优化模型 prompt 改写或追问能力。`);
      }
    }
    check('文生图', t2i);
    check('图生图', i2i);
    if (hints.length === 0) return '_当前数据未触发任何策略建议规则。_';
    return hints.map((h, i) => `${i + 1}. ${h}`).join('\n');
  }

  function toMarkdown({ t2i, i2i }) {
    const now = new Date();
    const week = `${now.getFullYear()}-W${String(getWeek(now)).padStart(2, '0')}`;
    const md = `# 元宝生图 Prompt 分布分析报告 — ${week}

> 生成时间：${now.toLocaleString()}
> 数据来源：t2i ${t2i ? t2i.rows.length : 0} 条 · i2i ${i2i ? i2i.rows.length : 0} 条

---

## 1. 数据概览

${overviewTable(t2i, i2i)}

---

## 2. 能力维度分布

### 2.1 文生图 · TOP10 能力路径

${distSection('t2i', t2i, 'ability_full', 10)}

### 2.2 图生图 · TOP10 能力路径

${distSection('i2i', i2i, 'ability_full', 10)}

---

## 3. 场景维度分布

### 3.1 文生图 · TOP10 场景标签

${distSection('t2i', t2i, 'scene_target', 10)}

### 3.2 图生图 · TOP10 场景标签

${distSection('i2i', i2i, 'scene_target', 10)}

---

## 4. Badcase 主要分布 ⚠️

> Badcase 定义：用户不满 / 高重试 / 低置信 / 不可评测 任一命中。

### 4.1 文生图 Badcase

${badcaseSummary(t2i, '文生图')}

### 4.2 图生图 Badcase

${badcaseSummary(i2i, '图生图')}

---

## 5. 长尾标签清单（占比 < 2%）

### 5.1 文生图

${longTailSection(t2i)}

### 5.2 图生图

${longTailSection(i2i)}

---

## 6. 策略建议

${strategyHints({ t2i, i2i })}

---

_报告由 \`tagging-report-writer\` v0.1.0 自动生成_
`;
    return md;
  }

  function getWeek(date) {
    const onejan = new Date(date.getFullYear(), 0, 1);
    return Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  }

  // simple Markdown → HTML
  function mdToHtml(md) {
    const lines = md.split('\n');
    let html = '';
    let inTable = false;
    let tableBuf = [];
    function flushTable() {
      if (!tableBuf.length) return;
      const head = tableBuf[0].split('|').slice(1, -1).map(c => c.trim());
      const rows = tableBuf.slice(2).map(line => line.split('|').slice(1, -1).map(c => c.trim()));
      html += '<table class="trw-table"><thead><tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
      html += rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('');
      html += '</tbody></table>';
      tableBuf = [];
    }
    for (const line of lines) {
      if (line.startsWith('|') && line.endsWith('|')) {
        inTable = true;
        tableBuf.push(line);
        continue;
      }
      if (inTable) { flushTable(); inTable = false; }

      if (/^# /.test(line)) html += `<h1>${line.slice(2)}</h1>`;
      else if (/^## /.test(line)) html += `<h2>${line.slice(3)}</h2>`;
      else if (/^### /.test(line)) html += `<h3>${line.slice(4)}</h3>`;
      else if (line.startsWith('---')) html += '<hr/>';
      else if (line.startsWith('> ')) html += `<blockquote>${line.slice(2)}</blockquote>`;
      else if (/^\d+\. /.test(line)) html += `<div class="trw-li-num">${line}</div>`;
      else if (/^- /.test(line)) html += `<div class="trw-li">${line.slice(2)}</div>`;
      else if (/^  - /.test(line)) html += `<div class="trw-li-sub">${line.trim().slice(2)}</div>`;
      else if (line.trim() === '') html += '<br/>';
      else html += `<p>${line}</p>`;
    }
    if (inTable) flushTable();
    // bold + code
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    return html;
  }

  function render(container, sources, options) {
    options = options || {};
    container.innerHTML = '';
    container.classList.add('trw-root');

    const md = toMarkdown(sources || {});

    // 顶部工具栏
    const tools = document.createElement('div');
    tools.className = 'trw-tools';
    tools.innerHTML = `
      <button class="trw-btn" data-act="dl-md">⬇️ 下载 Markdown</button>
      <button class="trw-btn" data-act="copy">📋 复制全文</button>
      <span class="trw-meta">报告字数 ${md.length}</span>
    `;
    container.appendChild(tools);

    const body = document.createElement('div');
    body.className = 'trw-body';
    body.innerHTML = mdToHtml(md);
    container.appendChild(body);

    tools.querySelector('[data-act="dl-md"]').onclick = () => {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      a.download = `prompt-distribution-report_${stamp}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    tools.querySelector('[data-act="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(md); tools.querySelector('[data-act="copy"]').textContent = '✅ 已复制'; }
      catch (e) { alert('复制失败：' + e.message); }
    };
  }

  if (typeof window !== 'undefined') {
    window.TaggingReportWriter = { render, toMarkdown };
  }
})();
