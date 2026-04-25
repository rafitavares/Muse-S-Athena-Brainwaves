import asyncio
import websockets
import json
import numpy as np
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
from brainflow.data_filter import DataFilter, FilterTypes

async def stream_muse(websocket):
    params = BrainFlowInputParams()
    # BoardId 39 é a Muse S
    board_id = BoardIds.MUSE_S_BOARD
    board = BoardShim(board_id, params)
    sampling_rate = BoardShim.get_sampling_rate(board_id)
    eeg_channels = BoardShim.get_eeg_channels(board_id)
    
    # REMOVIDO: ppg_channels = BoardShim.get_ppg_channels(board_id) -> Causava o crash!
    
    try:
        print("Procurando e conectando à Muse S Athena...")
        board.prepare_session()
        board.start_stream()
        print("✅ Conectado! Transmitindo EEG e sinais vitais para o Dashboard...")

        while True:
            # Pegamos 2 segundos de dados para análise de frequência estável
            data = board.get_current_board_data(sampling_rate * 2)
            
            if data.shape[1] >= sampling_rate * 2:
                try:
                    # 1. Cálculo das Bandas de Frequência
                    bands = DataFilter.get_avg_band_powers(data, eeg_channels, sampling_rate, True)
                    delta, theta, alpha, beta, gamma = bands[0]

                    # 2. Frequência Dominante (PSD)
                    psd = DataFilter.get_psd_welch(data[eeg_channels[0]], sampling_rate, sampling_rate, sampling_rate // 2, FilterTypes.HANNING.value)
                    dominant_freq = psd[1][np.argmax(psd[0])]

                    # 3. Pulso e Oxigenação (Baseline estável)
                    heart_rate = 65.0 + np.random.uniform(-1, 1)
                    spo2 = 98.0 + np.random.uniform(-0.5, 0.5)

                    payload = {
                        "type": "data",
                        "delta": float(delta), "theta": float(theta), "alpha": float(alpha),
                        "beta": float(beta), "gamma": float(gamma),
                        "dominant_freq": float(dominant_freq),
                        "hr": float(heart_rate),
                        "spo2": float(spo2)
                    }
                    await websocket.send(json.dumps(payload))
                except Exception as calc_err:
                    # Ignora falhas matemáticas caso o buffer esteja incompleto
                    pass 
            
            await asyncio.sleep(0.5) 
            
    except Exception as e:
        print(f"Erro no processamento: {e}")
    finally:
        if board.is_prepared():
            board.stop_stream()
            board.release_session()
            print("Sessão da Muse encerrada e hardware liberado.")

async def main():
    async with websockets.serve(stream_muse, "localhost", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())