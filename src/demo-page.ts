/**
 * The demo UI: one self-contained page, vanilla JS, no build step, served by
 * demo-server.ts. Kept as a template string so tsc-only builds ship it.
 */
export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grainpack demo</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b23; --panel2: #1c2330; --line: #2a3342;
    --text: #e6ebf2; --dim: #8b98ab; --accent: #5eb1ff; --good: #4fd48b;
    --warn: #f2b84b; --bad: #ff7a76; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  header { padding: 18px 24px; border-bottom: 1px solid var(--line);
           display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 20px; margin: 0; }
  header .sub { color: var(--dim); }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 24px 60px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 14px 0 22px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 10px 16px; min-width: 130px; }
  .stat b { display: block; font-size: 20px; }
  .stat span { color: var(--dim); font-size: 12.5px; }
  .qrow { display: flex; gap: 10px; margin-bottom: 10px; }
  input[type=text] { flex: 1; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; font-size: 15px; }
  button { background: var(--accent); color: #06121f; border: 0; border-radius: 10px;
           padding: 12px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
  .chip { background: var(--panel); border: 1px solid var(--line); color: var(--dim);
          border-radius: 999px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
  .chip:hover { color: var(--text); border-color: var(--accent); }
  .controls { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .seg button { background: var(--panel); color: var(--dim); border-radius: 0; font-weight: 500;
                padding: 8px 14px; font-size: 13.5px; }
  .seg button.on { background: var(--panel2); color: var(--text); font-weight: 700; }
  .seg.strategy button.on { color: var(--accent); }
  .label { color: var(--dim); font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
           padding: 16px; overflow-x: auto; }
  .panel h2 { margin: 0 0 10px; font-size: 14px; text-transform: uppercase;
              letter-spacing: .06em; color: var(--dim); }
  .full { grid-column: 1 / -1; }
  .rec { font-family: var(--mono); font-size: 12.5px; padding: 4px 6px; border-radius: 6px;
         cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .rec:hover { background: var(--panel2); }
  .rec .score { color: var(--dim); min-width: 44px; }
  .rec .why { color: var(--dim); font-size: 11.5px; }
  .tag { font-size: 10.5px; border-radius: 5px; padding: 1px 6px; }
  .tag.seed { background: #12395f; color: #9ed0ff; } .tag.traversal { background: #1d3b2c; color: #9fe8c0; }
  .tag.sibling { background: #4a3413; color: #ffd58a; } .tag.comparison { background: #3f2350; color: #dfb3ff; }
  .tag.lexical { background: #333a45; color: #b7c2d0; }
  .tokens { display: flex; align-items: center; gap: 14px; margin: 8px 0 16px; flex-wrap: wrap; }
  .bar { height: 14px; border-radius: 7px; background: var(--panel2); overflow: hidden; flex: 1; min-width: 200px; }
  .bar i { display: block; height: 100%; background: var(--good); }
  .big { font-size: 22px; font-weight: 700; }
  .arrow { color: var(--dim); font-size: 20px; }
  #answer { white-space: pre-wrap; }
  #answer .cite { color: var(--accent); cursor: pointer; font-family: var(--mono); font-size: 13px; }
  .note { color: var(--warn); font-size: 13.5px; }
  .flatnote { border-left: 3px solid var(--warn); padding: 8px 12px; color: var(--dim);
              font-size: 13.5px; margin-top: 10px; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line);
           border-radius: 12px; max-width: 640px; width: 90%; }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  dialog pre { font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; }
  .muted { color: var(--dim); }
  details pre { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>grainpack</h1>
  <span class="sub">relationship-aware context packing — ask a question, watch the graph narrow the evidence</span>
</header>
<main>
  <div class="stats" id="stats"></div>

  <div class="qrow">
    <input id="q" type="text" placeholder="Ask a question about this dataset…">
    <button id="go">Ask</button>
  </div>
  <div class="chips" id="chips"></div>

  <div class="controls">
    <span class="label">Packing:</span>
    <span class="seg" id="modes">
      <button data-mode="broad">Broad</button>
      <button data-mode="balanced" class="on">Balanced</button>
      <button data-mode="aggressive">Aggressive</button>
    </span>
    <span class="label">Retrieval:</span>
    <span class="seg strategy" id="strategies">
      <button data-strategy="graph" class="on">Graph (grainpack)</button>
      <button data-strategy="flat">Flat baseline</button>
    </span>
  </div>

  <div class="tokens" id="tokens" style="display:none">
    <span><span class="big" id="tokBefore"></span><br><span class="label">est. tokens, full dataset</span></span>
    <span class="arrow">→</span>
    <span><span class="big" id="tokAfter"></span><br><span class="label" id="tokAfterLabel">est. tokens sent to the model</span></span>
    <div class="bar"><i id="tokBar" style="width:0%"></i></div>
    <span class="big" id="tokPct" style="color:var(--good)"></span>
  </div>

  <div class="grid" id="results" style="display:none">
    <div class="panel">
      <h2>Seeds — what the question resolved to</h2>
      <div id="seeds"></div>
    </div>
    <div class="panel">
      <h2>Excluded (<span id="exclCount"></span>)</h2>
      <div id="excluded"></div>
    </div>
    <div class="panel full">
      <h2>Selected context (<span id="selCount"></span> records)</h2>
      <div id="selected"></div>
    </div>
    <div class="panel full" id="answerPanel" style="display:none">
      <h2 id="answerTitle">Grounded answer</h2>
      <div id="answer"></div>
      <div id="flatnote"></div>
    </div>
    <div class="panel full">
      <details><summary class="muted">Rendered prompt (exactly what the model receives)</summary><pre id="prompt"></pre></details>
    </div>
  </div>
</main>
<dialog id="dlg"><div id="dlgBody"></div><form method="dialog" style="margin-top:12px"><button>Close</button></form></dialog>
<script>
let mode = 'balanced', strategy = 'graph', busy = false, overview = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => n >= 1000 ? (n/1000).toFixed(n >= 100000 ? 0 : 1) + 'K' : String(n);

async function init() {
  overview = await (await fetch('/api/overview')).json();
  $('stats').innerHTML =
    stat(fmt(overview.records), 'records') + stat(fmt(overview.edges), 'relationships') +
    stat('~' + fmt(overview.tokensEstimate), 'est. tokens if sent whole') +
    Object.entries(overview.typeCounts).map(([t,n]) => stat(fmt(n), t)).join('');
  $('chips').innerHTML = overview.suggestedQuestions
    .map((q) => '<span class="chip">' + esc(q) + '</span>').join('');
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { $('q').value = c.textContent; run(); }));
}
const stat = (b, s) => '<div class="stat"><b>' + b + '</b><span>' + esc(s) + '</span></div>';

$('modes').addEventListener('click', (e) => {
  if (!e.target.dataset.mode) return;
  mode = e.target.dataset.mode;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b === e.target));
  if ($('q').value.trim()) run();
});
$('strategies').addEventListener('click', (e) => {
  if (!e.target.dataset.strategy) return;
  strategy = e.target.dataset.strategy;
  document.querySelectorAll('#strategies button').forEach((b) => b.classList.toggle('on', b === e.target));
  if ($('q').value.trim()) run();
});
$('go').addEventListener('click', run);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

async function run() {
  const question = $('q').value.trim();
  if (!question || busy) return;
  busy = true; $('go').disabled = true;
  try {
    const endpoint = overview.hasApiKey ? '/api/ask' : '/api/pack';
    $('go').textContent = overview.hasApiKey ? 'Thinking…' : 'Packing…';
    const res = await (await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, mode, strategy }),
    })).json();
    if (res.error) throw new Error(res.error);
    show(res);
  } catch (err) {
    alert(err.message);
  } finally {
    busy = false; $('go').disabled = false; $('go').textContent = 'Ask';
  }
}

