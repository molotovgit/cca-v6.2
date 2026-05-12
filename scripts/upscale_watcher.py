"""
v6.2 image upscaler — runs alongside submit_prompts.cjs and save_images.cjs
in run_autonomous.cjs's child set.

Behavior:
  - Polls the chapter's images directory every CCA_UPSCALE_POLL_MS (default 3s).
  - For each PNG whose pixel width < TARGET_W (2560), and whose file size has
    been stable for STABILITY_MS (1.5s — ensures save_images is done writing),
    runs Real-ESRGAN ncnn-vulkan with the `realesrgan-x4plus` model to upscale
    4x → 4096x2288, then Pillow LANCZOS downscales to 2560x1440. The result
    atomically replaces the original PNG in place.
  - Exits gracefully on SIGTERM / Ctrl+C, after the in-flight upscale finishes.

Environment:
  CCA_REALESRGAN_EXE      path to realesrgan-ncnn-vulkan.exe
                          (default: D:\\tools\\realesrgan\\realesrgan-ncnn-vulkan.exe)
  CCA_REALESRGAN_MODEL    model name (default: realesrgan-x4plus)
  CCA_UPSCALE_TILE        tile size for the model (default: 192 — fits in 4 GB VRAM)
  CCA_UPSCALE_POLL_MS     poll interval in ms (default: 3000)

Usage:
  python scripts/upscale_watcher.py <chapter_images_dir>
"""
from __future__ import annotations

import os
import sys
import time
import signal
import subprocess
from pathlib import Path

# Force UTF-8 console (matches v6 convention)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

try:
    from PIL import Image
except ImportError:
    print('[upscale] ERROR: Pillow not installed. Run: pip install Pillow', file=sys.stderr)
    sys.exit(2)

# ---- config ----
REALESRGAN_EXE = os.environ.get('CCA_REALESRGAN_EXE', r'D:\tools\realesrgan\realesrgan-ncnn-vulkan.exe')
MODEL          = os.environ.get('CCA_REALESRGAN_MODEL', 'realesrgan-x4plus')
TILE           = os.environ.get('CCA_UPSCALE_TILE', '192')
POLL_MS        = int(os.environ.get('CCA_UPSCALE_POLL_MS', '3000'))
TARGET_W, TARGET_H = 2560, 1440
STABILITY_MS   = 1500

# ---- helpers ----
def ts():
    return time.strftime('%H:%M:%S')

def log(msg):
    print(f'{ts()} [UPSCALE] {msg}', flush=True)

def png_width(path: Path) -> int:
    """Read just the PNG IHDR to learn pixel width without decoding the image."""
    try:
        with open(path, 'rb') as f:
            sig = f.read(8)
            if sig != b'\x89PNG\r\n\x1a\n':
                return 0
            f.seek(16)
            w_bytes = f.read(4)
            return int.from_bytes(w_bytes, 'big')
    except Exception:
        return 0

def upscale_in_place(in_path: Path) -> bool:
    raw  = in_path.with_suffix('.raw.png')
    tmp  = in_path.with_suffix('.up.png')
    try:
        t0 = time.time()
        # Step 1: Real-ESRGAN 4x
        r = subprocess.run(
            [REALESRGAN_EXE, '-i', str(in_path), '-o', str(raw),
             '-s', '4', '-n', MODEL, '-t', TILE, '-f', 'png'],
            capture_output=True, text=True
        )
        if r.returncode != 0 or not raw.exists():
            log(f'  ! realesrgan failed (rc={r.returncode}): {r.stderr.strip()[-200:]}')
            return False
        # Step 2: Pillow LANCZOS downscale to target
        img = Image.open(raw).convert('RGB').resize((TARGET_W, TARGET_H), Image.LANCZOS)
        img.save(tmp, 'PNG', optimize=True)
        raw.unlink(missing_ok=True)
        # Step 3: atomic in-place replace
        os.replace(tmp, in_path)
        dt = time.time() - t0
        new_size = in_path.stat().st_size
        log(f'  ✓ {in_path.name}  {TARGET_W}x{TARGET_H}  {new_size/1024/1024:.1f} MB  ({dt:.1f}s)')
        return True
    except Exception as e:
        log(f'  ! {in_path.name} exception: {e}')
        return False
    finally:
        for f in (raw, tmp):
            try: f.unlink(missing_ok=True)
            except: pass

# ---- main ----
def main():
    if len(sys.argv) < 2:
        print('usage: upscale_watcher.py <chapter_images_dir>', file=sys.stderr)
        sys.exit(1)
    images_dir = Path(sys.argv[1])

    if not Path(REALESRGAN_EXE).exists():
        log(f'ERROR: realesrgan exe not found at {REALESRGAN_EXE}')
        log(f'  set CCA_REALESRGAN_EXE env var to override.')
        sys.exit(3)

    log(f'watcher start  dir={images_dir}  model={MODEL}  tile={TILE}  target={TARGET_W}x{TARGET_H}')
    log(f'realesrgan exe: {REALESRGAN_EXE}')

    # Wait for the chapter dir to exist (save_images creates it on first save).
    waited_for_dir = 0
    while not images_dir.exists():
        time.sleep(POLL_MS / 1000)
        waited_for_dir += POLL_MS / 1000
        if waited_for_dir % 30 < (POLL_MS/1000):
            log(f'  waiting for {images_dir} ({int(waited_for_dir)}s)')

    log(f'chapter dir present.')

    # graceful shutdown
    stopping = {'flag': False}
    def _stop(sig, frame):
        log(f'signal {sig} received — will exit after in-flight upscale finishes')
        stopping['flag'] = True
    try:
        signal.signal(signal.SIGINT,  _stop)
        signal.signal(signal.SIGTERM, _stop)
    except Exception:
        pass

    # stability tracker: path -> (size, first-seen-stable-ts)
    stability: dict[Path, tuple[int, float]] = {}

    upscaled_count = 0
    while True:
        try:
            pngs = sorted(p for p in images_dir.glob('*.png')
                          if not p.name.endswith('.raw.png')
                          and not p.name.endswith('.up.png'))
        except FileNotFoundError:
            pngs = []

        candidates = [p for p in pngs if png_width(p) < TARGET_W]

        if not candidates:
            stability.clear()
            if stopping['flag']:
                log(f'no work + stop signaled. exiting clean. (upscaled total this run: {upscaled_count})')
                sys.exit(0)
            time.sleep(POLL_MS / 1000)
            continue

        # Pick the first stable candidate
        picked = None
        now = time.time()
        for p in candidates:
            try:
                size = p.stat().st_size
            except FileNotFoundError:
                stability.pop(p, None)
                continue
            seen = stability.get(p)
            if seen is None or seen[0] != size:
                # First sighting at this size — mark and wait
                stability[p] = (size, now)
                continue
            if (now - seen[1]) * 1000 >= STABILITY_MS:
                picked = p
                break

        if picked is None:
            time.sleep(POLL_MS / 1000)
            continue

        log(f'upscaling {picked.name}  ({picked.stat().st_size/1024:.0f} KB → ...)')
        if upscale_in_place(picked):
            upscaled_count += 1
            stability.pop(picked, None)
        else:
            # keep it in stability so we'll retry on the next poll
            pass

if __name__ == '__main__':
    main()
