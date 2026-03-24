import Chart from 'chart.js/auto';

// ═══════════════════════════════════════════════════════
// BLE Constants for WitMotion WT9011DCL
// ═══════════════════════════════════════════════════════
const SERVICE_UUIDS = [
  '0000ffe5-0000-1000-8000-00805f9a34fb',
  0xffe5, 0xffe0, 0xfff0, 0xfee0, 0x0001,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455'
];

let bleDevice = null;
let bleServer = null;
let writeChar = null;

// ═══════════════════════════════════════════════════════
// Task & Recording State
// ═══════════════════════════════════════════════════════
const TASKS = ['right-resting', 'right-postural', 'left-resting', 'left-postural'];
const TASK_LABELS = {
  'right-resting': 'Right Resting',
  'right-postural': 'Right Postural',
  'left-resting': 'Left Resting',
  'left-postural': 'Left Postural'
};
const RECORD_DURATION_MS = 5000;

let isRecording = false;
let currentTask = null;
let recordTimer = null;
let startTime = 0;

// Per-task stored data
const taskData = {};
const taskResults = {};
TASKS.forEach(t => { taskData[t] = null; taskResults[t] = null; });

// Live buffer for current recording
let liveData = { time: [], ax: [], ay: [], az: [], wx: [], wy: [], wz: [] };

// ═══════════════════════════════════════════════════════
// UI Elements
// ═══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const btnConnect = $('btn-connect');
const btnRate = $('btn-rate');
const statusText = $('ble-status');
const statusDot = $('status-dot');
const progressBar = $('record-progress');
const recordIndicator = $('record-indicator');
const resultsPanel = $('results-panel');
const taskButtons = document.querySelectorAll('.btn-task');

const liveEls = {
  ax: $('val-ax'), ay: $('val-ay'), az: $('val-az'),
  gx: $('val-gx'), gy: $('val-gy'), gz: $('val-gz')
};

// ═══════════════════════════════════════════════════════
// Mini Charts (per-task time domain)
// ═══════════════════════════════════════════════════════
const miniCharts = {};
let compareRmsChart, compareFreqChart;

function initCharts() {
  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } }
  };
  const gridColor = 'rgba(148, 163, 184, 0.08)';
  const tickColor = '#64748b';

  // Mini charts for each task
  TASKS.forEach(task => {
    const canvas = $(`chart-${task}`);
    if (!canvas) return;
    miniCharts[task] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: '#6366f1', borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0.1 }] },
      options: { ...commonOpts, scales: { x: { display: false }, y: { display: false } } }
    });
  });

  // Comparison charts
  compareRmsChart = new Chart($('compareRmsChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['R Rest', 'R Post', 'L Rest', 'L Post'],
      datasets: [{
        label: 'RMS (g)',
        data: [0, 0, 0, 0],
        backgroundColor: ['rgba(239,68,68,0.6)', 'rgba(99,102,241,0.6)', 'rgba(239,68,68,0.4)', 'rgba(99,102,241,0.4)'],
        borderColor: ['#ef4444', '#6366f1', '#ef4444', '#6366f1'],
        borderWidth: 1,
        borderRadius: 6
      }]
    },
    options: {
      ...commonOpts,
      maintainAspectRatio: true,
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } }, title: { display: true, text: 'RMS (g)', color: tickColor, font: { size: 11 } } }
      }
    }
  });

  compareFreqChart = new Chart($('compareFreqChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['R Rest', 'R Post', 'L Rest', 'L Post'],
      datasets: [{
        label: 'Freq (Hz)',
        data: [0, 0, 0, 0],
        backgroundColor: ['rgba(6,182,212,0.6)', 'rgba(16,185,129,0.6)', 'rgba(6,182,212,0.4)', 'rgba(16,185,129,0.4)'],
        borderColor: ['#06b6d4', '#10b981', '#06b6d4', '#10b981'],
        borderWidth: 1,
        borderRadius: 6
      }]
    },
    options: {
      ...commonOpts,
      maintainAspectRatio: true,
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } }, title: { display: true, text: 'Hz', color: tickColor, font: { size: 11 } } }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════
// BLE Connection
// ═══════════════════════════════════════════════════════
async function connectBLE() {
  try {
    setStatus('Requesting Device...', false);
    bleDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: SERVICE_UUIDS
    });
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    setStatus('Connecting...', false);
    bleServer = await bleDevice.gatt.connect();

    setStatus('Finding Services...', false);
    let service = null;
    for (let suid of SERVICE_UUIDS) {
      try { service = await bleServer.getPrimaryService(suid); break; } catch(e) {}
    }
    if (!service) throw new Error('Compatible UUID not found');

    setStatus('Subscribing...', false);
    let chars = await service.getCharacteristics();
    let subscribed = 0;
    for (let c of chars) {
      if (c.properties.notify || c.properties.indicate) {
        try {
          await c.startNotifications();
          c.addEventListener('characteristicvaluechanged', handleBLEData);
          subscribed++;
        } catch(e) {}
      }
      if (c.properties.write || c.properties.writeWithoutResponse) {
        writeChar = c;
        btnRate.style.display = 'inline-flex';
      }
    }
    if (subscribed === 0) throw new Error('No notify characteristics found');

    setStatus(`Connected: ${bleDevice.name}`, true);
    btnConnect.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg> Disconnect`;
    taskButtons.forEach(b => b.disabled = false);

  } catch(error) {
    setStatus('Error: ' + error.message, false);
  }
}

function onDisconnected() {
  setStatus('Disconnected', false);
  btnConnect.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11M12 2v20M7 7l5-5 5 5M7 17l5 5 5-5"/></svg> Connect Sensor`;
  taskButtons.forEach(b => b.disabled = true);
  bleDevice = null;
}