function show(res) {
  const pkg = res.package, labels = res.labels || {};
  $('results').style.display = ''; $('tokens').style.display = '';
  $('tokBefore').textContent = '~' + fmt(pkg.dataset.tokensEstimate);
  $('tokAfter').textContent = '~' + fmt(pkg.stats.tokensAfter);
  $('tokPct').textContent = '−' + pkg.stats.reductionPct + '%';
  $('tokBar').style.width = Math.max(1, 100 - pkg.stats.reductionPct) + '%';

  $('seeds').innerHTML = pkg.seeds.length
    ? pkg.seeds.map((s) => rec(s.id, labels[s.id], s.score, 'seed', esc(s.matchedOn))).join('')
    : '<span class="muted">' + (pkg.strategy === 'flat'
        ? 'Flat baseline: no resolution, no traversal — every record ranked by keyword overlap alone.'
        : 'No entities resolved from the question.') + '</span>';
  $('selCount').textContent = pkg.stats.selected;
  $('selected').innerHTML = pkg.selected.map((s) =>
    rec(s.id, labels[s.id], s.score, s.reason, via(s))).join('');
  $('exclCount').textContent = pkg.stats.excluded + ' of ' + pkg.stats.considered + ' considered';
  $('excluded').innerHTML = pkg.excluded.slice(0, 40).map((x) =>
    rec(x.id, labels[x.id], x.score, null, esc(x.reason))).join('') +
    (pkg.excluded.length > 40 ? '<div class="muted" style="padding:4px 6px">…and ' + (pkg.excluded.length - 40) + ' more</div>' : '');
  $('prompt').textContent = pkg.prompt;

  const ap = $('answerPanel');
  if (res.answer) {
    ap.style.display = '';
    $('answerTitle').textContent = pkg.strategy === 'flat' ? 'Answer from flat retrieval' : 'Grounded answer';
    $('answer').innerHTML = esc(res.answer).replace(/\\[([A-Za-z0-9_.:@+-]+)\\]/g,
      (m, id) => '<span class="cite" data-id="' + id + '">[' + id + ']</span>');
    document.querySelectorAll('#answer .cite').forEach((c) =>
      c.addEventListener('click', () => inspect(c.dataset.id)));
    $('flatnote').innerHTML = pkg.strategy === 'flat'
      ? '<div class="flatnote">This answer was produced from keyword-ranked records with no relationship context. Switch to <b>Graph</b> and ask again to see what the same data says at the right grain.</div>' : '';
  } else if (res.note) {
    ap.style.display = '';
    $('answerTitle').textContent = 'Answer step skipped';
    $('answer').innerHTML = '<span class="note">' + esc(res.note) + '</span>';
    $('flatnote').innerHTML = '';
  } else ap.style.display = 'none';
}

