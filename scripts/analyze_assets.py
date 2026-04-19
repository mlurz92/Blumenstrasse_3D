#!/usr/bin/env python3
"""Analysiert Video + alle extrahierten Frames und erzeugt app/data/frame-analysis.json."""

from __future__ import annotations

import json
import struct
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRAMES_DIR = ROOT / "frames"
VIDEO_FILE = ROOT / "Blumenstraße_68_Leipzig.mp4"
OUT_FILE = ROOT / "app" / "data" / "frame-analysis.json"


@dataclass
class FrameInfo:
    frame_number: int
    file: str
    timestamp_seconds: float
    width: int
    height: int
    estimated_luma: float


def run_ffprobe_duration(path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        completed = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(completed.stdout.strip())
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError):
        # Fallback, wenn ffprobe nicht installiert ist
        return 0.0


def parse_webp_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError(f"Keine WEBP-Datei: {path}")

    chunk = data[12:16]

    if chunk == b"VP8X":
        # VP8X: width/height in bytes 24..29 as 24-bit little endian minus 1
        width_minus_1 = data[24] | (data[25] << 8) | (data[26] << 16)
        height_minus_1 = data[27] | (data[28] << 8) | (data[29] << 16)
        return width_minus_1 + 1, height_minus_1 + 1

    if chunk == b"VP8 ":
        # Suche Startcode 9d012a, danach 2x uint16 (14-bit für Größe)
        marker = b"\x9d\x01\x2a"
        idx = data.find(marker)
        if idx == -1:
            raise ValueError(f"VP8 Marker nicht gefunden: {path}")
        w_raw, h_raw = struct.unpack_from("<HH", data, idx + 3)
        return w_raw & 0x3FFF, h_raw & 0x3FFF

    if chunk == b"VP8L":
        # Lossless: 4 bytes signature + 4 bytes Dimension-Packed-Value
        b0, b1, b2, b3 = data[21], data[22], data[23], data[24]
        width = 1 + (((b1 & 0x3F) << 8) | b0)
        height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return width, height

    raise ValueError(f"Unbekannter WEBP Chunk {chunk!r} in {path}")


def estimate_luma_fast(path: Path) -> float:
    # Kein vollständiges Decoding -> leichter Heuristik-Wert aus Byteverteilung.
    b = path.read_bytes()
    if not b:
        return 0.0
    sample = b[:: max(1, len(b) // 4096)]
    return float(sum(sample) / len(sample))


def extract_frame_number(path: Path) -> int:
    # Erwartet frame_00001.webp
    stem = path.stem
    return int(stem.split("_")[-1])


def main() -> None:
    if not FRAMES_DIR.exists():
        raise SystemExit(f"Frames-Ordner fehlt: {FRAMES_DIR}")
    if not VIDEO_FILE.exists():
        raise SystemExit(f"Video-Datei fehlt: {VIDEO_FILE}")

    frame_files = sorted(FRAMES_DIR.glob("frame_*.webp"), key=extract_frame_number)
    if not frame_files:
        raise SystemExit("Keine Frames gefunden")

    duration = run_ffprobe_duration(VIDEO_FILE)
    frame_count = len(frame_files)

    if duration > 0:
        fps = frame_count / duration
    else:
        # Konservativer Fallback für Browser-Playback-Pfade
        fps = 30.0
        duration = frame_count / fps

    frames: list[FrameInfo] = []
    for idx, frame_path in enumerate(frame_files):
        number = extract_frame_number(frame_path)
        width, height = parse_webp_size(frame_path)
        luma = estimate_luma_fast(frame_path)
        timestamp = idx / fps if fps > 0 else 0.0
        frames.append(
            FrameInfo(
                frame_number=number,
                file=f"../frames/{frame_path.name}",
                timestamp_seconds=round(timestamp, 6),
                width=width,
                height=height,
                estimated_luma=round(luma, 3),
            )
        )

    result = {
        "source_video": VIDEO_FILE.name,
        "duration_seconds": round(duration, 6),
        "frame_count": frame_count,
        "estimated_fps": round(fps, 6),
        "frames": [asdict(f) for f in frames],
        "notes": {
            "luma_definition": "Schnelle Byte-Sampling-Heuristik, kein vollständiges Farbraum-Decoding.",
            "all_frames_included": True,
        },
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Analyse geschrieben: {OUT_FILE} ({frame_count} Frames)")


if __name__ == "__main__":
    main()
