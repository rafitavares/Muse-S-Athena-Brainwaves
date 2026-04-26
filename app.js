let isRunning = true;
let isRecording = false;
let recordedData = [];
let recordingStartTime = null;

let socket = null;
let museConnected = false;
let manualZoom = false;
let syncingZoom = false;

let audioCtx = null;
let oscL = null;
let oscR = null;

const LIVE_WINDOW_MS = 2 * 60 * 1000;
const MAX_POINTS_NOT_RECORDING = 1200;

Chart.defaults.color = '#a1a1aa';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

function nowMs() {
    return Date.now();
}

function formatClock(value) {
    const d = new Date(value);
    return d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function getWebSocketURL() {
    if (window.location.protocol.startsWith('http')) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws`;
    }

    return 'ws://localhost:8765/ws';
}

function sendCommand(command) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ command }));
    }
}

function setConnectionUI(text, connected = false) {
    museConnected = connected;

    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');
    const btn = document.getElementById('btn-connect');

    if (statusText) statusText.innerText = text;
    if (statusDot) statusDot.className = connected ? 'dot connected' : 'dot disconnected';

    if (btn) {
        if (connected) {
            btn.innerHTML = '<span class="icon">⏻</span> DESCONECTAR';
            btn.classList.add('disconnect');
        } else {
            btn.innerHTML = '<span class="icon">⚡</span> CONECTAR';
            btn.classList.remove('disconnect');
        }
    }
}

function ensureWebSocket() {
    return new Promise((resolve) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            resolve(true);
            return;
        }

        socket = new WebSocket(getWebSocketURL());

        socket.onopen = () => {
            setConnectionUI('Backend OK', false);
            resolve(true);
        };

        socket.onclose = () => {
            setConnectionUI('Disconnected', false);
            socket = null;
        };

        socket.onerror = () => {
            setConnectionUI('WS Error', false);
            resolve(false);
        };

        socket.onmessage = (event) => {
            let data;

            try {
                data = JSON.parse(event.data);
            } catch (err) {
                console.error('JSON inválido:', event.data);
                return;
            }

            if (!isRunning) return;

            updateDashboard(data);

            if (isRecording) {
                recordedData.push(flattenRecord(data));
            }
        };
    });
}

async function toggleConnect() {
    await ensureWebSocket();

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    if (museConnected) {
        setConnectionUI('Disconnecting...', false);
        sendCommand('disconnect_muse');
    } else {
        setConnectionUI('Connecting...', false);
        sendCommand('connect_muse');
    }
}

function createSyncedTimeChart(canvasId, datasets, yOptions = {}) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    return new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            normalized: true,
            parsing: false,
            interaction: {
                mode: 'nearest',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        boxWidth: 10,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    callbacks: {
                        title: (items) => {
                            if (!items.length) return '';
                            return formatClock(items[0].parsed.x);
                        }
                    }
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: 'x',
                        onPanComplete: ({ chart }) => syncCharts(chart)
                    },
                    zoom: {
                        wheel: {
                            enabled: true,
                            speed: 0.08
                        },
                        pinch: {
                            enabled: true
                        },
                        mode: 'x',
                        onZoomComplete: ({ chart }) => syncCharts(chart)
                    },
                    limits: {
                        x: { min: 'original', max: 'original' }
                    }
                }
            },
            elements: {
                point: { radius: 0 },
                line: { borderWidth: 2, tension: 0.18 }
            },
            scales: {
                x: {
                    type: 'linear',
                    ticks: {
                        callback: (value) => formatClock(Number(value)),
                        maxRotation: 0,
                        autoSkip: true
                    },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                ...yOptions
            }
        }
    });
}

const waveChart = createSyncedTimeChart('chart-waves', [
    {
        label: 'Dominant Hz',
        data: [],
        borderColor: '#ffffff',
        backgroundColor: 'rgba(255,255,255,0.08)',
        yAxisID: 'yHz',
        hidden: false
    },
    {
        label: 'Delta %',
        data: [],
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.08)',
        yAxisID: 'yPercent',
        hidden: false
    },
    {
        label: 'Theta %',
        data: [],
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.08)',
        yAxisID: 'yPercent',
        hidden: false
    },
    {
        label: 'Alpha %',
        data: [],
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.08)',
        yAxisID: 'yPercent',
        hidden: false
    },
    {
        label: 'Beta %',
        data: [],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.08)',
        yAxisID: 'yPercent',
        hidden: false
    },
    {
        label: 'Gamma %',
        data: [],
        borderColor: '#d946ef',
        backgroundColor: 'rgba(217,70,239,0.08)',
        yAxisID: 'yPercent',
        hidden: false
    }
], {
    yPercent: {
        position: 'left',
        min: 0,
        max: 100,
        title: { display: true, text: 'Wave Power %' },
        grid: { color: 'rgba(255,255,255,0.05)' }
    },
    yHz: {
        position: 'right',
        min: 0,
        max: 45,
        title: { display: true, text: 'Dominant Hz' },
        grid: { drawOnChartArea: false }
    }
});

const pulseChart = createSyncedTimeChart('chart-pulse', [
    {
        label: 'Pulse BPM',
        data: [],
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.08)',
        yAxisID: 'y'
    }
], {
    y: {
        position: 'left',
        min: 40,
        max: 140,
        title: { display: true, text: 'BPM' },
        grid: { color: 'rgba(255,255,255,0.05)' }
    }
});

function syncCharts(sourceChart) {
    if (syncingZoom || isRecording) return;

    manualZoom = true;
    syncingZoom = true;

    const min = sourceChart.scales.x.min;
    const max = sourceChart.scales.x.max;

    [waveChart, pulseChart].forEach((chart) => {
        if (chart === sourceChart) return;

        chart.options.scales.x.min = min;
        chart.options.scales.x.max = max;
        chart.update('none');
    });

    syncingZoom = false;
}

function resetZoomAll() {
    manualZoom = false;

    [waveChart, pulseChart].forEach((chart) => {
        if (chart.resetZoom) chart.resetZoom();

        chart.options.scales.x.min = undefined;
        chart.options.scales.x.max = undefined;
        chart.update('none');
    });
}

function setVisible(datasetIndex, visible) {
    waveChart.data.datasets[datasetIndex].hidden = !visible;
    waveChart.update('none');
}

function wireCheckboxes() {
    const map = [
        ['chk-dominant', 0],
        ['chk-delta', 1],
        ['chk-theta', 2],
        ['chk-alpha', 3],
        ['chk-beta', 4],
        ['chk-gamma', 5]
    ];

    map.forEach(([id, idx]) => {
        const el = document.getElementById(id);
        if (!el) return;

        el.addEventListener('change', (event) => {
            setVisible(idx, event.target.checked);
        });
    });
}

wireCheckboxes();

function getEEG(data) {
    return data.eeg || data;
}

function getPulse(data) {
    return data.pulse || { hr: data.hr || 0, confidence: 0, status: 'compat' };
}

function getSpO2(data) {
    return data.spo2_module || { spo2: data.spo2 || 0, status: 'compat', relative_oxygen_index: 0 };
}

function getMovement(data) {
    return data.movement || {};
}

function getRespiration(data) {
    return data.respiration || {};
}

function getBattery(data) {
    return data.battery || {};
}

function bandPercentages(eeg) {
    const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
    const raw = {};
    let total = 0;

    bands.forEach((band) => {
        raw[band] = Math.max(0, Number(eeg[band] || 0));
        total += raw[band];
    });

    const pct = {};

    bands.forEach((band) => {
        pct[band] = total > 0 ? (raw[band] / total) * 100 : 0;
    });

    return pct;
}

function updateDashboard(data) {
    const eeg = getEEG(data);
    const pulse = getPulse(data);
    const spo2 = getSpO2(data);
    const movement = getMovement(data);
    const respiration = getRespiration(data);
    const battery = getBattery(data);

    const t = data.timestamp ? data.timestamp * 1000 : nowMs();
    const pct = bandPercentages(eeg);

    updateConnectionFromState(data);
    updateTopStatus(eeg, battery);
    updateBrainBars(pct);
    updateMetrics(eeg, pulse, spo2, movement, respiration, data);
    updateCharts(t, eeg, pct, pulse);
}

function updateConnectionFromState(data) {
    const connection = data.connection || {};
    const bleConnected = Boolean(connection.ble_connected);

    if (bleConnected) {
        setConnectionUI('Muse Connected', true);
    } else if (connection.ble_enabled) {
        setConnectionUI('Searching Muse', false);
    } else if (socket && socket.readyState === WebSocket.OPEN) {
        setConnectionUI('Muse Off', false);
    }
}

function updateTopStatus(eeg, battery) {
    const quality = Number(eeg.eeg_quality ?? eeg.quality ?? 0);
    const topQuality = document.getElementById('top-quality');

    if (topQuality) topQuality.innerText = `${quality.toFixed(0)}%`;

    const level = Number(battery.level || 0);
    const topBattery = document.getElementById('top-battery');

    if (topBattery) topBattery.innerText = level > 0 ? `${level.toFixed(0)}%` : '--%';
}

function updateBrainBars(pct) {
    ['gamma', 'beta', 'alpha', 'theta', 'delta'].forEach((band) => {
        const value = pct[band] || 0;

        const bar = document.getElementById(`bar-${band}`);
        const txt = document.getElementById(`txt-${band}`);

        if (bar) bar.style.width = `${value.toFixed(1)}%`;
        if (txt) txt.innerText = `${value.toFixed(1)}%`;
    });
}

function updateMetrics(eeg, pulse, spo2, movement, respiration, data) {
    const hr = Number(pulse.hr || 0);
    const pulseValue = document.getElementById('pulse-value');

    if (pulseValue) pulseValue.innerText = hr > 0 ? hr.toFixed(0) : '--';

    const spo2Value = Number(spo2.spo2 || 0);

    const spo2El = document.getElementById('spo2-value');
    const spo2Status = document.getElementById('spo2-status');
    const oxygenIndex = document.getElementById('oxygen-index');

    if (spo2El) spo2El.innerText = spo2Value > 0 ? spo2Value.toFixed(1) : '--';
    if (spo2Status) spo2Status.innerText = spo2.status || 'Experimental / not calibrated';
    if (oxygenIndex) oxygenIndex.innerText =
        spo2.relative_oxygen_index ? Number(spo2.relative_oxygen_index).toFixed(3) : '--';

    const movementValue = document.getElementById('movement-value');
    const postureStatus = document.getElementById('posture-status');
    const gyroValue = document.getElementById('gyro-value');

    if (movementValue) movementValue.innerText =
        movement.movement_score !== undefined ? Number(movement.movement_score).toFixed(0) : '--';
    if (postureStatus) postureStatus.innerText = movement.posture || 'Waiting IMU';
    if (gyroValue) gyroValue.innerText =
        movement.gyro_mag !== undefined ? `${Number(movement.gyro_mag).toFixed(1)} dps` : '--';

    const respValue = document.getElementById('resp-value');
    const respStatus = document.getElementById('resp-status');
    const respConfidence = document.getElementById('resp-confidence');

    if (respValue) respValue.innerText =
        respiration.rate_rpm > 0 ? Number(respiration.rate_rpm).toFixed(1) : '--';
    if (respStatus) respStatus.innerText = respiration.status || 'Movement estimate';
    if (respConfidence) respConfidence.innerText =
        respiration.confidence !== undefined ? Number(respiration.confidence).toFixed(2) : '--';
}

function pushDataPoint(dataset, x, y, maxPoints = MAX_POINTS_NOT_RECORDING) {
    dataset.data.push({ x, y: Number(y || 0) });

    if (!isRecording && dataset.data.length > maxPoints) {
        dataset.data.shift();
    }
}

function updateCharts(t, eeg, pct, pulse) {
    pushDataPoint(waveChart.data.datasets[0], t, eeg.dominant_freq || 0);
    pushDataPoint(waveChart.data.datasets[1], t, pct.delta || 0);
    pushDataPoint(waveChart.data.datasets[2], t, pct.theta || 0);
    pushDataPoint(waveChart.data.datasets[3], t, pct.alpha || 0);
    pushDataPoint(waveChart.data.datasets[4], t, pct.beta || 0);
    pushDataPoint(waveChart.data.datasets[5], t, pct.gamma || 0);

    pushDataPoint(pulseChart.data.datasets[0], t, pulse.hr || 0);

    applyTimeWindow(t);

    waveChart.update('none');
    pulseChart.update('none');
}

function applyTimeWindow(currentTime) {
    if (manualZoom && !isRecording) return;

    let min;
    let max;

    if (isRecording && recordingStartTime) {
        min = recordingStartTime;
        max = currentTime;
    } else {
        min = currentTime - LIVE_WINDOW_MS;
        max = currentTime;
    }

    [waveChart, pulseChart].forEach((chart) => {
        chart.options.scales.x.min = min;
        chart.options.scales.x.max = max;
    });
}

function flattenRecord(data) {
    const eeg = getEEG(data);
    const pulse = getPulse(data);
    const spo2 = getSpO2(data);
    const movement = getMovement(data);
    const respiration = getRespiration(data);
    const battery = getBattery(data);

    return {
        time: new Date((data.timestamp || Date.now() / 1000) * 1000).toISOString(),
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
        spo2_confidence: Number(spo2.confidence || 0),
        oxygen_index: Number(spo2.relative_oxygen_index || 0),
        movement_score: Number(movement.movement_score || 0),
        respiration_rate: Number(respiration.rate_rpm || 0),
        battery: Number(battery.level || 0)
    };
}

document.getElementById('btn-connect')?.addEventListener('click', toggleConnect);

document.getElementById('btn-reset-zoom')?.addEventListener('click', resetZoomAll);

document.getElementById('btn-run')?.addEventListener('click', () => {
    isRunning = true;
    document.getElementById('btn-run')?.classList.add('active');
    document.getElementById('btn-hold')?.classList.remove('active');
});

document.getElementById('btn-hold')?.addEventListener('click', () => {
    isRunning = false;
    document.getElementById('btn-hold')?.classList.add('active');
    document.getElementById('btn-run')?.classList.remove('active');
});

document.getElementById('btn-record')?.addEventListener('click', () => {
    isRecording = !isRecording;
    const btn = document.getElementById('btn-record');

    if (isRecording) {
        btn.innerHTML = '<span class="icon">⏹</span> STOP';
        btn.classList.add('active');
        recordedData = [];
        recordingStartTime = nowMs();
        manualZoom = false;
        resetZoomAll();
    } else {
        btn.innerHTML = '<span class="icon">⏺</span> RECORD';
        btn.classList.remove('active');
        showSaveModal();
    }
});

function showSaveModal() {
    const now = new Date();

    document.getElementById('filename-input').value =
        `Athena_Record_${now.toISOString().slice(0, 19).replaceAll(':', '-')}`;

    document.getElementById('notes-input').value = '';
    document.getElementById('modal-save').classList.remove('hidden');
}

document.getElementById('btn-save-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-save').classList.add('hidden');
});

document.getElementById('btn-save-confirm')?.addEventListener('click', () => {
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
        'SpO2Estimate',
        'SpO2Confidence',
        'RelativeOxygenIndex',
        'MovementScore',
        'RespirationRate',
        'Battery'
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
        r.spo2_confidence.toFixed(3),
        r.oxygen_index.toFixed(4),
        r.movement_score.toFixed(2),
        r.respiration_rate.toFixed(2),
        r.battery.toFixed(1)
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
});

document.getElementById('btn-audio')?.addEventListener('click', () => {
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

    if (!audioCtx) audioCtx = new AudioContext();

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
});

ensureWebSocket();
