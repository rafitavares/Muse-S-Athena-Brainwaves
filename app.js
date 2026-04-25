let isRunning = true;
let isRecording = false;
let recordedData = [];
let audioCtx, oscL, oscR;

// Chart.js Estilo Moderno
Chart.defaults.color = '#a1a1aa';
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const commonChartOptions = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false } },
    elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.4 } },
    scales: {
        x: { display: false },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false } }
    }
};

const ctxFreq = document.getElementById('chart-freq').getContext('2d');
const chartFreq = new Chart(ctxFreq, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true }] },
    options: { ...commonChartOptions, scales: { x: { display: true, grid: { display: false } }, y: { ...commonChartOptions.scales.y, title: { display: true, text: 'Hz' } } } }
});

const ctxSpo2 = document.getElementById('chart-spo2').getContext('2d');
const chartSpO2 = new Chart(ctxSpo2, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#3b82f6' }] },
    options: commonChartOptions
});

const ctxPulse = document.getElementById('chart-pulse').getContext('2d');
const chartPulse = new Chart(ctxPulse, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#ef4444' }] },
    options: commonChartOptions
});

document.getElementById('btn-connect').addEventListener('click', () => {
    const statusTxt = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');
    statusTxt.innerText = "Connecting...";
    
    const socket = new WebSocket('ws://localhost:8765');
    
    socket.onopen = () => {
        statusTxt.innerText = "Connected";
        statusDot.className = "dot connected";
    };

    socket.onclose = () => {
        statusTxt.innerText = "Disconnected";
        statusDot.className = "dot disconnected";
    };
    
    socket.onmessage = (e) => {
        if (!isRunning) return;
        const d = JSON.parse(e.data);
        
        // MODIFICAÇÃO: Raio-X dos pacotes chegando. Aparecerá no F12 (Console)
        console.log("Chegou do Python:", d);
        
        const total = d.delta + d.theta + d.alpha + d.beta + d.gamma;
        if(total > 0) {
            ['gamma', 'beta', 'alpha', 'theta', 'delta'].forEach(wave => {
                const p = ((d[wave] / total) * 100).toFixed(1);
                document.getElementById(`bar-${wave}`).style.width = p + '%';
                document.getElementById(`txt-${wave}`).innerText = p + '%';
            });
        }

        const time = new Date().toLocaleTimeString();
        [chartFreq, chartSpO2, chartPulse].forEach((c, i) => {
            const val = [d.dominant_freq, d.spo2, d.hr][i];
            c.data.labels.push(time);
            c.data.datasets[0].data.push(val);
            if(c.data.labels.length > 60) { c.data.labels.shift(); c.data.datasets[0].data.shift(); }
            c.update();
        });

        if (isRecording) recordedData.push({ time, ...d });
    };
});

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
    document.getElementById('filename-input').value = `Athena_Record_${now.toLocaleDateString().replace(/\//g, '.')}`;
    document.getElementById('notes-input').value = '';
    document.getElementById('modal-save').classList.remove('hidden');
}

document.getElementById('btn-save-cancel').onclick = () => {
    document.getElementById('modal-save').classList.add('hidden');
};

document.getElementById('btn-save-confirm').onclick = () => {
    const filename = document.getElementById('filename-input').value || "Data";
    const notes = document.getElementById('notes-input').value.replace(/\n/g, ' ');
    
    let csv = "data:text/csv;charset=utf-8,Context/Notes: " + notes + "\n\n";
    csv += "Time,Delta,Theta,Alpha,Beta,Gamma,DominantFreq,SpO2,HeartRate\n";
    csv += recordedData.map(r => `${r.time},${r.delta.toFixed(4)},${r.theta.toFixed(4)},${r.alpha.toFixed(4)},${r.beta.toFixed(4)},${r.gamma.toFixed(4)},${r.dominant_freq.toFixed(2)},${r.spo2.toFixed(1)},${r.hr.toFixed(1)}`).join("\n");
    
    const link = document.createElement("a");
    link.href = encodeURI(csv);
    link.download = filename + ".csv";
    link.click();
    document.getElementById('modal-save').classList.add('hidden');
};

document.getElementById('btn-audio').onclick = () => {
    const btn = document.getElementById('btn-audio');
    
    if (oscL) { 
        oscL.stop(); oscR.stop(); 
        oscL = null; oscR = null;
        btn.innerText = "Start Synth";
        btn.classList.remove('active');
        return; 
    }
    
    if (!audioCtx) audioCtx = new AudioContext();
    
    const target = parseFloat(document.getElementById('bin-target').value);
    const carrier = parseFloat(document.getElementById('bin-carrier').value);
    
    oscL = audioCtx.createOscillator();
    oscR = audioCtx.createOscillator();
    const pL = audioCtx.createStereoPanner();
    const pR = audioCtx.createStereoPanner();
    
    pL.pan.value = -1; 
    pR.pan.value = 1;  
    
    oscL.frequency.value = carrier;
    oscR.frequency.value = carrier + target;
    
    oscL.connect(pL).connect(audioCtx.destination);
    oscR.connect(pR).connect(audioCtx.destination);
    
    oscL.start(); oscR.start();
    
    btn.innerText = "Stop Synth";
    btn.classList.add('active');
};