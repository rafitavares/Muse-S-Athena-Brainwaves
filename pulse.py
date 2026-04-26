"""
pulse.py
--------
Módulo de pulso/BPM a partir dos canais ópticos da Muse S Athena.

Recebe payloads das tags 0x34/0x35/0x36.
O server.py controla a conexão BLE e chama process_tag().
"""

from collections import deque
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy import signal
from scipy.signal import find_peaks


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


class PulseModule:
    def __init__(self, sample_rate: int = 64, window_seconds: int = 10):
        self.sample_rate = sample_rate
        self.window_seconds = window_seconds

        maxlen = sample_rate * window_seconds
        self.buffers = {
            "opt1": deque(maxlen=maxlen),
            "opt2": deque(maxlen=maxlen),
            "opt3": deque(maxlen=maxlen),
            "opt4": deque(maxlen=maxlen),
        }

        self.samples_received = 0
        self.last_state = {
            "hr": 0.0,
            "confidence": 0.0,
            "channel": None,
            "status": "Aguardando dados PPG",
            "samples": 0,
        }

    def process_tag(self, tag: int, payload: bytes) -> None:
        if tag not in (0x34, 0x35, 0x36):
            return

        values = unpack_uint20_le(payload)

        # Começamos simples: para tag 0x34, 12 valores geralmente representam
        # 3 amostras x 4 canais ópticos.
        if tag == 0x34:
            for i in range(0, len(values), 4):
                group = values[i:i + 4]
                if len(group) == 4:
                    self.buffers["opt1"].append(group[0])
                    self.buffers["opt2"].append(group[1])
                    self.buffers["opt3"].append(group[2])
                    self.buffers["opt4"].append(group[3])
                    self.samples_received += 1

        else:
            # Para 0x35/0x36, ainda usamos os primeiros 4 canais de cada bloco.
            for i in range(0, len(values), 4):
                group = values[i:i + 4]
                if len(group) == 4:
                    self.buffers["opt1"].append(group[0])
                    self.buffers["opt2"].append(group[1])
                    self.buffers["opt3"].append(group[2])
                    self.buffers["opt4"].append(group[3])
                    self.samples_received += 1

    def estimate_channel(self, values: List[float]) -> Optional[Tuple[float, float]]:
        if len(values) < self.sample_rate * 6:
            return None

        x = np.asarray(values, dtype=float)

        if np.std(x) < 1e-6:
            return None

        x = signal.detrend(x)

        nyq = self.sample_rate / 2
        b, a = signal.butter(3, [0.5 / nyq, 4.0 / nyq], btype="bandpass")
        xf = signal.filtfilt(b, a, x)

        if np.std(xf) < 1e-6:
            return None

        xf = (xf - np.mean(xf)) / np.std(xf)

        min_distance = int(0.4 * self.sample_rate)
        peaks, _ = find_peaks(
            xf,
            distance=min_distance,
            prominence=0.3,
        )

        if len(peaks) < 4:
            return None

        peak_times = peaks / self.sample_rate
        intervals = np.diff(peak_times)

        # 30-150 BPM
        intervals = intervals[(intervals > 0.4) & (intervals < 2.0)]

        if len(intervals) < 3:
            return None

        bpm = 60.0 / np.mean(intervals)
        confidence = 1.0 - (np.std(intervals) / np.mean(intervals))
        confidence = max(0.0, min(1.0, confidence))

        return float(bpm), float(confidence)

    def compute(self) -> dict:
        best = None

        for channel, buf in self.buffers.items():
            estimate = self.estimate_channel(list(buf))
            if estimate is None:
                continue

            bpm, confidence = estimate

            if best is None or confidence > best["confidence"]:
                best = {
                    "hr": bpm,
                    "confidence": confidence,
                    "channel": channel,
                }

        if best is None:
            self.last_state = {
                "hr": 0.0,
                "confidence": 0.0,
                "channel": None,
                "status": "Aguardando PPG estável",
                "samples": self.samples_received,
            }
        else:
            self.last_state = {
                "hr": best["hr"],
                "confidence": best["confidence"],
                "channel": best["channel"],
                "status": f"OK via {best['channel']}",
                "samples": self.samples_received,
            }

        return self.last_state