function setStatus(text, connected) {
  statusText.innerText = text;
  statusDot.classList.toggle('connected', connected);
}

// ═══════════════════════════════════════════════════════
// Recording (per-task)
// ═══════════════════════════════════════════════════════
function startRecording(task) {
  if (!bleDevice || isRecording) return;

  currentTask = task;
  isRecording = true;
  liveData = { time: [], ax: [], ay: [], az: [], wx: [], wy: [], wz: [] };
  startTime = performance.now();

  // UI
  taskButtons.forEach(b => {
    if (b.dataset.task === task) {
      b.classList.add('recording');
      b.classList.remove('done');
    } else {
      b.disabled = true;
    }
  });
  recordIndicator.innerText = `Recording ${TASK_LABELS[task]}...`;

  let progress = 0;
  recordTimer = setInterval(() => {
    progress += (100 / (RECORD_DURATION_MS / 100));
    progressBar.style.width = Math.min(progress, 100) + '%';
    recordIndicator.innerText = `${TASK_LABELS[task]}: ${liveData.time.length} samples`;
    if (progress >= 100) stopRecording();
  }, 100);
}

function stopRecording() {
  isRecording = false;
  clearInterval(recordTimer);
  progressBar.style.width = '0%';

  // Store data
  taskData[currentTask] = { ...liveData };

  // UI
  taskButtons.forEach(b => {
    b.classList.remove('recording');
    if (b.dataset.task === currentTask) b.classList.add('done');
    if (bleDevice) b.disabled = false;
  });

  const count = liveData.time.length;
  const sr = count / (RECORD_DURATION_MS / 1000);
  recordIndicator.innerText = `${TASK_LABELS[currentTask]}: ${count} samples @ ${sr.toFixed(0)}Hz`;

  // Analyze this task
  analyzeTask(currentTask);
  currentTask = null;
}

// ═══════════════════════════════════════════════════════
// WT9011DCL Packet Parsing
// ═══════════════════════════════════════════════════════
let buffer = [];
let debugPacketCount = 0;

