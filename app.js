// ==========================================
// 2. WEBSOCKET CONNECTION (PYTHON BRIDGE)
// ==========================================
document.getElementById('btn-connect').addEventListener('click', () => {
    const statusTxt = document.getElementById('bt-status');
    statusTxt.innerText = "Connecting to Motor...";
    statusTxt.className = "";

    // Conecta ao servidor Python local
    const socket = new WebSocket('ws://localhost:8765');

    socket.onopen = () => {
        isConnected = true;
        statusTxt.innerText = "Connected";
        statusTxt.className = "status-connected";
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === "eeg") {
            // Adapta a mensagem do Python para o formato que os seus gráficos já conhecem
            const mockReading = { samples: [data.amplitude] };
            RealTimeMonitor.processData(mockReading);
            BinauralApp.processData(mockReading);
            SleepMonitor.processData(mockReading);
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
        statusTxt.innerText = "Connection Failed";
        statusTxt.className = "status-disconnected";
        alert("Cannot connect to Python. Make sure you run 'python server.py' in your terminal first!");
    };
    
    socket.onclose = () => {
        isConnected = false;
        statusTxt.innerText = "Disconnected";
        statusTxt.className = "status-disconnected";
    };
});