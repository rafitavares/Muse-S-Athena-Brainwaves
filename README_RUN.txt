# Athena Modular Dashboard

## Arquivos principais

- `server.py`: cérebro principal. Serve a interface, conecta na Muse e controla os módulos.
- `EEG.py`: módulo de EEG.
- `pulse.py`: módulo de pulso/BPM a partir dos dados ópticos.
- `SpO2.py`: módulo reservado para oxigenação. Ainda não entrega SpO2 clínico calibrado.
- `index.html`: interface web.
- `app.js`: lógica do browser/WebSocket/gráficos.
- `style.css`: estilo visual.

## Instalação

```bash
pip install -r requirements.txt
```

## Rodar

```bash
python server.py
```

Depois abra:

```text
http://localhost:8765
```

## Rodar usando endereço específico da Muse

```bash
python server.py --address 3C067C59-0CDE-0F3A-11D6-9CA236A53CEA
```

## Parâmetros úteis

```bash
python server.py --eeg-window 5
python server.py --eeg-channel TP9
python server.py --preset p1035
```

## Observação sobre SpO2

O módulo `SpO2.py` está estruturalmente pronto, mas não inventa saturação.
Muse Athena fornece dados ópticos brutos; SpO2 clínico exige calibração e identificação correta dos canais red/IR.
