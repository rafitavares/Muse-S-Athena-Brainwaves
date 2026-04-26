#!/usr/bin/env python3
"""
server.py
---------
Cérebro principal do projeto Athena Modular Dashboard.

Responsabilidades:
1. Servir a interface web no browser: http://localhost:8765
2. Abrir WebSocket em /ws.
3. Conectar uma única vez na Muse S Athena via BLE.
4. Separar pacotes Athena por tag.
5. Enviar cada payload para os módulos:
   - EEG.py
   - pulse.py
   - SpO2.py
6. Calcular bateria, movimento/postura e respiração.
7. Enviar um único JSON consolidado para o browser.
"""

import argparse
import asyncio
import json
import math
import struct
import time
from collections import deque
from pathlib import Path
from typing import Optional, Set

import numpy as np
from aiohttp import web, WSMsgType
from bleak import BleakClient, BleakScanner
from scipy import signal
from scipy.signal import find_peaks

from EEG import EEGModule
from pulse import PulseModule
from SpO2 import SpO2Module


BASE_UUID = "4c4d-454d-96be-f03bac821358"
CONTROL_UUID = f"273e0001-{BASE_UUID}"
DATA_UUID = f"273e0013-{BASE_UUID}"

TAG_LENGTHS = {
    0x11: 28,  # EEG 4 canais
    0x12: 28,  # EEG 8 canais
    0x34: 30,  # Optics 4 canais
    0x35: 40,  # Optics 8 canais
    0x36: 40,  # Optics 16 canais
    0x47: 36,  # IMU
    0x53: 24,  # DRL/REF
    0x98: 20,  # bateria/status legado
}


def muse_cmd(cmd: str) -> bytes:
    payload = cmd.encode("ascii") + b"\n"
    return bytes([len(payload)]) + payload


class BatteryModule:
    def __init__(self):
        self.level = 0.0
        self.raw = ""
        self.status = "Aguardando bateria"
        self.last_seen = 0.0

    def process_payload(self, payload: bytes):
        self.raw = payload[:12].hex(" ")
        self.last_seen = time.time()

        if len(payload) >= 2:
            # Athena: primeiros 2 bytes do payload = u16_LE / 256.0
            level = int.from_bytes(payload[:2], "little") / 256.0

            if 0 <= level <= 100:
                self.level = float(level)
                self.status = "OK"
            else:
                self.status = "Bateria fora da faixa"

    def compute(self) -> dict:
        age = time.time() - self.last_seen if self.last_seen else None
        return {
            "level": self.level,
            "status": self.status,
            "age_seconds": age,
            "raw": self.raw,
        }


