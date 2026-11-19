"""一条命令：从直播页 / 视频地址取一段画面，拼成宫格 PNG（可选把音轨也存下来）。

用法：
    python scripts/stream-shot.py <页面地址或直链> [--seconds 20] [--step 2] [--cols 3] [--out 路径] [--audio]

例子：
    python scripts/stream-shot.py https://live.bilibili.com/6 --seconds 20
    python scripts/stream-shot.py https://live.bilibili.com/6 --seconds 60 --step 2 --cols 4 --audio

做的事：调 yt-dlp -g 取真实流地址（直播页每小时的地址会变，所以每次现取）→ PyAV 直接解码取帧
→ PIL 拼成一张宫格，每格左下角标「取自第几秒」。这台机器没有 ffmpeg，也没装转写，
所以只出画面；--audio 只是把音轨原样存成 m4a，听内容得另外配转写。
"""
import argparse
import datetime
import math
import subprocess
import sys
from pathlib import Path

import av
from PIL import Image, ImageDraw

SKIP = 2.0  # 起播缓冲，这段常常是黑屏/花屏


def resolve(url: str) -> str:
    """用 yt-dlp 把页面地址换成真实流地址；本来就是直链就原样返回。"""
    if any(url.endswith(s) for s in (".m3u8", ".flv", ".mp4")):
        return url
    out = subprocess.run(
        ["yt-dlp", "-g", "--no-warnings", "--no-playlist", url],
        capture_output=True, text=True, timeout=120,
    )
    lines = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
    if not lines:
        raise SystemExit(f"yt-dlp 没取到地址：{out.stderr.strip()[:300]}")
    return lines[0]


def grab_video(stream_url: str, seconds: float, step: float, cols: int, out: Path):
    container = av.open(stream_url, options={"fflags": "nobuffer", "flags": "low_delay"})
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"

    frames, next_t, t0, last_t = [], SKIP, None, 0.0
    for frame in container.decode(stream):
        if frame.pts is None:
            continue
        t = float(frame.pts * stream.time_base)
        t0 = t if t0 is None else t0
        rel = t - t0
        last_t = rel
        if rel < next_t:
            continue
        # 直播的帧时间戳不落在整秒上，留半格容差，不然每页会少一格
        if rel > seconds + step * 0.75:
            break
        frames.append((rel, frame.to_image()))
        next_t += step
        if rel >= seconds - 1e-6:
            break
    container.close()

    if not frames:
        raise SystemExit("没取到帧（地址过期或流已停）")
    return frames, last_t


def build_pages(frames, cols: int, out: Path, pages: int = 1, cell: int = 640):
    """把帧按 pages 平分，每页一张 cols 列的宫格；时间码画在每格画面下面，不压图。"""
    n = len(frames)
    per = max(1, math.ceil(n / max(1, pages)))
    chunks = [frames[i:i + per] for i in range(0, n, per) if frames[i:i + per]]
    out.parent.mkdir(parents=True, exist_ok=True)
    made = []
    for pi, chunk in enumerate(chunks):
        w, h = chunk[0][1].size
        cw = max(160, int(cell))
        ch = max(60, int(round(h * cw / w)))
        bar = max(16, int(cw * 0.05))
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cw * cols, (ch + bar) * rows), (16, 16, 16))
        draw = ImageDraw.Draw(sheet)
        for i, (rel, img) in enumerate(chunk):
            x, y = (i % cols) * cw, (i // cols) * (ch + bar)
            sheet.paste(img.resize((cw, ch)), (x, y))
            draw.text((x + 6, y + ch + 2), f"{rel:.0f}s", fill=(255, 235, 120))
        path = out if len(chunks) == 1 else out.with_name(f"{out.stem}-{pi + 1}{out.suffix}")
        sheet.save(path)
        made.append({
            "path": str(path), "cells": len(chunk), "cols": cols, "rows": rows,
            "width": sheet.width, "height": sheet.height,
            "from": round(chunk[0][0], 1), "to": round(chunk[-1][0], 1),
        })
        print(f"宫格 {path} · {len(chunk)} 格 · 每格 {cw}x{ch} · 整张 {sheet.width}x{sheet.height} · 覆盖 {chunk[0][0]:.0f}-{chunk[-1][0]:.0f}s")
    return made


def grab_audio(stream_url: str, seconds: float, out: Path):
    container = av.open(stream_url, options={"fflags": "nobuffer", "flags": "low_delay"})
    if not container.streams.audio:
        container.close()
        print("这条流没有音轨")
        return
    ain = container.streams.audio[0]
    output = av.open(str(out), mode="w", format="mp4")
    aout = output.add_stream("aac", rate=ain.codec_context.sample_rate, layout="stereo")
    aout.time_base = ain.time_base
    start, count = None, 0
    for packet in container.demux(ain):
        if packet.dts is None:
            continue
        if start is None:
            start = packet.dts
        if (packet.dts - start) * ain.time_base > seconds:
            break
        packet.stream = aout
        output.mux(packet)
        count += 1
    output.close()
    container.close()
    print(f"音轨 {out} · {count} 个包 · 约 {seconds} 秒")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--seconds", type=float, default=20.0)
    p.add_argument("--step", type=float, default=2.0)
    p.add_argument("--cols", type=int, default=3)
    p.add_argument("--pages", type=int, default=1, help="一次出几张宫格；给 5 就把这段平分成 5 张，各存 xxx-1..5.png")
    p.add_argument("--cell", type=int, default=640, help="每格宽度（像素）")
    p.add_argument("--out", default="")
    p.add_argument("--audio", action="store_true")
    a = p.parse_args()

    stamp = datetime.datetime.now().strftime("%H%M%S")
    out = Path(a.out) if a.out else Path("blobs") / f"stream-{stamp}.png"

    stream_url = resolve(a.url)
    frames, last_t = grab_video(stream_url, a.seconds, a.step, a.cols, out)
    build_pages(frames, max(1, a.cols), out, max(1, a.pages), a.cell)
    if a.audio:
        grab_audio(stream_url, a.seconds, Path("cache") / "live" / f"audio-{stamp}.m4a")


if __name__ == "__main__":
    main()
