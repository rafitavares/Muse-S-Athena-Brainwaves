"""
SpO2.py
-------
Módulo reservado para oxigenação.

Importante:
A Muse S Athena fornece dados ópticos brutos. SpO₂ clínico exige saber canais
red/IR corretos e curva de calibração. Por isso este módulo NÃO inventa SpO₂.
Ele mantém a estrutura pronta para calibração futura.
"""

from collections import deque
from typing import List

import numpy as np


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

        self.red_like = deque(maxlen=self.maxlen)
        self.ir_like = deque(maxlen=self.maxlen)
        self.samples_received = 0

        self.last_state = {
            "spo2": 0.0,
            "relative_oxygen_index": 0.0,
            "status": "SpO₂ não calibrado",
            "samples": 0,
        }

    def process_tag(self, tag: int, payload: bytes) -> None:
        if tag not in (0x34, 0x35, 0x36):
            return

        values = unpack_uint20_le(payload)

        # Placeholder: usa dois canais ópticos como sinais relativos.
        # Não assumir que isto é red/IR real sem validação.
        for i in range(0, len(values), 4):
            group = values[i:i + 4]
            if len(group) == 4:
                self.red_like.append(group[0])
                self.ir_like.append(group[1])
                self.samples_received += 1

    def compute(self) -> dict:
        if len(self.red_like) < self.sample_rate * 5 or len(self.ir_like) < self.sample_rate * 5:
            self.last_state = {
                "spo2": 0.0,
                "relative_oxygen_index": 0.0,
                "status": "Aguardando dados ópticos",
                "samples": self.samples_received,
            }
            return self.last_state

        red = np.asarray(self.red_like, dtype=float)
        ir = np.asarray(self.ir_like, dtype=float)

        red_dc = float(np.mean(red))
        ir_dc = float(np.mean(ir))
        red_ac = float(np.std(red))
        ir_ac = float(np.std(ir))

        if red_dc <= 0 or ir_dc <= 0 or ir_ac <= 0:
            ratio = 0.0
        else:
            ratio = (red_ac / red_dc) / (ir_ac / ir_dc)

        # NÃO é SpO₂ clínico. É apenas índice relativo para debug futuro.
        relative_index = float(ratio)

        self.last_state = {
            "spo2": 0.0,
            "relative_oxygen_index": relative_index,
            "status": "Experimental: SpO₂ ainda não calibrado",
            "samples": self.samples_received,
        }

        return self.last_state
