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
6. Enviar um único JSON consolidado para o browser.
"""

import argparse
import asyncio
import json
import time
from pathlib import Path
from typing import Optional, Set

from aiohttp import web
from bleak import BleakClient, BleakScanner

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
    0x88: 20,  # bateria/status observado em Athena
    0x98: 20,  # bateria/status legado
}


def muse_cmd(cmd: str) -> bytes:
    payload = cmd.encode("ascii") + b"\n"
    return bytes([len(payload)]) + payload


class AthenaRouter:
    def __init__(self, eeg: EEGModule, pulse: PulseModule, spo2: SpO2Module):
        self.eeg = eeg
        self.pulse = pulse
        self.spo2 = spo2
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

            payload_len = TAG_LENGTHS.get(tag)
            if payload_len is None:
                # Parser perdeu alinhamento ou apareceu tag nova.
                # Melhor parar este pacote do que gerar lixo.
                break

            payload_start = i + 5
            payload_end = payload_start + payload_len

            if payload_end > len(data):
                break

            payload = data[payload_start:payload_end]

            # Roteamento modular.
            if tag in (0x11, 0x12):
                self.eeg.process_tag(tag, payload)

            elif tag in (0x34, 0x35, 0x36):
                self.pulse.process_tag(tag, payload)
                self.spo2.process_tag(tag, payload)

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
        self.router = AthenaRouter(self.eeg, self.pulse, self.spo2)

        self.clients: Set[web.WebSocketResponse] = set()
        self.static_dir = Path(__file__).resolve().parent

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
        return web.FileResponse(self.static_dir / "index.html")

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

        return web.FileResponse(path)

    async def handle_ws(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        self.clients.add(ws)
        print(f"🌐 Browser conectado. Clientes: {len(self.clients)}")

        try:
            async for _ in ws:
                pass
        finally:
            self.clients.discard(ws)
            print(f"🌐 Browser desconectado. Clientes: {len(self.clients)}")

        return ws

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
        self.router.route_packet(bytes(data))

    def control_callback(self, sender, data: bytearray):
        # Ative para depuração:
        # print(f"📩 Controle: {bytes(data).hex(' ')}")
        pass

    async def initialize_muse(self, client: BleakClient):
        await client.start_notify(CONTROL_UUID, self.control_callback)
        await client.start_notify(DATA_UUID, self.data_callback)

        await self.write_cmd(client, "v6")
        await self.write_cmd(client, "s")
        await self.write_cmd(client, "h")
        await self.write_cmd(client, self.preset, 0.8)
        await self.write_cmd(client, "dc001", 0.8)
        await self.write_cmd(client, "L1", 0.8)
        await self.write_cmd(client, "dc001", 0.8)
        await self.write_cmd(client, "L1", 0.8)

        print("✅ Muse Athena inicializada.")

    async def ble_loop(self):
        while True:
            try:
                muse = await self.find_muse()

                if not muse:
                    print("❌ Muse não encontrada. Nova tentativa em 5s.")
                    await asyncio.sleep(5)
                    continue

                print(f"✅ Conectando em {muse.name} | {muse.address}")

                async with BleakClient(muse) as client:
                    print(f"✅ BLE conectado: {client.is_connected}")
                    await self.initialize_muse(client)

                    while client.is_connected:
                        await asyncio.sleep(1.0)

                    print("⚠️ BLE desconectado.")

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"❌ Erro BLE: {exc}")
                print("🔁 Tentando reconectar em 5s...")
                await asyncio.sleep(5)

    # =========================
    # State / Broadcast
    # =========================

    def build_state(self) -> dict:
        eeg_state = self.eeg.compute()
        pulse_state = self.pulse.compute()
        spo2_state = self.spo2.compute()

        state = {
            "type": "state",
            "timestamp": time.time(),
            "eeg": eeg_state,
            "pulse": pulse_state,
            "spo2_module": spo2_state,
            "router": {
                "packets_received": self.router.packets_received,
                "tag_counter": self.router.tag_counter,
            },

            # Campos planos para compatibilidade com versões antigas do app.js.
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

                print(
                    "📡 "
                    f"EEG Q={eeg['eeg_quality']:.0f}% "
                    f"dom={eeg['dominant_freq']:.1f}Hz "
                    f"α={eeg['alpha']:.3f} "
                    f"β={eeg['beta']:.3f} "
                    f"HR={pulse['hr']:.1f} "
                    f"SpO2={spo2['spo2']:.1f} "
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
