"""
EEG.py
------
Módulo de processamento EEG para Muse S Athena.

Recebe payloads das tags 0x11/0x12 já separados pelo server.py.
Calcula bandas Delta, Theta, Alpha, Beta e Gamma.
"""

from collections import deque
from typing import Dict, List, Optional

import numpy as np
from scipy import signal

def trapezoid_integral(y, x):
    """
    Compatibilidade NumPy:
    - NumPy novo: np.trapezoid
    - NumPy antigo: np.trapz
    """
    if hasattr(np, "trapezoid"):
        return np.trapezoid(y, x)
    return np.trapz(y, x)


EEG_CHANNELS_4 = ["TP9", "AF7", "AF8", "TP10"]
EEG_CHANNELS_8 = ["TP9", "AF7", "AF8", "TP10", "FPz", "AUX_R", "AUX_L", "AUX"]


def unpack_uint14_le(block: bytes) -> List[int]:
    values = []
    acc = 0
    bits = 0

    for b in block:
        acc |= b << bits
        bits += 8

        while bits >= 14:
            values.append(acc & 0x3FFF)
            acc >>= 14
            bits -= 14

    return values


def eeg_raw_to_uv(raw: int) -> float:
    return (raw - 8192) * 0.0885


def parse_eeg_4ch(payload: bytes) -> List[Dict[str, float]]:
    values = unpack_uint14_le(payload)
    samples = []

    for i in range(4):
        row = values[i * 4:(i + 1) * 4]
        if len(row) == 4:
            samples.append({
                EEG_CHANNELS_4[ch]: eeg_raw_to_uv(row[ch])
                for ch in range(4)
            })

    return samples


def parse_eeg_8ch(payload: bytes) -> List[Dict[str, float]]:
    values = unpack_uint14_le(payload)
    samples = []

    for i in range(2):
        row = values[i * 8:(i + 1) * 8]
        if len(row) == 8:
            samples.append({
                EEG_CHANNELS_8[ch]: eeg_raw_to_uv(row[ch])
                for ch in range(8)
            })

    return samples


class EEGModule:
    def __init__(
        self,
        sample_rate: int = 256,
        window_seconds: float = 3.0,
        selected_channel: str = "mean",
        clipping_limit_uv: float = 720.0,
        reject_high_uv: float = 500.0,
    ):
        self.sample_rate = sample_rate
        self.window_seconds = window_seconds
        self.selected_channel = selected_channel
        self.clipping_limit_uv = clipping_limit_uv
        self.reject_high_uv = reject_high_uv

        maxlen = int(sample_rate * max(window_seconds, 1.0) * 3)
        self.buffer = deque(maxlen=maxlen)
        self.quality_window = deque(maxlen=int(sample_rate * 5))

        self.total_samples = 0
        self.accepted_samples = 0
        self.rejected_samples = 0

        self.last_state = self.empty_state("Aguardando EEG")

    def process_tag(self, tag: int, payload: bytes) -> None:
        if tag == 0x11:
            for sample in parse_eeg_4ch(payload):
                self.add_sample(sample)

        elif tag == 0x12:
            for sample in parse_eeg_8ch(payload):
                sample4 = {k: sample[k] for k in EEG_CHANNELS_4 if k in sample}
                self.add_sample(sample4)

    def add_sample(self, sample: Dict[str, float]) -> None:
        self.total_samples += 1

        values = list(sample.values())
        clipped = any(abs(v) >= self.clipping_limit_uv for v in values)
        high = any(abs(v) >= self.reject_high_uv for v in values)

        self.quality_window.append({
            "clipped": clipped,
            "high": high,
        })

        if clipped:
            self.rejected_samples += 1
            return

        if self.selected_channel == "mean":
            x = float(np.median(values))
        else:
            if self.selected_channel not in sample:
                self.rejected_samples += 1
                return
            x = float(sample[self.selected_channel])

        self.buffer.append(x)
        self.accepted_samples += 1

    def quality_score(self) -> float:
        if not self.quality_window:
            return 0.0

        total = len(self.quality_window)
        clipped_pct = sum(x["clipped"] for x in self.quality_window) / total
        high_pct = sum(x["high"] for x in self.quality_window) / total

        quality = 100.0 - clipped_pct * 80.0 - high_pct * 30.0
        return max(0.0, min(100.0, quality))

    def empty_state(self, status: str = "Sem dados") -> dict:
        return {
            "status": status,
            "delta": 0.0,
            "theta": 0.0,
            "alpha": 0.0,
            "beta": 0.0,
            "gamma": 0.0,
            "dominant_freq": 0.0,
            "eeg_quality": self.quality_score(),
            "samples_total": self.total_samples,
            "samples_accepted": self.accepted_samples,
            "samples_rejected": self.rejected_samples,
        }

    def compute(self) -> dict:
        needed = int(self.sample_rate * self.window_seconds)

        if len(self.buffer) < needed:
            self.last_state = self.empty_state("Aguardando janela EEG")
            return self.last_state

        x = np.array(list(self.buffer)[-needed:], dtype=float)

        if np.std(x) < 1e-6:
            self.last_state = self.empty_state("Sinal EEG constante")
            return self.last_state

        x = signal.detrend(x)

        nyq = self.sample_rate / 2
        b, a = signal.butter(4, [0.5 / nyq, 45.0 / nyq], btype="bandpass")
        x = signal.filtfilt(b, a, x)

        nperseg = min(len(x), self.sample_rate * 2)
        freqs, psd = signal.welch(
            x,
            fs=self.sample_rate,
            nperseg=nperseg,
            noverlap=nperseg // 2,
        )

        def band_power(low: float, high: float) -> float:
            mask = (freqs >= low) & (freqs < high)
            if not np.any(mask):
                return 0.0
            return float(trapezoid_integral(psd[mask], freqs[mask]))

        delta = band_power(0.5, 4.0)
        theta = band_power(4.0, 8.0)
        alpha = band_power(8.0, 13.0)
        beta = band_power(13.0, 30.0)
        gamma = band_power(30.0, 45.0)

        useful = (freqs >= 0.5) & (freqs <= 45.0)
        dominant_freq = 0.0

        if np.any(useful):
            dominant_freq = float(freqs[useful][np.argmax(psd[useful])])

        self.last_state = {
            "status": "OK",
            "delta": delta,
            "theta": theta,
            "alpha": alpha,
            "beta": beta,
            "gamma": gamma,
            "dominant_freq": dominant_freq,
            "eeg_quality": self.quality_score(),
            "samples_total": self.total_samples,
            "samples_accepted": self.accepted_samples,
            "samples_rejected": self.rejected_samples,
        }

        return self.last_state