function handleBLEData(event) {
  let value = event.target.value;
  for (let i = 0; i < value.byteLength; i++) {
    buffer.push(value.getUint8(i));
  }

  while (buffer.length >= 20) {
    if (buffer[0] !== 0x55 || (buffer[1] !== 0x61 && buffer[1] !== 0x51)) {
      buffer.shift();
      continue;
    }

    let packet = buffer.slice(0, 20);
    buffer.splice(0, 20);

    debugPacketCount++;
    let logEl = $('debug-log');
    if (logEl && debugPacketCount % 4 === 0) {
      let hexStr = Array.from(packet).map(b => b.toString(16).padStart(2, '0')).join(' ');
      logEl.innerText = hexStr + '\n' + logEl.innerText.substring(0, 300);
    }

    let view = new DataView(new Uint8Array(packet).buffer);
    let ax = view.getInt16(2, true) / 32768.0 * 16.0;
    let ay = view.getInt16(4, true) / 32768.0 * 16.0;
    let az = view.getInt16(6, true) / 32768.0 * 16.0;
    let wx = view.getInt16(8, true) / 32768.0 * 2000.0;
    let wy = view.getInt16(10, true) / 32768.0 * 2000.0;
    let wz = view.getInt16(12, true) / 32768.0 * 2000.0;

    liveEls.ax.innerText = ax.toFixed(2);
    liveEls.ay.innerText = ay.toFixed(2);
    liveEls.az.innerText = az.toFixed(2);
    liveEls.gx.innerText = wx.toFixed(1);
    liveEls.gy.innerText = wy.toFixed(1);
    liveEls.gz.innerText = wz.toFixed(1);

    if (isRecording) {
      let rTime = (performance.now() - startTime) / 1000.0;
      liveData.time.push(rTime);
      liveData.ax.push(ax);
      liveData.ay.push(ay);
      liveData.az.push(az);
      liveData.wx.push(wx);
      liveData.wy.push(wy);
      liveData.wz.push(wz);
    }
  }
}

// ═══════════════════════════════════════════════════════
// FFT (Cooley-Tukey Radix-2)
// ═══════════════════════════════════════════════════════
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i+j+halfLen] - curIm * im[i+j+halfLen];
        const tIm = curRe * im[i+j+halfLen] + curIm * re[i+j+halfLen];
        re[i+j+halfLen] = re[i+j] - tRe;
        im[i+j+halfLen] = im[i+j] - tIm;
        re[i+j] += tRe;
        im[i+j] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function nextPow2(n) { return Math.pow(2, Math.ceil(Math.log2(n))); }

function computeFFT(signal, sampleRate) {
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  const N = nextPow2(signal.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (signal.length - 1)));
    re[i] = (signal[i] - mean) * w;
  }
  fft(re, im);
  const freqRes = sampleRate / N;
  const halfN = N / 2;
  const freqs = [], powers = [];
  for (let i = 0; i < halfN; i++) {
    freqs.push(i * freqRes);
    powers.push((re[i] * re[i] + im[i] * im[i]) / (N * N));
  }
  return { freqs, powers, freqRes };
}

// ═══════════════════════════════════════════════════════
// Approximate Entropy (ApEn)
// ═══════════════════════════════════════════════════════
function approximateEntropy(data, m, r) {
  const N = data.length;
  function phi(m) {
    const patterns = [];
    for (let i = 0; i <= N - m; i++) patterns.push(data.slice(i, i + m));
    let sum = 0;
    for (let i = 0; i < patterns.length; i++) {
      let count = 0;
      for (let j = 0; j < patterns.length; j++) {
        let match = true;
        for (let k = 0; k < m; k++) {
          if (Math.abs(patterns[i][k] - patterns[j][k]) > r) { match = false; break; }
        }
        if (match) count++;
      }
      sum += Math.log(count / patterns.length);
    }
    return sum / patterns.length;
  }
  return phi(m) - phi(m + 1);
}

