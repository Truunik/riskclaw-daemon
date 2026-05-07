const form = document.getElementById('preflight-form');
const output = document.getElementById('output');
const btn = document.getElementById('run-btn');
const grid = document.getElementById('integration-grid');
const scoreForm = document.getElementById('score-form');
const scoreOutput = document.getElementById('score-output');
const scoreBtn = document.getElementById('score-btn');

const DECISION_CLASS = { ALLOW: 'ok', WARN: 'warn', BLOCK: 'block' };
const RECOMMENDATION_CLASS = { ALLOW: 'ok', WARN: 'warn', BLOCK: 'block' };

function highlight(json) {
  // Returns HTML with decision/risk/reasons colorized; otherwise plain.
  const j = JSON.parse(json);
  const verdict = j.verdict ?? j;
  const decision = verdict?.decision;
  const score = verdict?.riskScoreBps;
  const cls = DECISION_CLASS[decision] ?? '';
  const head = decision
    ? `<div class="verdict-line"><span class="${cls}">${decision}</span> · ${score} bps</div>\n`
    : '';
  return head + escape(JSON.stringify(j, null, 2));
}

function escape(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const body = {
    protocol: 'kumbaya',
    chainId: Number(fd.get('chainId')),
    pool: String(fd.get('pool')).trim(),
    amountIn: String(fd.get('amountIn')).trim(),
    amountOutMinimum: String(fd.get('amountOutMinimum')).trim(),
  };

  btn.disabled = true;
  btn.textContent = 'running…';
  output.classList.remove('error');
  output.textContent = `// POST /api/preflight\n${JSON.stringify(body, null, 2)}\n\n// awaiting verdict…`;

  try {
    const res = await fetch('/api/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      output.classList.add('error');
      output.textContent = `// HTTP ${res.status}\n${text}`;
      return;
    }
    output.innerHTML = highlight(text);
  } catch (err) {
    output.classList.add('error');
    output.textContent = `// network error\n${err.message ?? err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'run preflight';
  }
});

if (scoreForm) {
  scoreForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(scoreForm);
    const body = {
      protocol: String(fd.get('protocol')),
      chainId: Number(fd.get('chainId')),
      pool: String(fd.get('pool')).trim(),
      amountIn: String(fd.get('amountIn') ?? '1000000').trim(),
    };
    scoreBtn.disabled = true;
    scoreBtn.textContent = 'scoring…';
    scoreOutput.classList.remove('error');
    scoreOutput.textContent = `// POST /api/score\n${JSON.stringify(body, null, 2)}\n\n// awaiting score…`;
    try {
      const res = await fetch('/api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        scoreOutput.classList.add('error');
        scoreOutput.textContent = `// HTTP ${res.status}\n${text}`;
        return;
      }
      scoreOutput.innerHTML = highlightScore(text);
    } catch (err) {
      scoreOutput.classList.add('error');
      scoreOutput.textContent = `// network error\n${err.message ?? err}`;
    } finally {
      scoreBtn.disabled = false;
      scoreBtn.textContent = 'score pool';
    }
  });
}

function highlightScore(json) {
  const j = JSON.parse(json);
  const r = j.result ?? j;
  const rec = r?.recommendation;
  const score = r?.routeRiskBps;
  const cls = RECOMMENDATION_CLASS[rec] ?? '';
  const head = rec
    ? `<div class="verdict-line"><span class="${cls}">${rec}</span> · ${score} bps · ${r.perPool?.length ?? 0} pool(s)</div>\n`
    : '';
  return head + escape(JSON.stringify(j, null, 2));
}

async function loadIntegrations() {
  try {
    const res = await fetch('/api/integrations');
    const { integrations } = await res.json();
    grid.innerHTML = integrations.map(i => `
      <a class="card" href="/integrations/${i.name}">
        <div class="card-head">
          <h3>${i.display}</h3>
          <span class="badge ${i.status === 'live' ? 'live' : 'scoring'}">${i.status}</span>
        </div>
        <div class="kind">${i.kind} · chains: ${i.chains.join(', ')}</div>
        <strong>catches</strong>
        <ul>${i.catches.map(c => `<li>${escape(c)}</li>`).join('')}</ul>
        <div class="surfaces">surfaces: ${i.surfaces.join(' · ')}</div>
        ${i.notes ? `<div class="notes">${escape(i.notes)}</div>` : ''}
        <div class="card-cta">read full surface →</div>
      </a>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="card"><div class="kind block">failed to load integrations: ${err.message ?? err}</div></div>`;
  }
}

loadIntegrations();

(function animateBubbles() {
  const bubbles = document.querySelectorAll('#bubbles-svg .bubble');
  if (!bubbles.length) return;

  const state = [...bubbles].map(g => ({
    g,
    baseX: Number(g.dataset.baseX),
    baseY: Number(g.dataset.baseY),
    fx: Number(g.dataset.fx),
    fy: Number(g.dataset.fy),
    px: Number(g.dataset.px),
    py: Number(g.dataset.py),
    scale: 1,
    targetScale: 1,
  }));

  function frame(t) {
    for (const s of state) {
      const dx = Math.sin(t * s.fx + s.px) * 8;
      const dy = Math.cos(t * s.fy + s.py) * 6;
      s.scale += (s.targetScale - s.scale) * 0.18;
      s.g.setAttribute(
        'transform',
        `translate(${(s.baseX + dx).toFixed(2)},${(s.baseY + dy).toFixed(2)}) scale(${s.scale.toFixed(3)})`,
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  for (const s of state) {
    s.g.addEventListener('mouseenter', () => { s.targetScale = 1.07; });
    s.g.addEventListener('mouseleave', () => { s.targetScale = 1; });
    s.g.addEventListener('click', () => {
      const href = s.g.dataset.href;
      if (!href) return;
      if (s.g.dataset.external) window.open(href, '_blank', 'noopener');
      else window.location.href = href;
    });
  }
})();
