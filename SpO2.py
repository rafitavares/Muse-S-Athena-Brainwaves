"""
SpO2.py
-------
Módulo experimental para estimativa de SpO₂ a partir dos dados ópticos da Muse S Athena.

Atenção:
- Isto NÃO é calibração médica.
- A Muse envia dados ópticos brutos.
- Este módulo estima tendência usando uma aproximação clássica:
  R = (AC_red / DC_red) / (AC_ir / DC_ir)
  SpO2 ≈ 110 - 25R

Para pesquisa pessoal/tendência, não para decisão médica.
"""

from collections import deque
from typing import List

import numpy as np
from scipy import signal


def unpack_uint20_le(block: bytes) -> List[int]:
    values = []
    acc = 0
    bits = 0

    for b in block:
        acc |= b << bits
        bits += 8

        while bits >= 20:
            values.append(acc & 0xFFFFF)
            acc >>= 20
            bits -= 20

    return values


class SpO2Module:
    def __init__(self, sample_rate: int = 64, window_seconds: int = 10):
        self.sample_rate = sample_rate
        self.window_seconds = window_seconds
        self.maxlen = sample_rate * window_seconds

        # Para Athena 0x34, implementação pública indica:
        # channels 0-2 = ambient, infrared, red.
        self.ambient = deque(maxlen=self.maxlen)
        self.ir = deque(maxlen=self.maxlen)
        self.red = deque(maxlen=self.maxlen)

        self.samples_received = 0

        self.last_state = {
            "spo2": 0.0,
            "confidence": 0.0,
            "relative_oxygen_index": 0.0,
            "ratio_r": 0.0,
            "status": "Aguardando óptico",
            "samples": 0,
        }

    def process_tag(self, tag: int, payload: bytes) -> None:
        if tag not in (0x34, 0x35, 0x36):
            return

        values = unpack_uint20_le(payload)

        # 0x34: 12 valores = 3 amostras x 4 canais.
        # Canais comuns no Athena: ambient, IR, red, extra.
        for i in range(0, len(values), 4):
            group = values[i:i + 4]
            if len(group) == 4:
                self.ambient.append(group[0])
                self.ir.append(group[1])
                self.red.append(group[2])
                self.samples_received += 1

    def _bandpass_ppg(self, x: np.ndarray) -> np.ndarray:
        nyq = self.sample_rate / 2
        b, a = signal.butter(3, [0.5 / nyq, 4.0 / nyq], btype="bandpass")
        return signal.filtfilt(b, a, signal.detrend(x))

    def compute(self) -> dict:
        min_samples = self.sample_rate * 6

        if len(self.red) < min_samples or len(self.ir) < min_samples:
            self.last_state = {
                "spo2": 0.0,
                "confidence": 0.0,
                "relative_oxygen_index": 0.0,
                "ratio_r": 0.0,
                "status": "Aguardando dados ópticos",
                "samples": self.samples_received,
            }
            return self.last_state

        red = np.asarray(self.red, dtype=float)
        ir = np.asarray(self.ir, dtype=float)

        red_dc = float(np.mean(red))
        ir_dc = float(np.mean(ir))

        if red_dc <= 0 or ir_dc <= 0 or np.std(red) < 1e-6 or np.std(ir) < 1e-6:
            self.last_state = {
                "spo2": 0.0,
                "confidence": 0.0,
                "relative_oxygen_index": 0.0,
                "ratio_r": 0.0,
                "status": "Sinal óptico instável",
                "samples": self.samples_received,
            }
            return self.last_state

        try:
            red_ac_signal = self._bandpass_ppg(red)
            ir_ac_signal = self._bandpass_ppg(ir)
            red_ac = float(np.sqrt(np.mean(red_ac_signal ** 2)))
            ir_ac = float(np.sqrt(np.mean(ir_ac_signal ** 2)))
        except Exception:
            red_ac = float(np.std(red))
            ir_ac = float(np.std(ir))

        if ir_ac <= 0:
            ratio = 0.0
        else:
            ratio = (red_ac / red_dc) / (ir_ac / ir_dc)

        # Fórmula aproximada comum para ratio-of-ratios.
        spo2 = 110.0 - 25.0 * ratio
        spo2 = float(max(70.0, min(100.0, spo2)))

        # Confiança simples: sinal AC suficiente e ratio plausível.
        perfusion = min(1.0, max(0.0, (ir_ac / ir_dc) * 5000.0))
        ratio_ok = 1.0 if 0.4 <= ratio <= 1.6 else 0.35
        confidence = float(max(0.0, min(1.0, perfusion * ratio_ok)))

        if confidence < 0.25:
            status = "Estimativa fraca / ajuste a faixa"
        else:
            status = "Estimativa experimental"

        self.last_state = {
            "spo2": spo2,
            "confidence": confidence,
            "relative_oxygen_index": float(ratio),
            "ratio_r": float(ratio),
            "status": status,
            "samples": self.samples_received,
        }

        return self.last_state