// ═══════════════════════════════════════════════════════
// Per-Task Analysis
// ═══════════════════════════════════════════════════════
function analyzeTask(task) {
  const data = taskData[task];
  if (!data || data.az.length < 10) {
    alert(`Not enough data for ${TASK_LABELS[task]}: ${data ? data.az.length : 0} samples`);
    return;
  }

  const az = data.az;
  const sampleRate = az.length / (RECORD_DURATION_MS / 1000);
  const mean = az.reduce((a, b) => a + b, 0) / az.length;
  const zeroMean = az.map(v => v - mean);
  const rms = Math.sqrt(zeroMean.reduce((s, v) => s + v * v, 0) / zeroMean.length);

  const { freqs, powers, freqRes } = computeFFT(az, sampleRate);

  let peakPower = 0, peakFreq = 0, peakPSD = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= 3 && freqs[i] <= 20 && powers[i] > peakPower) {
      peakPower = powers[i];
      peakFreq = freqs[i];
      peakPSD = powers[i] / freqRes;
    }
  }

  // ApEn (downsample for performance)
  let apEnData = zeroMean;
  if (apEnData.length > 200) {
    const step = Math.floor(apEnData.length / 200);
    apEnData = apEnData.filter((_, i) => i % step === 0);
  }
  const sd = Math.sqrt(apEnData.reduce((s, v) => s + v * v, 0) / apEnData.length);
  const apEn = approximateEntropy(apEnData, 2, 0.2 * sd);

  const result = { freq: peakFreq, rms, psd: peakPSD, apEn, sampleRate, samples: az.length };
  taskResults[task] = result;

  // Update per-task UI
  $(`freq-${task}`).innerText = result.freq.toFixed(1);
  $(`rms-${task}`).innerText = result.rms.toFixed(4);
  $(`psd-${task}`).innerText = result.psd.toFixed(4);
  $(`apen-${task}`).innerText = result.apEn.toFixed(3);
  $(`samples-${task}`).innerText = `${result.samples} @ ${result.sampleRate.toFixed(0)}Hz`;
  $(`result-${task}`).classList.add('has-data');

  // Mini chart
  if (miniCharts[task]) {
    const chart = miniCharts[task];
    chart.data.labels = data.time.map(t => t.toFixed(2));
    chart.data.datasets[0].data = az.slice();
    chart.update();
  }

  // Show results panel
  resultsPanel.classList.remove('hidden');

  // Update comparison charts
  updateComparisonCharts();

  // Update differential if we have enough data
  updateDiagnosis();
}

function updateComparisonCharts() {
  const rmsValues = TASKS.map(t => taskResults[t] ? taskResults[t].rms : 0);
  const freqValues = TASKS.map(t => taskResults[t] ? taskResults[t].freq : 0);

  compareRmsChart.data.datasets[0].data = rmsValues;
  compareRmsChart.update();

  compareFreqChart.data.datasets[0].data = freqValues;
  compareFreqChart.update();
}