class MovementModule:
    def __init__(self, sample_rate: int = 52):
        self.sample_rate = sample_rate
        self.acc_mag = deque(maxlen=sample_rate * 30)
        self.gyro_mag = deque(maxlen=sample_rate * 30)
        self.last_acc = (0.0, 0.0, 0.0)
        self.last_gyro = (0.0, 0.0, 0.0)
        self.samples = 0

    def process_imu_payload(self, payload: bytes):
        if len(payload) < 36:
            return

        vals = struct.unpack("<18h", payload)

        for i in range(3):
            base = i * 6

            acc_raw = vals[base:base + 3]
            gyro_raw = vals[base + 3:base + 6]

            acc = tuple(v * 0.0000610352 for v in acc_raw)
            gyro = tuple(v * -0.0074768 for v in gyro_raw)

            am = math.sqrt(acc[0] ** 2 + acc[1] ** 2 + acc[2] ** 2)
            gm = math.sqrt(gyro[0] ** 2 + gyro[1] ** 2 + gyro[2] ** 2)

            self.acc_mag.append(am)
            self.gyro_mag.append(gm)
            self.last_acc = acc
            self.last_gyro = gyro
            self.samples += 1

    def movement_state(self) -> dict:
        if not self.gyro_mag:
            return {
                "movement_score": 0.0,
                "gyro_mag": 0.0,
                "acc_mag": 0.0,
                "posture": "Aguardando IMU",
                "samples": self.samples,
            }

        gyro = float(self.gyro_mag[-1])
        acc = float(self.acc_mag[-1])
        ax, ay, az = self.last_acc

        movement_score = min(100.0, gyro * 1.5 + abs(acc - 1.0) * 120.0)

        tilt = math.degrees(math.atan2(math.sqrt(ax * ax + ay * ay), abs(az) + 1e-6))

        if movement_score > 65:
            posture = "Movimento alto"
        elif tilt > 35:
            posture = "Cabeça inclinada"
        else:
            posture = "Estável"

        return {
            "movement_score": movement_score,
            "gyro_mag": gyro,
            "acc_mag": acc,
            "tilt_degrees": tilt,
            "posture": posture,
            "samples": self.samples,
        }

    def respiration_state(self) -> dict:
        needed = self.sample_rate * 20
        if len(self.acc_mag) < needed:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.0,
                "status": "Aguardando 20s de IMU",
            }

        x = np.asarray(list(self.acc_mag)[-needed:], dtype=float)

        if np.std(x) < 1e-6:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.0,
                "status": "IMU constante",
            }

        nyq = self.sample_rate / 2
        try:
            b, a = signal.butter(2, [0.10 / nyq, 0.50 / nyq], btype="bandpass")
            xf = signal.filtfilt(b, a, signal.detrend(x))
        except Exception:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.0,
                "status": "Filtro respiração falhou",
            }

        if np.std(xf) < 1e-6:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.0,
                "status": "Sem padrão respiratório",
            }

        peaks, _ = find_peaks(
            xf,
            distance=int(self.sample_rate * 1.8),
            prominence=max(np.std(xf) * 0.25, 1e-6),
        )

        if len(peaks) < 3:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.1,
                "status": "Respiração fraca",
            }

        intervals = np.diff(peaks) / self.sample_rate
        intervals = intervals[(intervals >= 2.0) & (intervals <= 10.0)]

        if len(intervals) < 2:
            return {
                "rate_rpm": 0.0,
                "confidence": 0.1,
                "status": "Respiração instável",
            }

        rate = 60.0 / float(np.mean(intervals))
        confidence = 1.0 - float(np.std(intervals) / (np.mean(intervals) + 1e-6))
        confidence = max(0.0, min(1.0, confidence))

        return {
            "rate_rpm": rate,
            "confidence": confidence,
            "status": "Estimativa via IMU",
        }


class AthenaRouter:
    def __init__(
        self,
        eeg: EEGModule,
        pulse: PulseModule,
        spo2: SpO2Module,
        battery: BatteryModule,
        movement: MovementModule,
    ):
        self.eeg = eeg
        self.pulse = pulse
        self.spo2 = spo2
        self.battery = battery
        self.movement = movement

        self.tag_counter = {}
        self.packets_received = 0

    def route_packet(self, data: bytes) -> None:
        self.packets_received += 1

        if len(data) < 14:
            return

        i = 9

        while i < len(data):
            tag = data[i]
            self.tag_counter[tag] = self.tag_counter.get(tag, 0) + 1

            # 0x88 em Athena pode ter payload variável.
            # Ainda tentamos ler bateria dos primeiros 2 bytes de payload.
            if tag == 0x88:
                payload_start = i + 5
                if payload_start + 2 <= len(data):
                    self.battery.process_payload(data[payload_start:])
                break

            payload_len = TAG_LENGTHS.get(tag)
            if payload_len is None:
                break

            payload_start = i + 5
            payload_end = payload_start + payload_len

            if payload_end > len(data):
                break

            payload = data[payload_start:payload_end]

            if tag in (0x11, 0x12):
                self.eeg.process_tag(tag, payload)

            elif tag in (0x34, 0x35, 0x36):
                self.pulse.process_tag(tag, payload)
                self.spo2.process_tag(tag, payload)

            elif tag == 0x47:
                self.movement.process_imu_payload(payload)

            elif tag == 0x98:
                self.battery.process_payload(payload)

            i = payload_end


