/**
 * tagging-llm-analyst v0.1.0
 * 调用 OpenAI 兼容 LLM 生成智能分析报告
 * 暴露：window.TaggingLLMAnalyst
 *   .analyze({ sources, config, onChunk, onDone, onError }) → AbortController
 *   .renderConfigPanel(container, {current, onSave})
 *   .getConfig() / .setConfig(c)
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tagging_llm_config_v1';
  const DEFAULTS = {
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    streaming: true,
  };

  function getConfig() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? Object.assign({}, DEFAULTS, JSON.parse(s)) : Object.assign({}, DEFAULTS);
    } catch { return Object.assign({}, DEFAULTS); }
  }
  function setConfig(cfg) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { }
  }

  function stripJsonFence(s) {
    if (typeof s !== 'string') return '';
    return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  function safeJsonParse(s) {
    try { return JSON.parse(stripJsonFence(s)); } catch { return null; }
  }

  // ---------- summary builder ----------
  function buildSummary(sources) {
    const lines = [];
    function block(label, parsed) {
      if (!parsed) return;
      const s = parsed.stats;
      const total = s.total;
      lines.push(`\n========== ${label} ==========`);
      lines.push(`数据类型: ${parsed.meta.data_type} / ${parsed.meta.image_mode} / ${parsed.meta.turn_mode}`);
      lines.push(`样本数: ${total}`);
      lines.push(`Badcase: ${s.badcase} (${(s.badcase_rate * 100).toFixed(2)}%)`);
      if (parsed.meta.turn_mode === 'multi') {
        lines.push(`不满 Session: ${s.dissat} (${(s.dissat_rate * 100).toFixed(2)}%)`);
        lines.push(`高重试 Session(>=3): ${s.retry_high} (${(s.retry_high_rate * 100).toFixed(2)}%)`);
        lines.push(`意图模糊: ${(s.intent_ambiguous_rate * 100).toFixed(2)}%`);
        lines.push(`平均轮次: ${s.avg_turn.toFixed(2)}`);
      }
      if (s.low_conf) lines.push(`低置信: ${s.low_conf} (${(s.low_conf_rate * 100).toFixed(2)}%)`);
      if (s.not_taggable) lines.push(`不可评测: ${s.not_taggable} (${(s.not_taggable_rate * 100).toFixed(2)}%)`);
      lines.push(`多图输出: ${s.multi_image_output} (${(s.multi_image_rate * 100).toFixed(2)}%)`);

      function dist(title, arr, n) {
        if (!arr || !arr.length) return;
        lines.push(`\n[${title} TOP${n}]`);
        arr.slice(0, n).filter(([k]) => k !== '').forEach(([k, c]) => {
          lines.push(`  - ${k}: ${c} (${(c / total * 100).toFixed(2)}%)`);
        });
      }
      dist('能力 L1 分布', s.ability_l1, 10);
      dist('能力路径 TOP', s.ability_full, 10);
      dist('场景 L1 分布', s.scene_target_l1, 10);
      dist('完整场景标签 TOP', s.scene_target, 10);
      dist('输出形态分布', s.output_form, 6);
      dist('搜索需求分布', s.search_need, 6);
      if (parsed.meta.turn_mode === 'multi') {
        dist('意图清晰度', s.intent_clarity, 4);
        dist('表达型态', s.expression_type, 6);
        dist('反馈情绪 (不满集合)', s.dissat_emotion, 5);
        dist('不满程度', s.dissat_severity, 5);
        dist('重试类型', s.retry_type, 5);
      }

      // badcase 子集分布
      const bcRows = parsed.rows.filter(r => r.is_badcase);
      if (bcRows.length) {
        lines.push(`\n[Badcase 子集分布]`);
        const tally = (rows, key) => {
          const m = new Map();
          for (const r of rows) {
            const v = r[key]; if (!v) continue;
            m.set(v, (m.get(v) || 0) + 1);
          }
          return [...m.entries()].sort((a, b) => b[1] - a[1]);
        };
        const aL1 = tally(bcRows, 'ability_l1').slice(0, 5);
        const sL1 = tally(bcRows, 'scene_target_l1').slice(0, 5);
        if (s.badcase_flags && s.badcase_flags.length) {
          lines.push(`  flags: ${s.badcase_flags.map(p => `${p[0]}(${p[1]})`).join(', ')}`);
        }
        if (aL1.length) lines.push(`  集中能力 L1: ${aL1.map(p => `${p[0]}(${p[1]})`).join(', ')}`);
        if (sL1.length) lines.push(`  集中场景 L1: ${sL1.map(p => `${p[0]}(${p[1]})`).join(', ')}`);
      }

      // 长尾
      const lt = parsed.long_tail;
      if (lt) {
        lines.push(`\n[长尾标签 (占比<2%)]`);
        lines.push(`  能力路径长尾共 ${lt.ability_full.length} 项, TOP10: ${lt.ability_full.slice(0, 10).map(p => `${p[0]}(${p[1]})`).join(', ')}`);
        lines.push(`  场景标签长尾共 ${lt.scene_target.length} 项, TOP10: ${lt.scene_target.slice(0, 10).map(p => `${p[0]}(${p[1]})`).join(', ')}`);
      }
    }
    if (sources.t2i) block('文生图 (t2i)', sources.t2i);
    if (sources.i2i) block('图生图 (i2i)', sources.i2i);
    return lines.join('\n');
  }

  const SYSTEM_PROMPT = `你是一位资深的多模态生图（文生图 / 图生图）评测分析师。
用户提交了一份打标分布数据的统计摘要，请基于数据写一份分析报告。

要求：
1. 用 Markdown 格式输出，必须遵循以下 6 段结构：
   ## 1. 总体观察
   ## 2. 能力分布洞察
   ## 3. 场景分布洞察
   ## 4. Badcase 根因猜想
   ## 5. 长尾标签解读
   ## 6. 策略建议（3-5 条，每条具体到能落地）
2. 必须基于用户给的具体数据写出"具体的"洞察，不要套话。
   反例：「建议优化模型」「需要持续关注」
   正例：「图像编辑→局部编辑→人物属性编辑 在 Badcase 中占 38%，远高于全局 12%，*(猜想)* 可能因为肤色编辑误判女性场景的多色块」
3. 区分"事实陈述"与"猜想"，所有猜想加 *(猜想)* 标记。
4. 数字必须真实引用用户数据，不要编造数字。
5. 中文回答，简洁但信息密度高。每段控制在 100-300 字。
6. 报告开头不要客套，直接进入第 1 段。`;

  // ---------- LLM call ----------
  async function analyze({ sources, config, onChunk, onDone, onError }) {
    config = config || getConfig();
    const summary = buildSummary(sources || {});
    const userMsg = `请基于以下打标数据统计摘要，按 6 段结构生成中文分析报告：\n\n${summary}`;

    const ctrl = new AbortController();

    const url = (config.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: config.model || DEFAULTS.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: config.temperature == null ? 0.3 : Number(config.temperature),
      stream: !!config.streaming,
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (config.apiKey || ''),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      let full = '';
      if (config.streaming && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                full += delta;
                onChunk && onChunk(delta);
              }
            } catch { /* skip */ }
          }
        }
      } else {
        const json = await res.json();
        full = json.choices?.[0]?.message?.content || '';
        if (full) onChunk && onChunk(full);
      }

      onDone && onDone(full);
    } catch (e) {
      if (e.name === 'AbortError') return;
      onError && onError(e);
    }

    return ctrl;
  }

  // ---------- KPI suggestion ----------
  async function suggestKpiCards({ parsed, config }) {
    config = config || getConfig();
    if (!config.apiKey) throw new Error('未配置 LLM API Key');
    if (!parsed || !parsed.stats) throw new Error('缺少 parsed 数据');

    const src = { parsed };
    const summary = buildSummary({ [parsed.meta?.data_type || 'dataset']: parsed });
    const prompt = `你是可视化看板的数据分析助手。请基于下面的统计摘要，推荐“顶部大数字 KPI 卡片”。

要求：
1) 必须返回 JSON，不要返回 markdown，不要解释说明。
2) JSON 结构必须是：
{
  "mode": "badcase" | "label_share",
  "cards": [
    { "label": "xxx", "value": "xxx", "sub": "xxx", "tone": "danger|warn|info|neutral|ok" }
  ]
}
3) cards 返回 4~6 张；value 尽量是占比或关键计数；语言中文。
4) 如果 badcase 信号弱（badcase_rate < 0.01），优先 mode=label_share，聚焦标签占比。
5) 只使用摘要中的真实数字，不编造。`;

    const url = (config.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: config.model || DEFAULTS.model,
      temperature: 0.1,
      stream: false,
      messages: [
        { role: 'system', content: '你是严谨的 JSON 生成器，只输出合法 JSON。' },
        { role: 'user', content: prompt + '\n\n统计摘要如下：\n' + summary },
      ],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (config.apiKey || ''),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 180)}`);
    }
    const out = await res.json();
    const text = out.choices?.[0]?.message?.content || '';
    const parsedJson = safeJsonParse(text);
    if (!parsedJson || !Array.isArray(parsedJson.cards) || !parsedJson.cards.length) {
      throw new Error('LLM 返回无法解析为 KPI JSON');
    }
    return parsedJson;
  }

  // ---------- config panel ----------
  function renderConfigPanel(container, opts) {
    opts = opts || {};
    const cur = opts.current || getConfig();
    container.innerHTML = `
      <div class="llm-cfg">
        <div class="llm-cfg-row">
          <label>API Base</label>
          <input type="text" data-k="apiBase" value="${escAttr(cur.apiBase)}" placeholder="https://api.openai.com/v1" />
          <small>OpenAI 兼容地址，可填 deepseek / 通义 / 自部署 vLLM 等</small>
        </div>
        <div class="llm-cfg-row">
          <label>API Key</label>
          <input type="password" data-k="apiKey" value="${escAttr(cur.apiKey)}" placeholder="sk-..." />
          <small>仅保存在本机 localStorage，不会上传</small>
        </div>
        <div class="llm-cfg-row">
          <label>Model</label>
          <input type="text" data-k="model" value="${escAttr(cur.model)}" placeholder="gpt-4o-mini" />
        </div>
        <div class="llm-cfg-row">
          <label>Temperature</label>
          <input type="number" min="0" max="2" step="0.1" data-k="temperature" value="${escAttr(cur.temperature)}" />
        </div>
        <div class="llm-cfg-row">
          <label>流式输出</label>
          <input type="checkbox" data-k="streaming" ${cur.streaming ? 'checked' : ''} />
        </div>
        <div class="llm-cfg-actions">
          <button data-act="save">💾 保存配置</button>
          <button data-act="test">🔌 测试连通</button>
          <span class="llm-cfg-msg" data-msg></span>
        </div>
      </div>
    `;

    function readForm() {
      const o = {};
      container.querySelectorAll('[data-k]').forEach(inp => {
        const k = inp.dataset.k;
        if (inp.type === 'checkbox') o[k] = inp.checked;
        else if (inp.type === 'number') o[k] = Number(inp.value);
        else o[k] = inp.value;
      });
      return o;
    }
    const msg = container.querySelector('[data-msg]');
    container.querySelector('[data-act="save"]').onclick = () => {
      const cfg = readForm();
      setConfig(cfg);
      msg.textContent = '✅ 已保存到本机';
      setTimeout(() => msg.textContent = '', 2500);
      opts.onSave && opts.onSave(cfg);
    };
    container.querySelector('[data-act="test"]').onclick = async () => {
      const cfg = readForm();
      msg.textContent = '⏳ 测试中...';
      try {
        const url = cfg.apiBase.replace(/\/+$/, '') + '/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
        });
        if (res.ok) { msg.textContent = '✅ 连通正常'; }
        else { msg.textContent = '❌ ' + res.status + ' ' + (await res.text()).slice(0, 100); }
      } catch (e) {
        msg.textContent = '❌ ' + e.message;
      }
    };
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }

  if (typeof window !== 'undefined') {
    window.TaggingLLMAnalyst = {
      analyze,
      suggestKpiCards,
      renderConfigPanel,
      getConfig,
      setConfig,
      buildSummary,
      SYSTEM_PROMPT,
    };
  }
})();