// ═══════════════════════════════════════════════════════
// Differential Diagnosis
// ═══════════════════════════════════════════════════════
function updateDiagnosis() {
  const completedTasks = TASKS.filter(t => taskResults[t]);
  if (completedTasks.length === 0) return;

  let etScore = 0, pdScore = 0;

  // --- Frequency analysis (use average of all completed) ---
  const avgFreq = completedTasks.reduce((s, t) => s + taskResults[t].freq, 0) / completedTasks.length;
  const diagFreq = $('diag-freq');
  diagFreq.innerText = avgFreq.toFixed(1) + ' Hz';
  if (avgFreq >= 4 && avgFreq <= 6) {
    diagFreq.className = 'diag-result favor-pd';
    pdScore += 25; etScore += 8;
  } else if (avgFreq > 6 && avgFreq <= 12) {
    diagFreq.className = 'diag-result favor-et';
    etScore += 25; pdScore += 5;
  } else {
    diagFreq.className = 'diag-result neutral';
    etScore += 5; pdScore += 5;
  }

  // --- Resting vs Postural comparison ---
  const diagType = $('diag-type');
  const diagRestPost = $('diag-rest-post');

  const rRest = taskResults['right-resting'];
  const rPost = taskResults['right-postural'];
  const lRest = taskResults['left-resting'];
  const lPost = taskResults['left-postural'];

  let restingAvgRms = 0, posturalAvgRms = 0, restCount = 0, postCount = 0;
  if (rRest) { restingAvgRms += rRest.rms; restCount++; }
  if (lRest) { restingAvgRms += lRest.rms; restCount++; }
  if (rPost) { posturalAvgRms += rPost.rms; postCount++; }
  if (lPost) { posturalAvgRms += lPost.rms; postCount++; }
  if (restCount) restingAvgRms /= restCount;
  if (postCount) posturalAvgRms /= postCount;

  if (restCount > 0 && postCount > 0) {
    const ratio = restingAvgRms / posturalAvgRms;
    if (ratio > 1.2) {
      diagType.innerText = 'Resting dominant';
      diagType.className = 'diag-result favor-pd';
      diagRestPost.innerText = `Rest ${restingAvgRms.toFixed(4)} > Post ${posturalAvgRms.toFixed(4)}`;
      diagRestPost.className = 'diag-result favor-pd';
      pdScore += 25; etScore += 5;
    } else if (ratio < 0.8) {
      diagType.innerText = 'Postural dominant';
      diagType.className = 'diag-result favor-et';
      diagRestPost.innerText = `Post ${posturalAvgRms.toFixed(4)} > Rest ${restingAvgRms.toFixed(4)}`;
      diagRestPost.className = 'diag-result favor-et';
      etScore += 25; pdScore += 5;
    } else {
      diagType.innerText = 'Mixed';
      diagType.className = 'diag-result neutral';
      diagRestPost.innerText = `Rest ${restingAvgRms.toFixed(4)} ≈ Post ${posturalAvgRms.toFixed(4)}`;
      diagRestPost.className = 'diag-result neutral';
      etScore += 12; pdScore += 12;
    }
  } else {
    diagType.innerText = `${completedTasks.length}/4 tasks`;
    diagType.className = 'diag-result neutral';
    diagRestPost.innerText = 'Need resting + postural data';
    diagRestPost.className = 'diag-result neutral';
    etScore += 5; pdScore += 5;
  }

  // --- Regularity (ApEn) ---
  const avgApEn = completedTasks.reduce((s, t) => s + taskResults[t].apEn, 0) / completedTasks.length;
  const diagReg = $('diag-regularity');
  if (avgApEn < 0.5) {
    diagReg.innerText = `ApEn = ${avgApEn.toFixed(3)} (Regular)`;
    diagReg.className = 'diag-result favor-pd';
    pdScore += 20; etScore += 5;
  } else if (avgApEn < 1.0) {
    diagReg.innerText = `ApEn = ${avgApEn.toFixed(3)} (Moderate)`;
    diagReg.className = 'diag-result neutral';
    pdScore += 12; etScore += 12;
  } else {
    diagReg.innerText = `ApEn = ${avgApEn.toFixed(3)} (Irregular)`;
    diagReg.className = 'diag-result favor-et';
    etScore += 20; pdScore += 5;
  }

  // --- Asymmetry ---
  const diagAsym = $('diag-asymmetry');
  if (rRest && lRest) {
    const asymIdx = Math.abs(rRest.rms - lRest.rms) / Math.max(rRest.rms, lRest.rms);
    const dominant = rRest.rms > lRest.rms ? 'Right' : 'Left';
    if (asymIdx > 0.3) {
      diagAsym.innerText = `${(asymIdx * 100).toFixed(0)}% (${dominant} dominant)`;
      diagAsym.className = 'diag-result favor-pd';
      pdScore += 20; etScore += 5;
    } else {
      diagAsym.innerText = `${(asymIdx * 100).toFixed(0)}% (Symmetrical)`;
      diagAsym.className = 'diag-result favor-et';
      etScore += 20; pdScore += 5;
    }
  } else {
    diagAsym.innerText = 'Need bilateral data';
    diagAsym.className = 'diag-result neutral';
    etScore += 5; pdScore += 5;
  }

  // --- Scores ---
  const total = etScore + pdScore;
  const etPct = Math.round((etScore / total) * 100);
  const pdPct = Math.round((pdScore / total) * 100);

  $('et-score-bar').style.width = etPct + '%';
  $('pd-score-bar').style.width = pdPct + '%';
  $('et-score-pct').innerText = etPct + '%';
  $('pd-score-pct').innerText = pdPct + '%';

  // --- Verdict ---
  const verdictIcon = $('verdict-icon');
  const verdictTitle = $('verdict-title');
  const verdictText = $('verdict-text');
  const allDone = completedTasks.length === 4;
  const partial = !allDone ? ` (${completedTasks.length}/4 tasks completed)` : '';

  if (pdPct > etPct + 12) {
    verdictIcon.innerText = '!';
    verdictIcon.style.borderColor = '#ef4444';
    verdictIcon.style.color = '#ef4444';
    verdictTitle.innerText = `Findings Favor Parkinson's Disease${partial}`;
    verdictText.innerText = `Avg frequency ${avgFreq.toFixed(1)} Hz. ${restCount && postCount ? (restingAvgRms > posturalAvgRms ? 'Resting-dominant pattern.' : '') : ''} Consider DaTscan for dopamine transporter imaging.`;
  } else if (etPct > pdPct + 12) {
    verdictIcon.innerText = 'ET';
    verdictIcon.style.borderColor = '#f59e0b';
    verdictIcon.style.color = '#f59e0b';
    verdictTitle.innerText = `Findings Favor Essential Tremor${partial}`;
    verdictText.innerText = `Avg frequency ${avgFreq.toFixed(1)} Hz. ${restCount && postCount ? (posturalAvgRms > restingAvgRms ? 'Postural-dominant pattern.' : '') : ''} Consider beta-blocker or primidone therapy.`;
  } else {
    verdictIcon.innerText = '?';
    verdictIcon.style.borderColor = '#6366f1';
    verdictIcon.style.color = '#6366f1';
    verdictTitle.innerText = `Indeterminate${partial}`;
    verdictText.innerText = allDone
      ? 'Findings do not clearly differentiate ET from PD. Consider DaTscan for definitive diagnosis.'
      : 'Complete all 4 tasks for more accurate differential diagnosis.';
  }

  // --- Clinical Note ---
  const taskSummaries = completedTasks.map(t => {
    const r = taskResults[t];
    return `<strong>${TASK_LABELS[t]}:</strong> Freq ${r.freq.toFixed(1)} Hz, RMS ${r.rms.toFixed(4)} g, ApEn ${r.apEn.toFixed(3)}`;
  }).join('<br>');

  $('clinical-note').innerHTML = `
    <strong>Quantitative Tremor Analysis Summary</strong><br><br>
    ${taskSummaries}<br><br>
    ${restCount && postCount ? `<strong>Resting vs Postural:</strong> Resting RMS ${restingAvgRms.toFixed(4)} g, Postural RMS ${posturalAvgRms.toFixed(4)} g
    (${restingAvgRms > posturalAvgRms * 1.2 ? 'Resting-dominant — favors PD' : posturalAvgRms > restingAvgRms * 1.2 ? 'Postural-dominant — favors ET' : 'No clear dominance'})<br><br>` : ''}
    ${rRest && lRest ? `<strong>Asymmetry:</strong> Right RMS ${rRest.rms.toFixed(4)} g vs Left RMS ${lRest.rms.toFixed(4)} g
    (${Math.abs(rRest.rms - lRest.rms) / Math.max(rRest.rms, lRest.rms) > 0.3 ? 'Asymmetric — favors PD' : 'Symmetric — favors ET'})<br><br>` : ''}
    <strong>Differential:</strong> ET ${etPct}% vs PD ${pdPct}%.
    ${pdPct > etPct + 12 ? 'Findings favor PD.' : etPct > pdPct + 12 ? 'Findings favor ET.' : 'Indeterminate.'}<br><br>
    <em>${allDone ? 'All 4 tasks completed.' : `${completedTasks.length}/4 tasks completed. Complete remaining tasks for higher diagnostic confidence.`}</em>
  `;
}

