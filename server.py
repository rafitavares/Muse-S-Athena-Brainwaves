import asyncio
import websockets
import json
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds

async def stream_muse(websocket):
    # Board ID 39 é o código oficial do BrainFlow para Muse S nativo via Bluetooth
    params = BrainFlowInputParams()
    board = BoardShim(BoardIds.MUSE_S_BOARD, params)
    
    try:
        print("Procurando e conectando à Muse S Athena...")
        board.prepare_session()
        board.start_stream()
        print("✅ Conectado com sucesso! Transmitindo dados para o navegador...")

        while True:
            # Pega as últimas amostras de dados
            data = board.get_current_board_data(256)
            
            if data.shape[1] > 0:
                # Pegando o canal EEG TP9 para extrair a amplitude 
                eeg_channel = BoardShim.get_eeg_channels(BoardIds.MUSE_S_BOARD)[0]
                raw_data = data[eeg_channel]
                
                # Simulando a média de amplitude para manter o gráfico visual rodando
                # (Futuramente aplicaremos o FFT real aqui no Python)
                avg_amplitude = sum(abs(x) for x in raw_data) / len(raw_data)
                
                # Empacota em JSON e envia pelo túnel
                payload = {
                    "type": "eeg",
                    "amplitude": avg_amplitude
                }
                await websocket.send(json.dumps(payload))
            
            # Pausa rápida para não sobrecarregar o processador
            await asyncio.sleep(0.1) 
            
    except websockets.exceptions.ConnectionClosed:
        print("Navegador desconectado.")
    except Exception as e:
        print(f"Erro no Bluetooth: {e}")
    finally:
        if board.is_prepared():
            board.stop_stream()
            board.release_session()
            print("Sessão da Muse encerrada e hardware liberado.")

async def main():
    print("🚀 Motor Python iniciado!")
    print("Aguardando o navegador se conectar em ws://localhost:8765...")
    # Cria o servidor WebSocket na porta 8765
    async with websockets.serve(stream_muse, "localhost", 8765):
        await asyncio.Future()  # Mantém rodando para sempre

if __name__ == "__main__":
    asyncio.run(main())