class AthenaServer:
    def __init__(
        self,
        host: str = "localhost",
        port: int = 8765,
        muse_name: str = "Muse",
        muse_address: Optional[str] = None,
        preset: str = "p1035",
        eeg_window: float = 3.0,
        eeg_channel: str = "mean",
        broadcast_interval: float = 0.5,
    ):
        self.host = host
        self.port = port
        self.muse_name = muse_name
        self.muse_address = muse_address
        self.preset = preset
        self.broadcast_interval = broadcast_interval

        self.eeg = EEGModule(window_seconds=eeg_window, selected_channel=eeg_channel)
        self.pulse = PulseModule()
        self.spo2 = SpO2Module()
        self.battery = BatteryModule()
        self.movement = MovementModule()

        self.router = AthenaRouter(
            self.eeg,
            self.pulse,
            self.spo2,
            self.battery,
            self.movement,
        )

        self.clients: Set[web.WebSocketResponse] = set()
        self.static_dir = Path(__file__).resolve().parent

        self.ble_enabled = True
        self.ble_connected = False
        self.ble_status = "starting"
        self.active_client: Optional[BleakClient] = None

    # =========================
    # Web / Browser
    # =========================

    async def start_web(self):
        app = web.Application()
        app.router.add_get("/", self.handle_index)
        app.router.add_get("/ws", self.handle_ws)
        app.router.add_get("/{filename}", self.handle_static)

        runner = web.AppRunner(app)
        await runner.setup()

        site = web.TCPSite(runner, self.host, self.port)
        await site.start()

        print(f"🌐 Interface: http://{self.host}:{self.port}")
        print(f"🌐 WebSocket: ws://{self.host}:{self.port}/ws")

    async def handle_index(self, request):
        return web.FileResponse(
            self.static_dir / "index.html",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    async def handle_static(self, request):
        filename = request.match_info["filename"]

        allowed = {
            "index.html",
            "style.css",
            "styles.css",
            "app.js",
        }

        if filename not in allowed:
            raise web.HTTPNotFound()

        path = self.static_dir / filename
        if not path.exists():
            raise web.HTTPNotFound()

        return web.FileResponse(
            path,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    async def handle_ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        self.clients.add(ws)
        print(f"🌐 Browser conectado. Clientes: {len(self.clients)}")

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self.handle_ws_command(msg.data)
        finally:
            self.clients.discard(ws)
            print(f"🌐 Browser desconectado. Clientes: {len(self.clients)}")

        return ws

    async def handle_ws_command(self, text: str):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return

        command = data.get("command")

        if command == "disconnect_muse":
            print("🛑 Comando browser: desconectar Muse")
            self.ble_enabled = False
            if self.active_client and self.active_client.is_connected:
                await self.active_client.disconnect()

        elif command == "connect_muse":
            print("🔌 Comando browser: conectar Muse")
            self.ble_enabled = True

    async def broadcast(self, payload: dict):
        if not self.clients:
            return

        message = json.dumps(payload)

        disconnected = []
        for ws in self.clients:
            try:
                await ws.send_str(message)
            except Exception:
                disconnected.append(ws)

        for ws in disconnected:
            self.clients.discard(ws)

    # =========================
    # BLE / Muse
    # =========================

    async def find_muse(self):
        print("🔍 Procurando Muse BLE...")
        devices = await BleakScanner.discover(timeout=8.0)

        for d in devices:
            if d.name:
                print(f"  encontrado: {d.name} | {d.address}")

        if self.muse_address:
            for d in devices:
                if d.address == self.muse_address:
                    return d

        for d in devices:
            if d.name and self.muse_name.lower() in d.name.lower():
                return d

        return None

    async def write_cmd(self, client: BleakClient, cmd: str, delay: float = 0.4):
        packet = muse_cmd(cmd)
        print(f"➡️ Muse CMD {cmd}: {packet.hex(' ')}")
        await client.write_gatt_char(CONTROL_UUID, packet, response=False)
        await asyncio.sleep(delay)

    def data_callback(self, sender, data: bytearray):
        try:
            self.router.route_packet(bytes(data))
        except Exception as exc:
            print(f"❌ Erro no parser Athena: {exc}")

    def control_callback(self, sender, data: bytearray):
        pass

    async def initialize_muse(self, client: BleakClient):
        await client.start_notify(CONTROL_UUID, self.control_callback)
        await client.start_notify(DATA_UUID, self.data_callback)

        await asyncio.sleep(0.5)

        await self.write_cmd(client, "v6", 0.5)
        await self.write_cmd(client, "s", 0.5)
        await self.write_cmd(client, "h", 0.5)

        await self.write_cmd(client, "p21", 0.8)
        await self.write_cmd(client, "dc001", 0.9)
        await self.write_cmd(client, "L1", 0.9)

        await self.write_cmd(client, "h", 0.8)
        await self.write_cmd(client, self.preset, 0.9)
        await self.write_cmd(client, "dc001", 0.9)
        await self.write_cmd(client, "L1", 0.9)

        print("✅ Muse Athena inicializada.")

    async def ble_loop(self):
        while True:
            if not self.ble_enabled:
                self.ble_status = "disabled"
                self.ble_connected = False
                await asyncio.sleep(0.5)
                continue

            try:
                self.ble_status = "scanning"
                muse = await self.find_muse()

                if not muse:
                    print("❌ Muse não encontrada. Nova tentativa em 5s.")
                    self.ble_status = "not_found"
                    await asyncio.sleep(5)
                    continue

                print(f"✅ Conectando em {muse.name} | {muse.address}")
                self.ble_status = "connecting"

                async with BleakClient(muse) as client:
                    self.active_client = client
                    self.ble_connected = True
                    self.ble_status = "connected"

                    print(f"✅ BLE conectado: {client.is_connected}")
                    await self.initialize_muse(client)

                    while client.is_connected and self.ble_enabled:
                        await asyncio.sleep(1.0)

                    self.ble_connected = False
                    self.ble_status = "disconnected"
                    print("⚠️ BLE desconectado. Reiniciando busca BLE em 3s...")
                    await asyncio.sleep(3)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.ble_connected = False
                self.ble_status = f"error: {exc}"
                print(f"❌ Erro BLE: {exc}")
                print("🔁 Tentando reconectar em 5s...")
                await asyncio.sleep(5)
            finally:
                self.active_client = None

    # =========================
    # State / Broadcast
    # =========================

    def build_state(self) -> dict:
        eeg_state = self.eeg.compute()
        pulse_state = self.pulse.compute()
        spo2_state = self.spo2.compute()
        movement_state = self.movement.movement_state()
        respiration_state = self.movement.respiration_state()
        battery_state = self.battery.compute()

        state = {
            "type": "state",
            "timestamp": time.time(),

            "eeg": eeg_state,
            "pulse": pulse_state,
            "spo2_module": spo2_state,
            "movement": movement_state,
            "respiration": respiration_state,
            "battery": battery_state,

            "connection": {
                "ble_enabled": self.ble_enabled,
                "ble_connected": self.ble_connected,
                "ble_status": self.ble_status,
            },

            "router": {
                "packets_received": self.router.packets_received,
                "tag_counter": self.router.tag_counter,
            },

            # Campos planos para compatibilidade.
            "delta": eeg_state["delta"],
            "theta": eeg_state["theta"],
            "alpha": eeg_state["alpha"],
            "beta": eeg_state["beta"],
            "gamma": eeg_state["gamma"],
            "dominant_freq": eeg_state["dominant_freq"],
            "eeg_quality": eeg_state["eeg_quality"],
            "hr": pulse_state["hr"],
            "spo2": spo2_state["spo2"],
        }

        return state

    async def broadcast_loop(self):
        last_print = 0.0

        while True:
            state = self.build_state()
            await self.broadcast(state)

            now = time.time()
            if now - last_print >= 2.0:
                last_print = now
                eeg = state["eeg"]
                pulse = state["pulse"]
                spo2 = state["spo2_module"]
                battery = state["battery"]

                print(
                    "📡 "
                    f"BLE={self.ble_status} "
                    f"EEG Q={eeg['eeg_quality']:.0f}% "
                    f"dom={eeg['dominant_freq']:.1f}Hz "
                    f"α={eeg['alpha']:.3f} "
                    f"β={eeg['beta']:.3f} "
                    f"HR={pulse['hr']:.1f} "
                    f"SpO2={spo2['spo2']:.1f} "
                    f"BAT={battery['level']:.0f}% "
                    f"packets={self.router.packets_received}"
                )

            await asyncio.sleep(self.broadcast_interval)

    async def run(self):
        await self.start_web()
        await asyncio.gather(
            self.ble_loop(),
            self.broadcast_loop(),
        )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--name", default="Muse", help="Parte do nome BLE, ex: MuseS")
    parser.add_argument("--address", default=None, help="Endereço/UUID BLE específico da Muse")
    parser.add_argument("--preset", default="p1035", help="Preset Athena: p1035, p1034 ou p1041")
    parser.add_argument("--eeg-window", type=float, default=3.0)
    parser.add_argument("--eeg-channel", default="mean", help="mean, TP9, AF7, AF8 ou TP10")
    parser.add_argument("--interval", type=float, default=0.5)

    args = parser.parse_args()

    server = AthenaServer(
        host=args.host,
        port=args.port,
        muse_name=args.name,
        muse_address=args.address,
        preset=args.preset,
        eeg_window=args.eeg_window,
        eeg_channel=args.eeg_channel,
        broadcast_interval=args.interval,
    )

    await server.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Encerrado pelo usuário.")
