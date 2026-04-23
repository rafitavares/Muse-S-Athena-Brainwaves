// ==========================================
// 1. GLOBAL STATE & UI ROUTING
// ==========================================
let museClient = null;
let isConnected = false;

// UI Navigation
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.app-view').forEach(v => v.classList.add('hidden'));
        
        e.target.classList.add('active');
        document.getElementById(e.target.dataset.target).classList.remove('hidden');
        document.getElementById(e.target.dataset.target).classList.add('active');
    });
});

// ==========================================
// 2. BLUETOOTH CONNECTION (MUSE S)
// ==========================================
document.getElementById('btn-connect').addEventListener('click', async () => {
    const statusTxt = document.getElementById('bt-status');
    try {
        statusTxt.innerText = "Connecting...";
        statusTxt.className = "";
        
        museClient = new window.Muse.MuseClient();
        await museClient.connect();
        await museClient.start();
        
        isConnected = true;
        statusTxt.innerText = "Connected to Athena";
        statusTxt.className = "status-connected";

        // Route data to our active modules
        museClient.eegReadings.subscribe(reading => {
            RealTimeMonitor.processData(reading);
            BinauralApp.processData(reading);
            SleepMonitor.processData(reading);
        });

    } catch (err) {
        console.error("Connection failed:", err);
        statusTxt.innerText = "Connection Failed";
        statusTxt.className = "status-disconnected";
        alert("Failed to connect. Ensure Bluetooth is on, location permissions are granted, and you are using Chrome/Edge.");
    }
});

// ==========================================
// 3. APP 1: REAL-TIME BRAIN MONITOR
// ==========================================
const RealTimeMonitor = {
    chart: null,
    dataBuffer: { Delta: [], Theta: [], Alpha: [], Beta: [], Gamma: [] },
    timeLabels: [],
    maxPoints: 256 * 3, // Default 3 seconds at 256Hz

    init() {
        const ctx = document.getElementById('monitor-chart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.timeLabels,
                datasets: [
                    { label: 'Delta', borderColor: '#ff5252', data: this.dataBuffer.Delta, tension: 0.4, borderWidth: 1 },
                    { label: 'Theta', borderColor: '#ffab40', data: this.dataBuffer.Theta, tension: 0.4, borderWidth: 1 },
                    { label: 'Alpha', borderColor: '#69f0ae', data: this.dataBuffer.Alpha, tension: 0.4, borderWidth: 1 },
                    { label: 'Beta',  borderColor: '#448aff', data: this.dataBuffer.Beta, tension: 0.4, borderWidth: 1 },
                    { label: 'Gamma', borderColor: '#e040fb', data: this.dataBuffer.Gamma, tension: 0.4, borderWidth: 1 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false, // Turn off animation for real-time performance
                elements: { point: { radius: 0 } }, // Hide dots for clean lines
                scales: {
                    x: { display: false }, // Hide x-axis clutter
                    y: { title: { display: true, text: 'Intensity' } }
                }
            }
        });

        document.getElementById('smoothing-window').addEventListener('change', (e) => {
            const seconds = parseInt(e.target.value);
            this.maxPoints = 256 * (seconds > 0 ? seconds : 3);
        });

        // Update chart visually every 100ms to save CPU
        setInterval(() => { if (isConnected) this.chart.update(); }, 100);
    },

    processData(reading) {
        // To simulate FFT without a heavy library, we apply arbitrary moving 
        // averages based on the raw amplitude to mock the bands visually.
        // In a clinical setup, replace this with an actual FFT processing step.
        const rawAvg = reading.samples.reduce((a, b) => a + Math.abs(b), 0) / reading.samples.length;
        
        this.timeLabels.push('');
        this.dataBuffer.Delta.push(rawAvg * 0.8); 
        this.dataBuffer.Theta.push(rawAvg * 0.6);
        this.dataBuffer.Alpha.push(rawAvg * 0.4);
        this.dataBuffer.Beta.push(rawAvg * 0.2);
        this.dataBuffer.Gamma.push(rawAvg * 0.1);

        // Keep buffer size within the Smoothing Window
        if (this.timeLabels.length > this.maxPoints) {
            this.timeLabels.shift();
            for (let key in this.dataBuffer) this.dataBuffer[key].shift();
        }
    }
};

// ==========================================
// 4. APP 2: BINAURAL MEDITATION
// ==========================================
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
                    label: 'Dominant Brain Freq (Hz)',
                    borderColor: '#bb86fc',
                    backgroundColor: 'rgba(187, 134, 252, 0.2)',
                    data: this.history,
                    fill: true
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
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
        
        this.stopAudio(); // Reset if already playing
        
        const lFreq = parseFloat(document.getElementById('freq-left').value);
        const rFreq = parseFloat(document.getElementById('freq-right').value);

        // Left Ear
        this.oscLeft = this.audioCtx.createOscillator();
        const panLeft = this.audioCtx.createStereoPanner();
        panLeft.pan.value = -1;
        this.oscLeft.frequency.value = lFreq;
        this.oscLeft.connect(panLeft).connect(this.audioCtx.destination);
        this.oscLeft.start();

        // Right Ear
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
        // Mocking dominant frequency derivation from raw signal for execution.
        const mockDomFreq = 8 + (Math.random() * 4); // Simulating Alpha (8-12Hz)
        
        this.labels.push(new Date().toLocaleTimeString());
        this.history.push(mockDomFreq);

        if (this.history.length > 60) { // Keep last 60 seconds
            this.history.shift();
            this.labels.shift();
        }
    }
};

// ==========================================
// 5. APP 3: SLEEP MONITOR (LONG DURATION)
// ==========================================
const SleepMonitor = {
    chart: null,
    labels: [],
    dataStore: { domFreq: [], spO2: [], heartRate: [] },
    sampleCount: 0,
    downsampleRate: 256 * 10, // Average every 10 seconds of data to save memory

    init() {
        const ctx = document.getElementById('sleep-chart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.labels,
                datasets: [
                    { label: 'Dominant Freq', borderColor: '#bb86fc', data: this.dataStore.domFreq, hidden: false },
                    { label: 'SpO2 (%)', borderColor: '#03dac6', data: this.dataStore.spO2, hidden: false },
                    { label: 'Heart Rate (bpm)', borderColor: '#cf6679', data: this.dataStore.heartRate, hidden: false }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false }, // Interactive selection
                plugins: { zoom: { zoom: { wheel: { enabled: true }, pinch: { enabled: true } } } } // Requires chartjs-plugin-zoom in future if needed
            }
        });

        document.getElementById('btn-export').addEventListener('click', () => this.exportCSV());
    },

    processData(reading) {
        this.sampleCount++;
        // We only push a data point to the graph once every X samples to prevent browser memory crashes over 10 hours.
        if (this.sampleCount >= this.downsampleRate) {
            this.labels.push(new Date().toLocaleTimeString());
            
            // Simulating Sleep Metrics derived from connection stream
            this.dataStore.domFreq.push(2 + Math.random() * 4); // Delta/Theta sleep waves
            this.dataStore.spO2.push(95 + Math.random() * 4); // SpO2 Simulation
            this.dataStore.heartRate.push(55 + Math.random() * 10); // Sleep HR Simulation

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

// Initialize Modules on Load
window.onload = () => {
    RealTimeMonitor.init();
    BinauralApp.init();
    SleepMonitor.init();
};app.js