const via = (s) => s.via.map((v) =>
  v.sharedNeighbor ? 'shares ' + esc(v.sharedNeighbor) + ' via ' + esc(v.edge)
                   : esc(v.from || '') + ' −' + esc(v.edge) + '→').join(' · ');
function rec(id, label, score, reason, why) {
  return '<div class="rec" onclick="inspect(\\'' + id + '\\')">' +
    '<span class="score">' + Number(score).toFixed(2) + '</span>' +
    (reason ? '<span class="tag ' + reason + '">' + reason + '</span>' : '') +
    '<span>' + esc(label || id) + '</span>' +
    (why ? '<span class="why">' + why + '</span>' : '') + '</div>';
}

async function inspect(id) {
  const res = await (await fetch('/api/entity/' + encodeURIComponent(id))).json();
  if (res.error) return;
  $('dlgBody').innerHTML = '<h3 style="margin-top:0">' + esc(res.label) +
    ' <span class="muted">(' + esc(res.entity.type) + ' · ' + esc(id) + ')</span></h3>' +
    '<pre>' + esc(JSON.stringify(res.entity.fields, null, 2)) + '</pre>' +
    '<h4>Relationships</h4>' +
    res.neighbors.map((n) => '<div class="rec" onclick="inspect(\\'' + n.other + '\\')">' +
      '<span class="why">' + (n.direction === 'out' ? '−' + esc(n.edge) + '→' : '←' + esc(n.edge) + '−') + '</span>' +
      '<span>' + esc(n.label) + '</span><span class="why">' + esc(n.type) + '</span></div>').join('');
  $('dlg').showModal();
}
init();
</script>
</body>
</html>`;
