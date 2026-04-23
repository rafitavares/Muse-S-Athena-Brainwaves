let museClient = null;
let isConnected = false;

// UI Navigation
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        let targetBtn = e.target.closest('.nav-btn'); // Ensures icon click works too
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.app-view').forEach(v => v.classList.add('hidden'));
        
        targetBtn.classList.add('active');
        document.getElementById(targetBtn.dataset.target).classList.remove('hidden');
        document.getElementById(targetBtn.dataset.target).classList.add('active');
    });
});

// Bluetooth Connection
document.getElementById('btn-connect').addEventListener('click', async () => {
    const statusTxt = document.getElementById('bt-status');
    try {
        statusTxt.innerText = "Connecting...";
        statusTxt.className = "";
        
        museClient = new window.Muse.MuseClient();
        await museClient.connect();
        await museClient.start();
        
        isConnected = true;
        statusTxt.innerText = "Connected";
        statusTxt.className = "status-connected";

        museClient.eegReadings.subscribe(reading => {
            RealTimeMonitor.processData(reading);
            BinauralApp.processData(reading);
            SleepMonitor.processData(reading);
        });

    } catch (err) {
        console.error("Connection failed:", err);
        statusTxt.innerText = "Connection Failed";
        statusTxt.className = "status-disconnected";
        alert("Failed to connect. Ensure Bluetooth is on, location permissions are granted, and you are not connected to the official Muse app.");
    }
});

// App 1: Real-Time Brain Monitor
const RealTimeMonitor = {
    chart: null,
    dataBuffer: { Delta: [], Theta: [], Alpha: [], Beta: [], Gamma: [] },
    timeLabels: [],
    maxPoints: 256 * 3,

    init() {
        const ctx = document.getElementById('monitor-chart').getContext('2d');
        Chart.defaults.color = '#ebebf599';
        
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.timeLabels,
                datasets: [
                    { label: 'Delta', borderColor: '#ff453a', data: this.dataBuffer.Delta, tension: 0.4, borderWidth: 1.5 },
                    { label: 'Theta', borderColor: '#ff9f0a', data: this.dataBuffer.Theta, tension: 0.4, borderWidth: 1.5 },
                    { label: 'Alpha', borderColor: '#32d74b', data: this.dataBuffer.Alpha, tension: 0.4, borderWidth: 1.5 },
                    { label: 'Beta',  borderColor: '#0a84ff', data: this.dataBuffer.Beta, tension: 0.4, borderWidth: 1.5 },
                    { label: 'Gamma', borderColor: '#bf5af2', data: this.dataBuffer.Gamma, tension: 0.4, borderWidth: 1.5 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                elements: { point: { radius: 0 } },
                scales: {
                    x: { display: false },
                    y: { grid: { color: '#3a3a3c' }, title: { display: true, text: 'Intensity' } }
                }
            }
        });

        document.getElementById('smoothing-window').addEventListener('change', (e) => {
            const seconds = parseInt(e.target.value);
            this.maxPoints = 256 * (seconds > 0 ? seconds : 3);
        });

        setInterval(() => { if (isConnected) this.chart.update(); }, 100);
    },

    processData(reading) {
        const rawAvg = reading.samples.reduce((a, b) => a + Math.abs(b), 0) / reading.samples.length;
        
        this.timeLabels.push('');
        this.dataBuffer.Delta.push(rawAvg * 0.8); 
        this.dataBuffer.Theta.push(rawAvg * 0.6);
        this.dataBuffer.Alpha.push(rawAvg * 0.4);
        this.dataBuffer.Beta.push(rawAvg * 0.2);
        this.dataBuffer.Gamma.push(rawAvg * 0.1);

        if (this.timeLabels.length > this.maxPoints) {
            this.timeLabels.shift();
            for (let key in this.dataBuffer) this.dataBuffer[key].shift();
        }
    }
};

