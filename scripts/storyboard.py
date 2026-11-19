# -*- coding: utf-8 -*-
"""把一段视频压成一张宫格图 + 一份带时间码的清单。

只依赖 PyAV（av）和 PIL，不碰 ffmpeg，也不拉 cv2 / numpy（2026-11-15 改）。给 Coopanion 的 cortico-world-video 插件调用，
也可以单独在命令行跑：

    python storyboard.py --input a.mp4 --out out_dir --max-frames 24
    python storyboard.py --input a.mp4 --probe

stdout 只输出一行 JSON，日志走 stderr。
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import av
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fmt_time(t: float) -> str:
    t = max(0.0, float(t))
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    if h:
        return f"{h}:{m:02d}:{s:04.1f}"
    return f"{m:02d}:{s:04.1f}"


# —— 网址那半：yt-dlp 拉轨 + PyAV 合容器（stream copy，不解码不重编码）——

def find_ytdlp(explicit: str | None) -> list[str]:
    """找 yt-dlp：参数 > PATH > 跟 Python 同目录的 Scripts > python -m yt_dlp。"""
    if explicit:
        return [explicit]
    found = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if found:
        return [found]
    scripts = os.path.join(os.path.dirname(sys.executable), "Scripts")
    for name in ("yt-dlp.exe", "yt-dlp"):
        cand = os.path.join(scripts, name)
        if os.path.exists(cand):
            return [cand]
    return [sys.executable, "-m", "yt_dlp"]


def _run(cmd: list[str], timeout: int = 900) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return -9, "", f"超时（{timeout} 秒没下完）"
    except FileNotFoundError as e:
        return -1, "", f"找不到 {cmd[0]}（{e}）"


def _tail(text: str, n: int = 2) -> str:
    rows = [r.strip() for r in (text or "").splitlines() if r.strip()]
    return " / ".join(rows[-n:]) if rows else "没有输出"


def _first(d: str, prefix: str) -> str | None:
    hits = sorted(glob.glob(os.path.join(d, prefix + "*")))
    return hits[0] if hits else None


def _pick_formats(formats: list[dict]) -> dict | None:
    """挑要下的轨：有音画一体的就下那条；只有分离轨就各挑一条。偏好 h264、720p 以内。"""
    def vid(f: dict) -> bool:
        return f.get("vcodec") not in (None, "none")

    def aud(f: dict) -> bool:
        return f.get("acodec") not in (None, "none")

    def height(f: dict) -> int:
        return int(f.get("height") or 0)

    def h264(f: dict) -> int:
        return 1 if str(f.get("vcodec") or "").lower().startswith("avc1") else 0

    prog = [f for f in formats if vid(f) and aud(f)]
    if prog:
        small = [f for f in prog if height(f) <= 720] or prog
        best = max(small, key=lambda f: (h264(f), height(f), float(f.get("tbr") or 0)))
        return {"kind": "single", "video": best.get("format_id"), "audio": None}

    vs = [f for f in formats if vid(f) and not aud(f)]
    if not vs:
        return None
    aus = [f for f in formats if aud(f) and not vid(f)]
    small = [f for f in vs if height(f) <= 720] or vs
    v = max(small, key=lambda f: (h264(f), height(f), float(f.get("tbr") or 0)))
    a = max(aus, key=lambda f: float(f.get("abr") or f.get("tbr") or 0)) if aus else None
    return {"kind": "split", "video": v.get("format_id"), "audio": a.get("format_id") if a else None}


def _mux(video_path: str, audio_path: str, out_path: str) -> None:
    """把两条流原样搬进一个容器。不解码、不重编码，几秒就好。"""
    import av  # 迟导入：没装 PyAV 时只看画面也还能用

    src_v = av.open(video_path)
    src_a = av.open(audio_path)
    out = av.open(out_path, mode="w")
    try:
        v_in = src_v.streams.video[0]
        a_in = src_a.streams.audio[0]
        v_out = out.add_stream_from_template(v_in)
        a_out = out.add_stream_from_template(a_in)
        for pkt in src_v.demux(v_in):
            if pkt.dts is None:
                continue
            pkt.stream = v_out
            out.mux(pkt)
        for pkt in src_a.demux(a_in):
            if pkt.dts is None:
                continue
            pkt.stream = a_out
            out.mux(pkt)
    finally:
        out.close()
        src_v.close()
        src_a.close()


def fetch(url: str, root: str, ytdlp: str | None) -> tuple[str | None, dict, str | None]:
    """把网址落成本地文件。回 (路径, 元信息, 只有画面时的说明)。"""
    tool = find_ytdlp(ytdlp)
    rc, out, err = _run(tool + ["--no-warnings", "-J", url], timeout=180)
    meta: dict = {}
    if rc == 0 and "{" in out:
        try:
            meta = json.loads(out[out.find("{"):])
        except json.JSONDecodeError:
            meta = {}
    if not meta:
        return None, {}, f"yt-dlp 读不出这个链接（退出码 {rc}）：{_tail(err or out)}"

    choice = _pick_formats([f for f in (meta.get("formats") or []) if isinstance(f, dict)])
    if not choice:
        return None, meta, "这个链接里没找到能下的视频流"

    src = os.path.join(root, "_src")
    if os.path.isdir(src):
        shutil.rmtree(src, ignore_errors=True)
    os.makedirs(src, exist_ok=True)
    log(f"下载：{meta.get('title') or meta.get('id') or url}")

    rc, out, err = _run(tool + ["--no-warnings", "--newline", "-f", str(choice["video"]),
                                "-o", os.path.join(src, "v.%(ext)s"), url], timeout=1800)
    vfile = _first(src, "v.")
    if rc != 0 or not vfile:
        return None, meta, f"视频轨没下来（退出码 {rc}）：{_tail(err or out)}"
    if choice["kind"] == "single" or not choice.get("audio"):
        return vfile, meta, None

    rc, out, err = _run(tool + ["--no-warnings", "--newline", "-f", str(choice["audio"]),
                                "-o", os.path.join(src, "a.%(ext)s"), url], timeout=900)
    afile = _first(src, "a.")
    if rc != 0 or not afile:
        log(f"音频轨没下来：{_tail(err or out)}")
        return vfile, meta, "音频轨没下来，这次只有画面"

    ext = os.path.splitext(vfile)[1].lower()
    merged = os.path.join(src, "full" + (".mkv" if ext in (".webm", ".mkv") else ".mp4"))
    try:
        _mux(vfile, afile, merged)
    except Exception as e:  # noqa: BLE001 —— 合不上不该把画面也丢了
        log(f"合轨失败：{e.__class__.__name__}: {e}")
        return vfile, meta, f"音视频合不上（{e.__class__.__name__}），这次只有画面"
    return merged, meta, None


def probe(path: str) -> dict:
    try:
        container = av.open(path)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"打不开这个视频：{path}（{e.__class__.__name__}）"}
    try:
        vs = container.streams.video[0]
        fps = float(vs.average_rate or vs.guessed_rate or 25.0) or 25.0
        w = int(vs.codec_context.width or 0)
        h = int(vs.codec_context.height or 0)
        duration = float(container.duration / 1_000_000) if container.duration else 0.0
        if duration <= 0 and vs.duration:
            duration = float(vs.duration * vs.time_base)
        total = int(vs.frames or round(duration * fps))
        return {
            "ok": True,
            "duration": round(duration, 2),
            "fps": round(fps, 3),
            "frames": total,
            "width": w,
            "height": h,
            "sizeMB": round(os.path.getsize(path) / 1024 / 1024, 2) if os.path.exists(path) else None,
        }
    finally:
        container.close()


def scan(path: str, step_sec: float, limit_sec: float | None, start_sec: float = 0.0) -> list[tuple[float, float]]:
    """按 step_sec 粗采样，回 (时间, 与上一张缩略图的平均差)。0~1，越大越像换镜头。
    给了 start_sec 就从那儿起扫；返回的时间一律是绝对秒（从片头算）。
    2026-11-15 起走 PyAV + PIL（不再依赖 cv2 / numpy）。"""
    container = av.open(path)
    try:
        vs = container.streams.video[0]
        vs.thread_type = "AUTO"
        if start_sec > 0:
            # offset 不给 stream 时按微秒算（给了 stream 就变成 time_base 单位，会跑到片尾）
            container.seek(int(start_sec * 1_000_000), backward=True)
        diffs: list[tuple[float, float]] = []
        prev = None
        next_t = start_sec
        for frame in container.decode(vs):
            if frame.pts is None:
                continue
            t = float(frame.pts * vs.time_base)
            if t + 1e-6 < next_t:
                continue
            small = frame.to_image().convert("L").resize((64, 36), Image.BILINEAR)
            if prev is None:
                # 首个采样点也进池（差值记 0），否则起点那一帧永远当不了格子
                diffs.append((round(t, 3), 0.0))
            else:
                d = ImageStat.Stat(ImageChops.difference(small, prev)).mean[0] / 255.0
                diffs.append((round(t, 3), round(float(d), 4)))
            prev = small
            next_t = t + step_sec
            if limit_sec and t >= limit_sec:
                break
        return diffs
    finally:
        container.close()


def _pct(values: list[float], q: float) -> float:
    """分位数（PIL/Python 自带，不拉 numpy）。"""
    s = sorted(values)
    if not s:
        return 0.0
    k = (len(s) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return s[lo]
    return s[lo] * (hi - k) + s[hi] * (k - lo)


def pick_times(diffs: list[tuple[float, float]], max_frames: int, duration: float, start: float = 0.0) -> list[dict]:
    """按「换镜头的地方优先、不够就均匀补」挑时间点。
    duration 是终点（绝对秒），start 是起点；均匀补点只落在 start~duration 之间。"""
    if not diffs:
        return []
    thr = float(max(0.05, _pct([d for _, d in diffs], 88)))
    scene = [(t, d) for t, d in diffs if d >= thr]

    picked: dict[float, float] = {}  # 时间 -> diff
    # 先按差异从大到小取，保证最剧烈的换镜头一定入选
    for t, d in sorted(scene, key=lambda x: -x[1])[:max_frames]:
        picked[t] = d

    # 不够 max_frames 就均匀补点；每轮都排除已选中的时刻，补满为止
    if len(picked) < max_frames and duration > start:
        need = max_frames - len(picked)
        targets = [round(start + (duration - start) * (i + 0.5) / need, 3) for i in range(need)]
        for t in targets:
            if len(picked) >= max_frames:
                break
            free = [x for x in diffs if x[0] not in picked]
            spaced = [x for x in free if all(abs(x[0] - y) >= 1.0 for y in picked)]
            pool = spaced or free
            if not pool:
                break
            near = min(pool, key=lambda x: abs(x[0] - t))
            picked[near[0]] = near[1]

    times = sorted(picked.items())[:max_frames]
    out = []
    for i, (t, d) in enumerate(times):
        nxt = times[i + 1][0] if i + 1 < len(times) else duration
        out.append({"t": t, "end": round(min(nxt, duration or nxt), 2), "diff": d})
    return out


def extract(path: str, times: list[dict]) -> list[Image.Image]:
    """顺序读一遍，把要的时刻抓成图。"""
    if not times:
        return []
    order = sorted(range(len(times)), key=lambda i: times[i]["t"])
    got: dict[int, Image.Image] = {}
    container = av.open(path)
    try:
        vs = container.streams.video[0]
        vs.thread_type = "AUTO"
        j = 0
        for frame in container.decode(vs):
            if j >= len(order):
                break
            if frame.pts is None:
                continue
            t = float(frame.pts * vs.time_base)
            while j < len(order) and t + 1e-6 >= times[order[j]]["t"]:
                got[order[j]] = frame.to_image()
                j += 1
        return [got[i] for i in range(len(times)) if i in got]
    finally:
        container.close()


def font_of(size: int):
    for name in ("msyh.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    """按短边铺满再居中裁，保住比例。"""
    if img.mode != "RGB":
        img = img.convert("RGB")
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    nw, nh = max(w, int(sw * scale + 0.5)), max(h, int(sh * scale + 0.5))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


_CUDA_READY: bool | None = None


def _model_root() -> str:
    """whisper 模型统一放一个盘（他 2026-11-09 交代：装东西别东一个西一个）。"""
    # 想用已经下好的模型，就设环境变量 WHISPER_MODEL_DIR；不设就交给 faster-whisper 的默认缓存。
    p = os.environ.get("WHISPER_MODEL_DIR")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:  # noqa: BLE001
        return ""
    return p


def _prepare_cuda() -> bool:
    """把 pip 装进 site-packages 的 CUDA 运行库挂上 PATH。

    Windows 上 ctranslate2 用 LoadLibrary 找 dll，不走 add_dll_directory，
    所以两边各挂一次；找不到任何目录就回 False，调用方直接退 CPU。
    """
    global _CUDA_READY
    if _CUDA_READY is not None:
        return _CUDA_READY
    dirs: list[str] = []
    try:
        import site

        for sp in site.getsitepackages():
            for sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
                p = os.path.join(sp, *sub.split("/"))
                if os.path.isdir(p):
                    dirs.append(p)
    except Exception:  # noqa: BLE001
        dirs = []
    if not dirs:
        _CUDA_READY = False
        return False
    os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except Exception:  # noqa: BLE001
            pass
    _CUDA_READY = True
    return True


def transcribe(
    path: str,
    model_size: str = "base",
    clip_end: float | None = None,
    device: str = "auto",
) -> tuple[list[dict], str | None]:
    """用 faster-whisper 转写音轨。没装就回 (空, 原因)，不影响画面那半。

    device：auto / cuda / cpu。auto 先挂 CUDA 运行库试显卡，起不来再退 CPU。
    """
    try:
        from faster_whisper import WhisperModel  # 迟导入：没装也能只看画面
    except Exception as e:  # noqa: BLE001
        return [], f"没装 faster-whisper（{e.__class__.__name__}）"

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    plans: list[tuple[str, str]] = []
    if device in ("auto", "cuda") and _prepare_cuda():
        plans.append(("cuda", "float16"))
    if device in ("auto", "cpu"):
        plans.append(("cpu", "int8"))
    if not plans:
        plans = [("cpu", "int8")]

    kwargs = {
        "language": "zh",
        "vad_filter": True,
        "beam_size": 1,
        "initial_prompt": "以下是普通话对话，请用简体中文输出，只写听到的话。",
    }
    if clip_end:
        kwargs["clip_timestamps"] = [0, float(clip_end)]

    errs: list[str] = []
    for dev, ctype in plans:
        try:
            model = WhisperModel(model_size, device=dev, compute_type=ctype, download_root=_model_root())
            segments, _info = model.transcribe(path, **kwargs)
            return [
                {"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": s.text.strip()}
                for s in segments
                if s.text.strip()
            ], None
        except Exception as e:  # noqa: BLE001
            errs.append(f"{dev}: {e.__class__.__name__}: {e}")
    return [], "转写出错：" + "；".join(errs)


def attach_lines(times: list[dict], segs: list[dict], per_cell: int = 8) -> None:
    """把台词按时间段塞进对应的格子：相邻重复的并掉，一格最多 per_cell 条。"""
    for info in times:
        s, e = info["t"], info["end"]
        rows = [x["text"] for x in segs if x["end"] > s and x["start"] < e]
        dedup: list[str] = []
        for r in rows:
            if not dedup or r != dedup[-1]:
                dedup.append(r)
        if len(dedup) > per_cell:
            dedup = dedup[:per_cell] + [f"…（还有 {len(dedup) - per_cell} 段）"]
        info["lines"] = dedup


def sheet(frames: list[Image.Image], times: list[dict], out_path: str, cell: int = 320, quality: int = 88, cols: int = 0) -> dict:
    n = len(frames)
    if cols and cols > 0:
        cols = max(1, min(n, int(cols)))
    else:
        cols = max(1, min(n, int(math.ceil(math.sqrt(n * 16 / 9)))))
    rows = int(math.ceil(n / cols))
    cw, ch = cell, int(round(cell * 9 / 16))
    pad, bar = 4, 20
    W = cols * cw + (cols + 1) * pad
    H = rows * (ch + bar) + (rows + 1) * pad
    canvas = Image.new("RGB", (W, H), (18, 18, 20))
    draw = ImageDraw.Draw(canvas)
    f = font_of(max(11, int(cell * 0.055)))

    for i, (img_i, info) in enumerate(zip(frames, times)):
        r, c = divmod(i, cols)
        x = pad + c * (cw + pad)
        y = pad + r * (ch + bar + pad)
        canvas.paste(fit(img_i, cw, ch), (x, y))
        label = f"#{i + 1} {fmt_time(info['t'])}"
        # 时间码另起一条画在画面下面，别压在图上（2026-11-15 他说挡画面）
        draw.rectangle([x, y + ch, x + cw, y + ch + bar], fill=(28, 28, 32))
        draw.text((x + 5, y + ch + 2), label, fill=(255, 235, 120), font=f)

    if out_path.lower().endswith((".jpg", ".jpeg")):
        canvas.save(out_path, quality=quality, optimize=True)
    else:
        canvas.save(out_path, optimize=True)
    return {"path": out_path, "width": W, "height": H, "cols": cols, "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--max-frames", type=int, default=24)
    ap.add_argument("--step", type=float, default=0.5, help="粗采样间隔（秒）")
    ap.add_argument("--max-seconds", type=float, default=None, help="看到第 N 秒为止（绝对秒）")
    ap.add_argument("--start-seconds", type=float, default=0.0, help="从第 N 秒开始取（绝对秒，默认 0）")
    ap.add_argument("--format", default="jpg", choices=["jpg", "png"], help="宫格图格式，默认 jpg（小得多）")
    ap.add_argument("--asr", default="auto", choices=["auto", "off"], help="auto=有 faster-whisper 就转台词")
    ap.add_argument("--asr-model", default="small", help="whisper 模型：tiny/base/small/medium（small 默认，2026-11-10 起）")
    ap.add_argument("--asr-device", default="auto", choices=["auto", "cuda", "cpu"], help="auto=有 CUDA 运行库就用显卡，失败退 CPU")
    ap.add_argument("--quality", type=int, default=88)
    ap.add_argument("--cell", type=int, default=320, help="每格宽度（像素）")
    ap.add_argument("--cols", type=int, default=0, help="宫格列数；0=按格数自动（2026-11-15 起可钉成 2 列）")
    ap.add_argument("--pages", type=int, default=1, help="一次出几张宫格（默认 1）；>1 时把 start~max 平分，每页一张，各存 grid-N.jpg")
    ap.add_argument("--yt-dlp", default="", help="yt-dlp 的路径；留空就自己找")
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()

    # 网址：先落成本地文件（B 站这类只有分离轨，得 yt-dlp 拉两轨再用 PyAV 合）
    source: dict = {}
    onlyVisual = None
    is_url = args.input.startswith(("http://", "https://"))
    if is_url:
        if args.probe:
            print(json.dumps({"ok": False, "error": "网址不给 probe——直接调 video_storyboard，它会自己下"}, ensure_ascii=False))
            return
        root = args.out or tempfile.mkdtemp(prefix="sb-url-")
        local, meta, onlyVisual = fetch(args.input, root, args.yt_dlp or None)
        if not local:
            print(json.dumps({"ok": False, "error": onlyVisual or "下载失败"}, ensure_ascii=False))
            return
        source = {
            "url": args.input,
            "title": meta.get("title") or meta.get("id") or "",
            "uploader": meta.get("uploader") or meta.get("channel") or "",
            "note": onlyVisual,
        }
        args.input = local

    if not os.path.exists(args.input):
        print(json.dumps({"ok": False, "error": f"没有这个文件：{args.input}"}, ensure_ascii=False))
        return

    if args.probe:
        print(json.dumps(probe(args.input), ensure_ascii=False))
        return

    info = probe(args.input)
    if not info.get("ok"):
        print(json.dumps(info, ensure_ascii=False))
        return

    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(args.input)), "_storyboard")
    os.makedirs(out_dir, exist_ok=True)

    start = max(0.0, float(args.start_seconds or 0.0))
    limit = min(args.max_seconds or info["duration"], info["duration"]) if args.max_seconds else info["duration"]
    if start >= limit:
        print(json.dumps({"ok": False, "error": f"起点 {start:g}s 不在片子里（这段到 {limit:g}s）"}, ensure_ascii=False))
        return

    pages = max(1, min(30, int(args.pages or 1)))
    seg = max(2.0, (limit - start) / pages) if pages > 1 else (limit - start)

    # 台词那半：整片转一次，各页共用（转写失败也不影响画面）
    segs: list[dict] = []
    asr_note = None
    if args.asr != "off":
        # 不做片段裁剪：faster-whisper 的 clip_timestamps 会漏段（2026-11-09 试过，40 秒只回 1 段）。
        # 全片转，代价约片长的 20%；嫌慢就 asr:false。
        segs, asr_note = transcribe(args.input, args.asr_model, device=args.asr_device)
        log(f"台词 {len(segs)} 段" + (f"（{asr_note}）" if asr_note else ""))

    grids: list[dict] = []
    page_cells: list[list[dict]] = []
    for p in range(pages):
        s0 = start + seg * p
        s1 = min(limit, s0 + seg)
        if s0 >= limit - 0.05:
            break
        diffs = scan(args.input, args.step, s1, s0)
        times = pick_times(diffs, max(1, args.max_frames), s1, s0)
        if not times:
            log(f"第 {p + 1} 页没挑出格子，跳过")
            continue
        frames = extract(args.input, times)
        times = times[: len(frames)]
        if not times:
            log(f"第 {p + 1} 页抓不到帧，跳过")
            continue
        attach_lines(times, segs)
        name = f"grid.{args.format}" if pages == 1 else f"grid-{p + 1}.{args.format}"
        png = os.path.join(out_dir, name)
        grids.append(sheet(frames, times, png, cell=max(160, args.cell), quality=max(40, min(95, args.quality)), cols=args.cols))
        page_cells.append([{
            "n": i + 1,
            "start": fmt_time(t["t"]),
            "end": fmt_time(t["end"]),
            "diff": t["diff"],
            "lines": t.get("lines", []),
        } for i, t in enumerate(times)])
        log(f"第 {p + 1} 页：{len(times)} 格（{fmt_time(times[0]['t'])}–{fmt_time(times[-1]['end'])}）")

    if not grids:
        print(json.dumps({"ok": False, "error": "这段没读出画面（时长 0 或解码失败）"}, ensure_ascii=False))
        return
    print(json.dumps({
        "ok": True,
        "source": source,
        "probe": info,
        "asr": {"ok": asr_note is None, "model": args.asr_model, "n": len(segs), "note": asr_note},
        "pages": len(grids),
        "grid": grids[0],
        "grids": grids,
        "cells": page_cells[0],
        "pageCells": page_cells,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
