# Muse S Athena Brain analyses - UI v3

## Layout corrigido

Topo:
- Nome do programa à esquerda.
- RUN / HOLD / RECORD / RESET ZOOM no centro.
- Qualidade EEG, bateria e botão CONECTAR/DESCONECTAR à direita.

Gráficos:
- Gráfico Brain Waves no topo.
- Checkboxes das ondas no lado direito do header do gráfico.
- Gráfico Pulse Rate abaixo, com o mesmo tamanho do gráfico de ondas.
- Eixo X com horário real.
- Zoom com scroll no eixo X.
- Zoom sincronizado entre Brain Waves e Pulse Rate.

Boxes abaixo:
1. SpO₂
2. Binaural
3. Brain Waves %
4. Posture / Movement
5. Respiration

## Rodar

```bash
pip install -r requirements.txt
python server.py --address 3C067C59-0CDE-0F3A-11D6-9CA236A53CEA
```

Depois abra:

```text
http://localhost:8765
```

## Nota

Nesta versão removi a dependência do adaptador de data do Chart.js.
O eixo X agora usa timestamp numérico com formatação manual de horário, mais estável no browser.