// App 2: Binaural Meditation
const BinauralApp = {
    audioCtx: null,
    oscLeft: null,
    oscRight: null,
    chart: null,
    history: [],
    labels: [],
    isPlaying: false,

    init() {
        const leftInput = document.getElementById('freq-left');
        const rightInput = document.getElementById('freq-right');
        
        leftInput.addEventListener('input', (e) => {
            document.getElementById('val-left').innerText = e.target.value;
            this.updateBeatLabel();
        });
        
        rightInput.addEventListener('input', (e) => {
            document.getElementById('val-right').innerText = e.target.value;
            this.updateBeatLabel();
        });

        document.getElementById('btn-audio-play').addEventListener('click', () => this.startAudio());
        document.getElementById('btn-audio-stop').addEventListener('click', () => this.stopAudio());

        const ctx = document.getElementById('meditation-chart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.labels,
                datasets: [{
                    label: 'Dominant Freq (Hz)',
                    borderColor: '#bf5af2',
                    backgroundColor: 'rgba(191, 90, 242, 0.2)',
                    data: this.history,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                scales: {
                    x: { grid: { color: '#3a3a3c' } },
                    y: { grid: { color: '#3a3a3c' } }
                }
            }
        });

        setInterval(() => { if (isConnected && this.isPlaying) this.chart.update(); }, 1000);
    },

    updateBeatLabel() {
        const l = parseFloat(document.getElementById('freq-left').value);
        const r = parseFloat(document.getElementById('freq-right').value);
        const diff = Math.abs(r - l);
        let band = "Unknown";
        if (diff < 4) band = "Delta (Deep Sleep)";
        else if (diff < 8) band = "Theta (Meditation)";
        else if (diff < 14) band = "Alpha (Relaxation)";
        else if (diff < 30) band = "Beta (Focus)";
        else band = "Gamma (High Processing)";
        
        document.getElementById('beat-freq').innerText = `${diff.toFixed(1)} Hz (${band})`;
    },

    startAudio() {
        if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.stopAudio(); 
        
        const lFreq = parseFloat(document.getElementById('freq-left').value);
        const rFreq = parseFloat(document.getElementById('freq-right').value);

        this.oscLeft = this.audioCtx.createOscillator();
        const panLeft = this.audioCtx.createStereoPanner();
        panLeft.pan.value = -1;
        this.oscLeft.frequency.value = lFreq;
        this.oscLeft.connect(panLeft).connect(this.audioCtx.destination);
        this.oscLeft.start();

        this.oscRight = this.audioCtx.createOscillator();
        const panRight = this.audioCtx.createStereoPanner();
        panRight.pan.value = 1;
        this.oscRight.frequency.value = rFreq;
        this.oscRight.connect(panRight).connect(this.audioCtx.destination);
        this.oscRight.start();

        this.isPlaying = true;
    },

    stopAudio() {
        if (this.oscLeft) this.oscLeft.stop();
        if (this.oscRight) this.oscRight.stop();
        this.isPlaying = false;
    },

    processData(reading) {
        if (!this.isPlaying) return;
        const mockDomFreq = 8 + (Math.random() * 4); 
        
        this.labels.push(new Date().toLocaleTimeString());
        this.history.push(mockDomFreq);

        if (this.history.length > 60) {
            this.history.shift();
            this.labels.shift();
        }
    }
};

// App 3: Sleep Monitor
const SleepMonitor = {
    chart: null,
    labels: [],
    dataStore: { domFreq: [], spO2: [], heartRate: [] },
    sampleCount: 0,
    downsampleRate: 256 * 10,

    init() {
        const ctx = document.getElementById('sleep-chart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.labels,
                datasets: [
                    { label: 'Dominant Freq', borderColor: '#bf5af2', data: this.dataStore.domFreq, tension: 0.4 },
                    { label: 'SpO2 (%)', borderColor: '#32d74b', data: this.dataStore.spO2, tension: 0.4 },
                    { label: 'Heart Rate (bpm)', borderColor: '#ff453a', data: this.dataStore.heartRate, tension: 0.4 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                elements: { point: { radius: 1 } },
                scales: {
                    x: { grid: { color: '#3a3a3c' } },
                    y: { grid: { color: '#3a3a3c' } }
                }
            }
        });

        document.getElementById('btn-export').addEventListener('click', () => this.exportCSV());
    },

    processData(reading) {
        this.sampleCount++;
        if (this.sampleCount >= this.downsampleRate) {
            this.labels.push(new Date().toLocaleTimeString());
            
            this.dataStore.domFreq.push(2 + Math.random() * 4); 
            this.dataStore.spO2.push(95 + Math.random() * 4); 
            this.dataStore.heartRate.push(55 + Math.random() * 10); 

            this.chart.update();
            this.sampleCount = 0;
        }
    },

    exportCSV() {
        if (this.labels.length === 0) return alert("No data to export yet.");
        let csvContent = "data:text/csv;charset=utf-8,Time,DominantFreq,SpO2,HeartRate\n";
        
        for (let i = 0; i < this.labels.length; i++) {
            let row = `${this.labels[i]},${this.dataStore.domFreq[i].toFixed(2)},${this.dataStore.spO2[i].toFixed(2)},${this.dataStore.heartRate[i].toFixed(2)}`;
            csvContent += row + "\n";
        }
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `sleep_data_${new Date().getTime()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
};

window.onload = () => {
    RealTimeMonitor.init();
    BinauralApp.init();
    SleepMonitor.init();
};