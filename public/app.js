// Repo Pulse demo page. Vanilla, no build step.
// Every API string reaches the DOM through textContent / createElement only.
'use strict';

(() => {
  // ---- constants -----------------------------------------------------------

  /** Same pattern as the server (src/ingestion/dto.ts NAME_PATTERN). */
  const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
  /** The committed snapshot `npm run db:seed` loads, and the window it covers. */
  const DEMO = { repo: 'dataelement/dsh-desktop', from: '2026-08-31', to: '2026-10-26' };
  const POLL_MS = 2000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** METRIC_NAMES order from src/signals/metric-names.ts: [name, label, unit]. */
  const METRICS = [
    ['prs_opened', 'PRs opened', 'count'],
    ['prs_merged', 'PRs merged', 'count'],
    ['prs_closed_unmerged', 'PRs closed unmerged', 'count'],
    ['time_to_first_review_p50_h', 'Time to first review, median', 'hours'],
    ['time_to_merge_p50_h', 'Time to merge, median', 'hours'],
    ['reviews_submitted', 'Reviews submitted', 'count'],
    ['approvals', 'Approvals', 'count'],
    ['review_concentration_top1', 'Top reviewer share', 'ratio'],
    ['review_concentration_hhi', 'Review concentration (HHI)', 'ratio'],
    ['issues_opened', 'Issues opened', 'count'],
    ['issues_closed', 'Issues closed', 'count'],
    ['issue_time_to_close_p50_h', 'Issue time to close, median', 'hours'],
    ['commits', 'Commits', 'count'],
    ['active_authors', 'Active authors', 'count'],
    ['bus_factor_50', 'Bus factor (50%)', 'count'],
  ];
  const METRIC_LABEL = new Map(METRICS.map(([n, l]) => [n, l]));
  const METRIC_UNIT = new Map(METRICS.map(([n, , u]) => [n, u]));
  const UNIT_SUFFIX = { hours: 'h', count: '', ratio: '', lines: 'lines' };
  // Evidence may cite per-item facts (`<metric>.item`) or ledger-only names (`reviews_given`).
  const baseMetric = (m) => String(m).replace(/\.item$/, '');
  const unitFor = (m) => METRIC_UNIT.get(baseMetric(m)) || 'count';
  const labelFor = (m) => {
    const label = METRIC_LABEL.get(baseMetric(m)) || humanize(baseMetric(m));
    return String(m).endsWith('.item') ? `${label}, single item` : label;
  };

  const $ = (id) => document.getElementById(id);
  const out = { sync: $('sync-out'), insights: $('insights-out'), narrative: $('narrative-out') };
  let pollTimer = null;
  let pollToken = 0; // bumped per sync; a poll from an older sync never renders or re-arms
  let lastJobStatus = null;
  let signalAnchors = new Set();

  // ---- DOM helpers ---------------------------------------------------------

  /** el('p', { className: 'x' }, 'text', childNode) — strings become text nodes. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  /** Only GitHub URLs become links; anything else renders as plain text. */
  function ghLink(url, text) {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) {
      return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
    }
    return el('span', {}, text);
  }

  /** A two-column definition list from [term, value] pairs. */
  function facts(pairs, className) {
    const dl = el('dl', { className: 'facts ' + (className || '') });
    for (const [term, value] of pairs) {
      dl.append(el('div', {}, el('dt', { text: term }), el('dd', {}, String(value))));
    }
    return dl;
  }

  function fmt(value, unit) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (unit === 'hours') return value.toFixed(1);
    if (unit === 'ratio') return value.toFixed(2);
    // Counts are integers; medians and spreads of counts may not be.
    return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
  }

  function withUnit(value, unit) {
    const suffix = UNIT_SUFFIX[unit] || '';
    return suffix ? `${fmt(value, unit)} ${suffix}` : fmt(value, unit);
  }

  const humanize = (s) => String(s).replace(/_/g, ' ');
  const anchorId = (signalId) => 'signal-' + String(signalId).replace(/[^A-Za-z0-9_-]/g, '_');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

  // ---- API -----------------------------------------------------------------

  /** Normalised RFC 9457 problem, also used for client-side validation errors. */
  class Problem extends Error {
    constructor(p) {
      super(p.title);
      this.problem = p;
    }
  }

  async function api(path, init) {
    let res;
    try {
      res = await fetch('/api/v1' + path, {
        ...init,
        headers: { accept: 'application/json, application/problem+json', ...(init && init.headers) },
      });
    } catch (err) {
      throw new Problem({ title: 'Could not reach the server', detail: String(err.message || err) });
    }
    const isJson = /json/.test(res.headers.get('content-type') || '');
    const body = isJson ? await res.json().catch(() => null) : null;
    if (res.ok) return body;
    throw new Problem(
      body && body.title
        ? body
        : { title: `Request failed (HTTP ${res.status})`, detail: res.statusText, status: res.status },
    );
  }

  function repoPath() {
    const raw = $('repo').value.trim();
    const parts = raw.split('/');
    if (parts.length !== 2 || !NAME.test(parts[0]) || !NAME.test(parts[1])) {
      throw new Problem({
        title: 'Check the repository name',
        detail: `Enter it as owner/name, for example anomalyco/opencode. "${raw}" is not valid.`,
      });
    }
    return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
  }

  function windowParams(extra) {
    const q = new URLSearchParams();
    if ($('from').value) q.set('from', $('from').value);
    if ($('to').value) q.set('to', $('to').value);
    q.set('bucket', $('bucket').value);
    q.set('includeBots', String($('include-bots').checked));
    for (const [k, v] of Object.entries(extra || {})) q.set(k, v);
    return q;
  }

  function renderProblem(target, err, hint) {
    const p = err instanceof Problem ? err.problem : { title: 'Unexpected error', detail: String(err) };
    const status = [p.status ? `HTTP ${p.status}` : null, p.requestId ? `request ${p.requestId}` : null]
      .filter(Boolean)
      .join(', ');
    target.replaceChildren(
      el('div', { className: 'problem', role: 'alert' },
        el('p', { className: 'problem-title', text: p.title }),
        p.detail ? el('p', { text: p.detail }) : null,
        hint ? el('p', { text: hint }) : null,
        status ? el('p', { className: 'muted', text: status }) : null),
    );
  }

  /** The page's only live region: announces starts and outcomes, never the ticking timer. */
  function announce(message) {
    const region = $('status');
    region.textContent = '';
    setTimeout(() => (region.textContent = message), 50);
  }

  /** Disables the buttons while `task` runs and marks the output busy. */
  async function busy(buttons, target, message, task) {
    buttons.forEach((b) => (b.disabled = true));
    target.setAttribute('aria-busy', 'true');
    const status = el('p', { className: 'busy', text: message });
    target.replaceChildren(status);
    announce(message);
    const started = Date.now();
    const tick = setInterval(() => {
      status.textContent = `${message} ${Math.round((Date.now() - started) / 1000)} s`;
    }, 1000);
    try {
      await task();
    } finally {
      clearInterval(tick);
      target.removeAttribute('aria-busy');
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  // ---- sync ----------------------------------------------------------------

  function renderJob(job) {
    const c = job.counts || {};
    const done = job.status === 'succeeded' || job.status === 'failed';
    const nodes = [
      el('p', { className: 'job-status' },
        el('span', { className: `badge badge-${job.status}`, text: humanize(job.status) }),
        ` ${job.repository.owner}/${job.repository.name}, ${humanize(job.mode)} sync of ${job.window.from.slice(0, 10)} to ${job.window.to.slice(0, 10)}`),
      facts([
        ['Pull requests', fmt(c.pullRequests)],
        ['Reviews', fmt(c.reviews)],
        ['Issues', fmt(c.issues)],
        ['Commits', fmt(c.commits)],
        ['Rate limit left', fmt(job.rateLimitRemaining)],
      ], 'facts-row'),
    ];
    if (job.error) nodes.push(el('div', { className: 'problem', role: 'alert' }, el('p', { text: job.error })));
    if (job.status === 'succeeded') nodes.push(el('p', { className: 'hint', text: 'Sync finished. Load insights to see the results.' }));
    if (!done) nodes.push(el('p', { className: 'busy', text: 'Checking again every 2 seconds.' }));
    out.sync.replaceChildren(...nodes);
    if (job.status !== lastJobStatus) announce(`Sync ${humanize(job.status)}.`);
    lastJobStatus = job.status;
    return done;
  }

  async function poll(id, token) {
    if (token !== pollToken) return;
    const button = $('sync-btn');
    button.disabled = true;
    try {
      const job = await api(`/sync-jobs/${encodeURIComponent(id)}`);
      if (token !== pollToken) return;
      if (!renderJob(job)) pollTimer = setTimeout(() => poll(id, token), POLL_MS);
    } catch (err) {
      if (token === pollToken) renderProblem(out.sync, err);
    } finally {
      if (token === pollToken) button.disabled = false;
    }
  }

  async function startSync() {
    const token = ++pollToken;
    clearTimeout(pollTimer);
    lastJobStatus = null;
    const button = $('sync-btn');
    button.disabled = true;
    try {
      const body = {};
      if ($('from').value) body.from = $('from').value;
      if ($('to').value) body.to = $('to').value;
      const job = await api(`${repoPath()}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (token !== pollToken) return;
      if (!renderJob(job)) pollTimer = setTimeout(() => poll(job.id, token), POLL_MS);
    } catch (err) {
      if (token !== pollToken) return;
      const type = err instanceof Problem ? String(err.problem.type || '') : '';
      renderProblem(out.sync, err, type.endsWith('github-token-missing')
        ? 'Sync is turned off on this server. Insights and narratives still work for repositories that are already synced.'
        : null);
    } finally {
      if (token === pollToken) button.disabled = false;
    }
  }

  // ---- insights ------------------------------------------------------------

  /** Thin line, no axes, gaps at nulls, the maximum marked. */
  function sparkline(values, label, unit) {
    const W = 96, H = 24, P = 3;
    const known = values.filter((v) => v !== null);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'spark', role: 'img' });
    if (known.length === 0) {
      root.setAttribute('aria-label', `${label}: no data`);
      return root;
    }
    const min = Math.min(...known), max = Math.max(...known);
    const x = (i) => (values.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (values.length - 1));
    const y = (v) => (max === min ? H / 2 : H - P - ((v - min) * (H - 2 * P)) / (max - min));
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    const isolated = values
      .map((v, i) => (v !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null ? i : -1))
      .filter((i) => i >= 0);
    const summary = `${label}: min ${withUnit(min, unit)}, max ${withUnit(max, unit)}`;
    root.setAttribute('aria-label', summary);
    root.append(svg('title', {}));
    root.firstChild.textContent = summary;
    root.append(svg('path', { d: d.trim(), class: 'spark-line' }));
    for (const i of isolated) root.append(svg('circle', { cx: x(i).toFixed(1), cy: y(values[i]).toFixed(1), r: 1.25, class: 'spark-dot' }));
    const at = values.indexOf(max);
    root.append(svg('circle', { cx: x(at).toFixed(1), cy: y(max).toFixed(1), r: 2.5, class: 'spark-max' }));
    return root;
  }

  function renderCoverage(data) {
    const cov = data.coverage;
    const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
    const slug = `${data.repository.owner}/${data.repository.name}`;
    const warnings = [];
    if (cov.partial) warnings.push('Synced data covers only part of this window, so some buckets are incomplete.');
    for (const [kind, label] of [['pullRequests', 'Pull request'], ['issues', 'Issue']]) {
      if (data.availability[kind] !== 'available') warnings.push(`${label} data is unavailable for this repository; those rows show —.`);
    }
    return el('div', { className: 'coverage' },
      el('p', {}, ghLink(data.repository.url, slug),
        `, ${day(data.window.from)} to ${day(data.window.to)}, ${data.bucket === 'day' ? 'daily' : 'weekly'} buckets, ` +
        `bots ${data.includeBots ? 'included' : 'excluded'}. Synced data covers ${day(cov.from)} to ${day(cov.to)}; ` +
        `last synced ${dateTime(cov.lastSyncedAt)}.`),
      warnings.map((w) => el('p', { className: 'notice', text: w })));
  }

  function renderTable(data) {
    const head = el('tr', {}, el('th', { scope: 'col', text: 'Metric' }), el('th', { scope: 'col', text: 'Trend' }));
    for (const b of data.buckets) {
      const uncovered = b.covered === false;
      const th = el('th', { scope: 'col', text: b.key + (b.partial ? '*' : '') + (uncovered ? '!' : '') });
      const notes = [];
      if (b.partial) notes.push('Partial bucket: the window cuts it short');
      if (uncovered) notes.push('Not synced: no data for this bucket, values show —');
      if (notes.length) th.setAttribute('title', notes.join('. '));
      head.append(th);
    }
    const body = el('tbody');
    for (const [name, label, unit] of METRICS) {
      const values = data.buckets.map((b) => (b.metrics[name] === undefined ? null : b.metrics[name]));
      const unitNote = UNIT_SUFFIX[unit] ? ` (${UNIT_SUFFIX[unit]})` : '';
      const row = el('tr', {},
        el('th', { scope: 'row', text: label + unitNote }),
        el('td', { className: 'spark-cell' }, sparkline(values, label, unit)));
      for (const v of values) row.append(el('td', { className: v === null ? 'num null' : 'num', text: fmt(v, unit) }));
      body.append(row);
    }
    const legend = [];
    if (data.buckets.some((b) => b.partial)) legend.push('* partial bucket, cut short by the window.');
    if (data.buckets.some((b) => b.covered === false)) legend.push('! outside the synced range: no data, not zero activity.');
    return el('figure', { className: 'metrics' },
      el('div', { className: 'table-scroll', tabindex: '0', 'aria-label': 'Metrics by bucket, scrollable' },
        el('table', {}, el('thead', {}, head), body)),
      legend.length ? el('figcaption', { className: 'muted', text: legend.join(' ') }) : null);
  }

  function renderSignals(signals) {
    signalAnchors = new Set(signals.map((s) => anchorId(s.id)));
    if (signals.length === 0) {
      return el('p', { className: 'muted', text: 'No signals: every metric stayed within its usual range for this window.' });
    }
    const list = el('ol', { className: 'signals' });
    for (const s of signals) {
      const unit = unitFor(s.metric);
      const b = s.baseline;
      const baseline = b
        ? `Baseline median ${withUnit(b.median, unit)}, scale ${fmt(b.scale, unit)} (${b.scaleSource.toUpperCase()}), from ${b.n} buckets`
        : 'No baseline for this detector';
      const examples = s.examples.length
        ? el('ul', { className: 'examples' }, s.examples.map((e) =>
          el('li', {}, ghLink(e.url, `${e.ref} ${e.title}`),
            ` ${withUnit(e.value, e.unit)}${e.author ? `, by ${e.author}` : ''}`)))
        : null;
      list.append(el('li', { id: anchorId(s.id), className: 'signal' },
        el('p', { className: 'signal-head' },
          el('span', { className: `badge badge-${s.severity}`, text: s.severity === 'high' ? 'High' : 'Moderate' }),
          ' ', el('span', { text: s.description })),
        el('p', { className: 'muted' },
          `${labelFor(s.metric)}, ${s.bucket}${s.entity ? `, ${s.entity}` : ''}: observed ${withUnit(s.observed, unit)}, ` +
          `score ${s.score.toFixed(1)} ${s.direction}. ${baseline}. Detector ${humanize(s.detector)}, id ${s.id}.`),
        examples));
    }
    return list;
  }

  async function loadInsights() {
    let path;
    try {
      path = `${repoPath()}/insights?${windowParams()}`;
    } catch (err) {
      return renderProblem(out.insights, err);
    }
    await busy([$('insights-btn')], out.insights, 'Loading insights…', async () => {
      try {
        const data = await api(path);
        out.insights.replaceChildren(
          renderCoverage(data),
          el('h3', { text: 'Metrics' }),
          data.buckets.length ? renderTable(data) : el('p', { className: 'muted', text: 'No buckets in this window.' }),
          el('h3', { text: `Signals (${data.signals.length})` }),
          renderSignals(data.signals));
        announce(`Insights loaded: ${data.buckets.length} buckets, ${data.signals.length} signals.`);
      } catch (err) {
        renderProblem(out.insights, err);
      }
    });
  }

  // ---- narrative -----------------------------------------------------------

  function confidenceBar(h) {
    const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
    const fill = el('span', { className: 'conf-fill' });
    fill.style.width = pct(h.confidence); // CSSOM, allowed under style-src 'self'
    const marker = el('span', { className: 'conf-model', title: `Model said ${h.model_confidence.toFixed(2)}` });
    marker.style.left = pct(h.model_confidence);
    const direction = h.confidence < h.model_confidence ? 'down' : 'up';
    return el('div', { className: 'conf' },
      el('div', { className: 'conf-track', 'aria-hidden': 'true' }, fill, marker),
      el('p', { className: 'conf-label' },
        `Confidence ${h.confidence.toFixed(2)}`,
        h.confidence === h.model_confidence
          ? ', as stated by the model'
          : `, calibrated ${direction} from the model's ${h.model_confidence.toFixed(2)}`),
      h.adjustments.length
        ? el('ul', { className: 'chips', 'aria-label': 'Calibration adjustments' }, h.adjustments.map((a) => el('li', { text: humanize(a) })))
        : null);
  }

  function evidenceTable(evidence) {
    const rows = evidence.map((e) => {
      const unit = unitFor(e.metric);
      const id = e.signal_id ? anchorId(e.signal_id) : null;
      const signal = !e.signal_id ? '—'
        : signalAnchors.has(id) ? el('a', { href: '#' + id }, e.signal_id) : e.signal_id;
      return el('tr', {},
        el('td', { text: labelFor(e.metric) }),
        el('td', { text: e.bucket || '—' }),
        el('td', { text: e.entity || '—' }),
        el('td', { className: 'num', text: withUnit(e.value, unit) }),
        el('td', { text: e.note }),
        el('td', {}, signal));
    });
    return el('div', { className: 'table-scroll', tabindex: '0', 'aria-label': 'Evidence, scrollable' },
      el('table', { className: 'evidence' },
        el('thead', {}, el('tr', {}, ['Metric', 'Bucket', 'Entity', 'Value', 'Note', 'Signal'].map((t) => el('th', { scope: 'col', className: t === 'Value' ? 'num' : '', text: t })))),
        el('tbody', {}, rows)));
  }

  function renderHypothesis(h) {
    return el('article', { className: 'hypothesis' },
      el('h4', { text: h.statement }),
      confidenceBar(h),
      evidenceTable(h.evidence),
      h.alternative_explanations.length
        ? el('div', {}, el('h5', { text: 'Other explanations' }), el('ul', {}, h.alternative_explanations.map((a) => el('li', { text: a }))))
        : null,
      el('p', { className: 'suggested-check' }, el('strong', { text: 'Check: ' }), h.suggested_check));
  }

  function renderGrounding(g) {
    const rejected = g.rejected.length
      ? el('ul', {}, g.rejected.map((r) => el('li', {},
        `Hypothesis ${r.hypothesisIndex + 1}: ${labelFor(r.evidence.metric)}` +
          `${r.evidence.bucket ? ` ${r.evidence.bucket}` : ''} = ${r.evidence.value}, rejected as ${humanize(r.reason)}` +
          (r.expected !== undefined ? ` (ledger has ${r.expected})` : ''))))
      : el('p', { className: 'muted', text: 'No evidence was rejected.' });
    return el('section', { className: 'grounding', 'aria-label': 'Grounding' },
      el('h4', {}, 'Grounding ', el('span', { className: `badge badge-g-${g.status}`, text: humanize(g.status) })),
      facts([
        ['Dropped hypotheses', g.droppedHypotheses],
        ['Unverified numbers in prose', g.unverifiedNumbers.length ? g.unverifiedNumbers.join(', ') : 'none'],
      ]),
      rejected);
  }

  function renderMeta(n) {
    const u = n.meta.usage;
    return el('section', { className: 'meta', 'aria-label': 'Run details' },
      el('h4', { text: 'Run details' }),
      facts([
        ['Cached', n.cached ? 'yes' : 'no'],
        ['Model', n.meta.model],
        ['Prompt version', n.meta.promptVersion],
        ['Input tokens', fmt(u.inputTokens)],
        ['Output tokens', fmt(u.outputTokens)],
        ['Cache read tokens', fmt(u.cacheReadTokens)],
        ['Cache write tokens', fmt(u.cacheWriteTokens)],
        ['Estimated cost', `$${u.costUsd.toFixed(4)}`],
        ['Tool calls', n.meta.toolCalls],
        ['Turns', n.meta.turns],
        ['Latency', `${(n.meta.latencyMs / 1000).toFixed(1)} s`],
      ], 'facts-grid'));
  }

  function renderNarrative(n) {
    out.narrative.replaceChildren(
      el('p', { className: 'muted', text: `${n.cached ? 'Cached narrative' : 'New narrative'}, generated ${dateTime(n.generatedAt)}.` }),
      el('h3', { className: 'headline', text: n.headline }),
      el('div', { className: 'prose' }, n.narrative.split(/\n{2,}/).map((p) => el('p', { text: p }))),
      n.hypotheses.length
        ? el('div', {}, el('h3', { text: 'Hypotheses' }), n.hypotheses.map(renderHypothesis))
        : el('p', { className: 'muted', text: 'No hypothesis survived grounding.' }),
      n.data_caveats.length
        ? el('div', {}, el('h3', { text: 'Data caveats' }), el('ul', {}, n.data_caveats.map((c) => el('li', { text: c }))))
        : null,
      el('div', { className: 'audit' }, renderGrounding(n.grounding), renderMeta(n)));
  }

  async function loadNarrative(refresh) {
    let path;
    try {
      path = `${repoPath()}/narrative?${windowParams({ refresh: String(refresh) })}`;
    } catch (err) {
      return renderProblem(out.narrative, err);
    }
    const message = refresh ? 'Generating a new narrative, usually 15 to 40 seconds…' : 'Fetching the narrative. If none is cached, generating one takes 15 to 40 seconds…';
    await busy([$('narrative-btn'), $('regenerate-btn')], out.narrative, message, async () => {
      try {
        renderNarrative(await api(path));
        announce('Narrative ready.');
      } catch (err) {
        renderProblem(out.narrative, err);
      }
    });
  }

  // ---- wiring --------------------------------------------------------------

  $('repo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void startSync();
  });
  $('window-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void loadInsights();
  });
  $('demo-repo').addEventListener('click', () => {
    $('repo').value = DEMO.repo;
    $('from').value = DEMO.from;
    $('to').value = DEMO.to;
    $('repo').focus();
  });
  $('narrative-btn').addEventListener('click', () => void loadNarrative(false));
  $('regenerate-btn').addEventListener('click', () => void loadNarrative(true));
})();
