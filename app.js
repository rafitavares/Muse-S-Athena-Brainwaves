let isRunning = true;
let isRecording = false;
let recordedData = [];
let socket = null;

let audioCtx = null;
let oscL = null;
let oscR = null;

Chart.defaults.color = '#a1a1aa';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const commonChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.3 } },
    scales: {
        x: { display: false },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false } }
    }
};

function createLineChart(canvasId, color, yTitle = null) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    const options = JSON.parse(JSON.stringify(commonChartOptions));
    if (yTitle) {
        options.scales.y.title = { display: true, text: yTitle };
    }

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: color,
                backgroundColor: 'rgba(255,255,255,0.04)',
                fill: true
            }]
        },
        options
    });
}

const chartFreq = createLineChart('chart-freq', '#10b981', 'Hz');
const chartSpO2 = createLineChart('chart-spo2', '#3b82f6', '%');
const chartPulse = createLineChart('chart-pulse', '#ef4444', 'BPM');

function setStatus(text, connected = false) {
    document.getElementById('status-text').innerText = text;
    document.getElementById('status-dot').className = connected ? 'dot connected' : 'dot disconnected';
}

function getWebSocketURL() {
    // Se a página estiver servida pelo server.py:
    if (window.location.protocol.startsWith('http')) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws`;
    }

    // Se o usuário abrir index.html direto como arquivo:
    return 'ws://localhost:8765/ws';
}

function connectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        return;
    }

    setStatus('Connecting...', false);

    socket = new WebSocket(getWebSocketURL());

    socket.onopen = () => {
        setStatus('Connected', true);
    };

    socket.onclose = () => {
        setStatus('Disconnected', false);
    };

    socket.onerror = () => {
        setStatus('Connection Error', false);
    };

    socket.onmessage = (event) => {
        if (!isRunning) return;

        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.error('JSON inválido recebido:', event.data);
            return;
        }

        updateDashboard(data);

        if (isRecording) {
            recordedData.push(flattenRecord(data));
        }
    };
}

function getEEG(data) {
    return data.eeg || data;
}

function getPulse(data) {
    return data.pulse || { hr: data.hr || 0, confidence: 0, status: 'compat' };
}

function getSpO2(data) {
    return data.spo2_module || { spo2: data.spo2 || 0, status: 'compat' };
}

function updateDashboard(data) {
    const eeg = getEEG(data);
    const pulse = getPulse(data);
    const spo2 = getSpO2(data);

    updateBrainBars(eeg);
    updateMetrics(eeg, pulse, spo2);
    updateCharts(eeg, pulse, spo2);
}

function updateBrainBars(eeg) {
    const bands = ['gamma', 'beta', 'alpha', 'theta', 'delta'];
    const total = bands.reduce((sum, band) => sum + Math.max(0, Number(eeg[band] || 0)), 0);

    bands.forEach((band) => {
        const percent = total > 0 ? ((Math.max(0, eeg[band] || 0) / total) * 100) : 0;
        document.getElementById(`bar-${band}`).style.width = `${percent.toFixed(1)}%`;
        document.getElementById(`txt-${band}`).innerText = `${percent.toFixed(1)}%`;
    });
}

function updateMetrics(eeg, pulse, spo2) {
    const quality = Number(eeg.eeg_quality ?? eeg.quality ?? 0);
    document.getElementById('eeg-quality').innerText = `${quality.toFixed(0)}%`;

    const dominant = Number(eeg.dominant_freq || 0);
    document.getElementById('dominant-value').innerText = dominant > 0 ? `${dominant.toFixed(1)} Hz` : '-- Hz';

    const hr = Number(pulse.hr || 0);
    document.getElementById('pulse-value').innerText = hr > 0 ? hr.toFixed(0) : '--';
    document.getElementById('pulse-status').innerText = pulse.status || 'Aguardando dados PPG';

    const spo2Value = Number(spo2.spo2 || 0);
    document.getElementById('spo2-value').innerText = spo2Value > 0 ? spo2Value.toFixed(1) : '--';
    document.getElementById('spo2-status').innerText = spo2.status || 'Módulo experimental / não calibrado';
}

function pushChart(chart, label, value, maxPoints = 90) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return;
    }

    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(Number(value));

    if (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }

    chart.update();
}

function updateCharts(eeg, pulse, spo2) {
    const time = new Date().toLocaleTimeString();

    pushChart(chartFreq, time, eeg.dominant_freq || 0);
    pushChart(chartPulse, time, pulse.hr || 0);
    pushChart(chartSpO2, time, spo2.spo2 || 0);
}

function flattenRecord(data) {
    const eeg = getEEG(data);
    const pulse = getPulse(data);
    const spo2 = getSpO2(data);

    return {
        time: new Date().toISOString(),
        delta: Number(eeg.delta || 0),
        theta: Number(eeg.theta || 0),
        alpha: Number(eeg.alpha || 0),
        beta: Number(eeg.beta || 0),
        gamma: Number(eeg.gamma || 0),
        dominant_freq: Number(eeg.dominant_freq || 0),
        eeg_quality: Number(eeg.eeg_quality || 0),
        hr: Number(pulse.hr || 0),
        pulse_confidence: Number(pulse.confidence || 0),
        spo2: Number(spo2.spo2 || 0),
        spo2_status: spo2.status || ''
    };
}

document.getElementById('btn-connect').addEventListener('click', connectWebSocket);

document.getElementById('btn-run').onclick = () => {
    isRunning = true;
    document.getElementById('btn-run').classList.add('active');
    document.getElementById('btn-hold').classList.remove('active');
};

document.getElementById('btn-hold').onclick = () => {
    isRunning = false;
    document.getElementById('btn-hold').classList.add('active');
    document.getElementById('btn-run').classList.remove('active');
};

document.getElementById('btn-record').onclick = () => {
    isRecording = !isRecording;
    const btn = document.getElementById('btn-record');

    if (isRecording) {
        btn.innerHTML = '<span class="icon">⏹</span> STOP';
        btn.classList.add('active');
        recordedData = [];
    } else {
        btn.innerHTML = '<span class="icon">⏺</span> RECORD';
        btn.classList.remove('active');
        showSaveModal();
    }
};

function showSaveModal() {
    const now = new Date();
    document.getElementById('filename-input').value =
        `Athena_Record_${now.toISOString().slice(0, 19).replaceAll(':', '-')}`;
    document.getElementById('notes-input').value = '';
    document.getElementById('modal-save').classList.remove('hidden');
}

document.getElementById('btn-save-cancel').onclick = () => {
    document.getElementById('modal-save').classList.add('hidden');
};

document.getElementById('btn-save-confirm').onclick = () => {
    const filename = document.getElementById('filename-input').value || 'Athena_Data';
    const notes = document.getElementById('notes-input').value.replace(/\n/g, ' ');

    const header = [
        'Time',
        'Delta',
        'Theta',
        'Alpha',
        'Beta',
        'Gamma',
        'DominantFreq',
        'EEGQuality',
        'HeartRate',
        'PulseConfidence',
        'SpO2',
        'SpO2Status'
    ];

    const rows = recordedData.map(r => [
        r.time,
        r.delta.toFixed(6),
        r.theta.toFixed(6),
        r.alpha.toFixed(6),
        r.beta.toFixed(6),
        r.gamma.toFixed(6),
        r.dominant_freq.toFixed(2),
        r.eeg_quality.toFixed(1),
        r.hr.toFixed(1),
        r.pulse_confidence.toFixed(3),
        r.spo2.toFixed(1),
        `"${String(r.spo2_status).replaceAll('"', '""')}"`
    ].join(','));

    const csv = [
        `Context/Notes: ${notes}`,
        '',
        header.join(','),
        ...rows
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();

    URL.revokeObjectURL(url);
    document.getElementById('modal-save').classList.add('hidden');
};

document.getElementById('btn-audio').onclick = () => {
    const btn = document.getElementById('btn-audio');

    if (oscL || oscR) {
        try { oscL.stop(); } catch {}
        try { oscR.stop(); } catch {}
        oscL = null;
        oscR = null;
        btn.innerText = 'Start Synth';
        btn.classList.remove('active');
        return;
    }

    if (!audioCtx) {
        audioCtx = new AudioContext();
    }

    const target = Number(document.getElementById('bin-target').value || 10);
    const carrier = Number(document.getElementById('bin-carrier').value || 400);

    oscL = audioCtx.createOscillator();
    oscR = audioCtx.createOscillator();

    const gain = audioCtx.createGain();
    gain.gain.value = 0.05;

    const pL = audioCtx.createStereoPanner();
    const pR = audioCtx.createStereoPanner();

    pL.pan.value = -1;
    pR.pan.value = 1;

    oscL.frequency.value = carrier;
    oscR.frequency.value = carrier + target;

    oscL.connect(pL).connect(gain).connect(audioCtx.destination);
    oscR.connect(pR).connect(gain).connect(audioCtx.destination);

    oscL.start();
    oscR.start();

    btn.innerText = 'Stop Synth';
    btn.classList.add('active');
};
