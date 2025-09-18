// app.js
(() => {
  const TSV_PATH = 'reviews_test.tsv';
  const MODEL_URL = 'https://api-inference.huggingface.co/models/siebert/sentiment-roberta-large-english';

  const statusEl = document.getElementById('status');
  const randomBtn = document.getElementById('randomBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const hfTokenInput = document.getElementById('hfToken');
  const reviewArea = document.getElementById('reviewArea');
  const reviewTextEl = document.getElementById('reviewText');
  const sentIcon = document.getElementById('sentIcon');
  const labelText = document.getElementById('labelText');
  const scoreText = document.getElementById('scoreText');
  const errorEl = document.getElementById('error');

  let reviews = []; // array of strings

  function setStatus(msg, muted = true) {
    statusEl.textContent = msg;
    statusEl.style.color = muted ? '' : '';
  }

  function showError(msg) {
    errorEl.style.display = 'block';
    errorEl.textContent = msg;
  }

  function clearError() {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  function setIcon(type) {
    // type: 'positive' | 'negative' | 'neutral' | 'loading' | 'idle'
    sentIcon.className = 'icon';
    if (type === 'positive') {
      sentIcon.innerHTML = '<i class="fa-solid fa-thumbs-up" style="color:var(--success)"></i>';
    } else if (type === 'negative') {
      sentIcon.innerHTML = '<i class="fa-solid fa-thumbs-down" style="color:var(--danger)"></i>';
    } else if (type === 'neutral') {
      sentIcon.innerHTML = '<i class="fa-solid fa-question" style="color:var(--neutral)"></i>';
    } else if (type === 'loading') {
      sentIcon.innerHTML = '<i class="fa-solid fa-spinner fa-pulse" style="color:var(--muted)"></i>';
    } else {
      sentIcon.innerHTML = '<i class="fa-solid fa-comment" style="color:var(--muted)"></i>';
    }
  }

  async function fetchAndParseTSV() {
    setStatus('Fetching reviews_test.tsv...');
    clearError();
    reviewArea.style.display = 'none';
    try {
      const res = await fetch(TSV_PATH);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${TSV_PATH}: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      setStatus('Parsing TSV with Papa Parse...');
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors && parsed.errors.length) {
        // Some parse errors may be recoverable; show them as warnings but continue if data present
        console.warn('PapaParse errors:', parsed.errors);
      }
      const data = parsed.data || [];
      // Accept either column named 'text' or 'Text' (case-insensitive)
      const lowerKeys = data.length ? Object.keys(data[0]).map(k => k.toLowerCase()) : [];
      let textKey = null;
      if (lowerKeys.includes('text')) {
        // find actual key name
        textKey = Object.keys(data[0]).find(k => k.toLowerCase() === 'text');
      }

      if (!textKey) {
        throw new Error('TSV does not contain a "text" column (case-insensitive).');
      }

      reviews = data.map(row => (row[textKey] != null ? String(row[textKey]) : '')).filter(t => t.trim().length > 0);

      if (!reviews.length) {
        throw new Error('No non-empty reviews found in "text" column.');
      }

      setStatus(`Loaded ${reviews.length} reviews. Ready.`);
      reviewArea.style.display = 'block';
      setIcon('idle');
      labelText.textContent = 'Label: —';
      scoreText.textContent = 'Score: —';
      reviewTextEl.textContent = 'Click "Analyze Random Review" to start.';
    } catch (err) {
      setStatus('Error loading TSV.');
      showError(err.message || String(err));
      console.error(err);
    }
  }

  function pickRandomReview() {
    if (!reviews.length) return null;
    const idx = Math.floor(Math.random() * reviews.length);
    return reviews[idx];
  }

  async function analyzeReview(review) {
    clearError();
    labelText.textContent = 'Label: —';
    scoreText.textContent = 'Score: —';
    setIcon('loading');
    setStatus('Calling Hugging Face Inference API...');
    const token = hfTokenInput.value.trim();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const body = JSON.stringify({ inputs: review });

    try {
      const resp = await fetch(MODEL_URL, { method: 'POST', headers, body });
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Authentication failed (status ${resp.status}). Check your token or try without a token for the free tier.`);
      }
      if (resp.status === 429) {
        throw new Error('Rate limit or model busy (429). Try again later or provide a token with higher rate limits.');
      }
      if (!resp.ok) {
        // Attempt to parse JSON error message from HF
        let errText = `${resp.status} ${resp.statusText}`;
        try {
          const j = await resp.json();
          if (j && j.error) errText += ` — ${j.error}`;
        } catch (e) {}
        throw new Error(`API error: ${errText}`);
      }

      const json = await resp.json();

      // The instruction specified parse shape: [[{label: 'POSITIVE', score: number}]]
      // But HF sometimes returns [{label,score}, ...]. Handle both.
      let entry = null;
      if (Array.isArray(json)) {
        if (Array.isArray(json[0])) {
          // [[{...}]]
          entry = json[0][0];
        } else if (json[0] && typeof json[0] === 'object' && 'label' in json[0]) {
          // [{...}]
          entry = json[0];
        } else {
          // Unexpected shape: try deep find first object with label & score
          outer: for (const a of json) {
            if (Array.isArray(a)) {
              for (const b of a) {
                if (b && typeof b === 'object' && 'label' in b && 'score' in b) {
                  entry = b;
                  break outer;
                }
              }
            } else if (a && typeof a === 'object' && 'label' in a && 'score' in a) {
              entry = a;
              break;
            }
          }
        }
      } else if (json && typeof json === 'object' && 'error' in json) {
        throw new Error(`API returned error: ${json.error}`);
      }

      if (!entry || typeof entry !== 'object' || !('label' in entry) || !('score' in entry)) {
        throw new Error('Unexpected API response format. See console for full response.');
      }

      const label = String(entry.label).toUpperCase();
      const score = Number(entry.score);

      labelText.textContent = `Label: ${label}`;
      scoreText.textContent = `Score: ${isFinite(score) ? score.toFixed(3) : '—'}`;

      // Interpretation per spec:
      // If score > 0.5 and label 'POSITIVE' → positive;
      // 'NEGATIVE' → negative;
      // else neutral.
      let resultType = 'neutral';
      if (score > 0.5 && label === 'POSITIVE') resultType = 'positive';
      else if (score > 0.5 && label === 'NEGATIVE') resultType = 'negative';
      else resultType = 'neutral';

      setIcon(resultType);
      setStatus('Analysis complete.');
    } catch (err) {
      console.error('Analyze error:', err);
      setIcon('neutral');
      setStatus('Analysis failed.');
      showError(err.message || String(err));
    }
  }

  async function onRandomClick() {
    clearError();
    if (!reviews.length) {
      showError('No reviews loaded. Reload TSV first.');
      return;
    }
    randomBtn.disabled = true;
    reloadBtn.disabled = true;
    setStatus('Selecting random review...');
    const review = pickRandomReview();
    if (!review) {
      showError('Failed to pick a review.');
      randomBtn.disabled = false;
      reloadBtn.disabled = false;
      return;
    }
    reviewTextEl.textContent = review;
    labelText.textContent = 'Label: —';
    scoreText.textContent = 'Score: —';
    reviewArea.style.display = 'block';
    await analyzeReview(review);
    randomBtn.disabled = false;
    reloadBtn.disabled = false;
  }

  randomBtn.addEventListener('click', onRandomClick);
  reloadBtn.addEventListener('click', () => {
    fetchAndParseTSV();
  });

  // Initial load
  fetchAndParseTSV();
})();
