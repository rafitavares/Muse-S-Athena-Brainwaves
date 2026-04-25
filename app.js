let isRunning = true;
let isRecording = false;
let recordedData = [];
let audioCtx, oscL, oscR;

// Gráficos
const setupChart = (id, label, color) => new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, tension: 0.3, pointRadius: 0 }] },
    options: { maintainAspectRatio: false, scales: { x: { display: false }, y: { grid: { color: '#333' } } } }
});

const chartFreq = setupChart('chart-freq', 'Dominant Frequency (Hz)', '#34c759');
const chartSpO2 = setupChart('chart-spo2', 'SpO2 (%)', '#007aff');
const chartPulse = setupChart('chart-pulse', 'Pulse (BPM)', '#ff3b30');

// Conexão Motor Python
document.getElementById('btn-connect').addEventListener('click', () => {
    const socket = new WebSocket('ws://localhost:8765');
    
    socket.onmessage = (e) => {
        if (!isRunning) return;
        const d = JSON.parse(e.data);
        
        // Atualiza Percentuais
        const total = d.delta + d.theta + d.alpha + d.beta + d.gamma;
        ['delta', 'theta', 'alpha', 'beta', 'gamma'].forEach(wave => {
            const p = ((d[wave] / total) * 100).toFixed(1);
            document.getElementById(`bar-${wave}`).style.width = p + '%';
            document.getElementById(`txt-${wave}`).innerText = p + '%';
        });

        // Atualiza Gráficos
        const time = new Date().toLocaleTimeString();
        [chartFreq, chartSpO2, chartPulse].forEach((c, i) => {
            const val = [d.dominant_freq, d.spo2, d.hr][i];
            c.data.labels.push(time);
            c.data.datasets[0].data.push(val);
            if(c.data.labels.length > 50) { c.data.labels.shift(); c.data.datasets[0].data.shift(); }
            c.update();
        });

        if (isRecording) recordedData.push({ time, ...d });
    };
});

// Controles Record/Run/Hold
document.getElementById('btn-run').onclick = () => { isRunning = true; toggleBtn('btn-run'); };
document.getElementById('btn-hold').onclick = () => { isRunning = false; toggleBtn('btn-hold'); };

document.getElementById('btn-record').onclick = () => {
    isRecording = !isRecording;
    const btn = document.getElementById('btn-record');
    if (isRecording) {
        btn.innerHTML = '⏹ Stop';
        btn.classList.add('active');
        recordedData = [];
    } else {
        btn.innerHTML = '⏺ Record';
        btn.classList.remove('active');
        showModal();
    }
};

const toggleBtn = (id) => {
    document.querySelectorAll('.main-controls .btn').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
};

// Modal e Save
function showModal() {
    const now = new Date();
    document.getElementById('filename-input').value = `Record_${now.toLocaleDateString().replace(/\//g, '.')}`;
    document.getElementById('modal-save').classList.remove('hidden');
}

document.getElementById('btn-save-confirm').onclick = () => {
    const filename = document.getElementById('filename-input').value;
    const notes = document.getElementById('notes-input').value;
    const csv = "data:text/csv;charset=utf-8,Notes: " + notes + "\n" + 
                "Time,Delta,Theta,Alpha,Beta,Gamma,Freq,SpO2,HR\n" + 
                recordedData.map(r => Object.values(r).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = encodeURI(csv);
    link.download = filename + ".csv";
    link.click();
    document.getElementById('modal-save').classList.add('hidden');
};

// Binaural Logic
document.getElementById('btn-audio').onclick = () => {
    if (!audioCtx) audioCtx = new AudioContext();
    if (oscL) { oscL.stop(); oscR.stop(); oscL = null; return; }
    
    const target = parseFloat(document.getElementById('bin-target').value);
    const carrier = parseFloat(document.getElementById('bin-carrier').value);
    
    oscL = audioCtx.createOscillator();
    oscR = audioCtx.createOscillator();
    const pL = audioCtx.createStereoPanner();
    const pR = audioCtx.createStereoPanner();
    
    pL.pan.value = -1; pR.pan.value = 1;
    oscL.frequency.value = carrier;
    oscR.frequency.value = carrier + target;
    
    oscL.connect(pL).connect(audioCtx.destination);
    oscR.connect(pR).connect(audioCtx.destination);
    oscL.start(); oscR.start();
};