// ═══════════════════════════════════════════════════════
// Theme Toggle
// ═══════════════════════════════════════════════════════
function initTheme() {
  const saved = localStorage.getItem('tremorsense-theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
  updateThemeIcons();
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('tremorsense-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('tremorsense-theme', 'light');
  }
  updateThemeIcons();
}

function updateThemeIcons() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const darkIcon = $('theme-icon-dark');
  const lightIcon = $('theme-icon-light');
  if (darkIcon && lightIcon) {
    darkIcon.style.display = isLight ? 'none' : 'block';
    lightIcon.style.display = isLight ? 'block' : 'none';
  }
}

// ═══════════════════════════════════════════════════════
// Init — all event listeners inside DOMContentLoaded
// ═══════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initCharts();

  btnConnect.addEventListener('click', () => {
    if (bleDevice) bleDevice.gatt.disconnect();
    else connectBLE();
  });

  btnRate.addEventListener('click', async () => {
    if (!writeChar) return;
    try {
      await writeChar.writeValue(new Uint8Array([0xFF, 0xAA, 0x69, 0x88, 0xB5]));
      await new Promise(r => setTimeout(r, 100));
      await writeChar.writeValue(new Uint8Array([0xFF, 0xAA, 0x03, 0x08, 0x00]));
      await new Promise(r => setTimeout(r, 100));
      await writeChar.writeValue(new Uint8Array([0xFF, 0xAA, 0x00, 0x00, 0x00]));
      alert('50Hz 설정 명령 전송 완료. 센서 LED 확인.');
    } catch(e) { console.error(e); }
  });

  taskButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      startRecording(btn.dataset.task);
    });
  });

  $('theme-toggle').addEventListener('click', toggleTheme);
});
