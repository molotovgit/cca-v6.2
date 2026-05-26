"""Tests for helper functions in src/python/utils/upscale_watcher.py.

Targets the two testable pure/filesystem helpers:
    - png_width: reads PNG IHDR to extract pixel width without full decode
    - upscale_in_place: orchestrates realesrgan + Pillow (subprocess mocked)

upscale_in_place is tested with subprocess and PIL both mocked — it has no
testable logic that requires a real GPU or realesrgan binary.
"""

import struct
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch, call
import subprocess

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub PIL before import so tests run without Pillow installed in CI.
_pil_stub = MagicMock()
sys.modules.setdefault("PIL", _pil_stub)
sys.modules.setdefault("PIL.Image", _pil_stub.Image)

from utils.upscale_watcher import png_width, upscale_in_place


# ──────────────────────────────────────────────────────────────────────────────
# Helpers for constructing minimal PNG byte sequences
# ──────────────────────────────────────────────────────────────────────────────

PNG_SIG = b'\x89PNG\r\n\x1a\n'

def _make_png_header(width: int, height: int = 720) -> bytes:
    """Build just enough PNG bytes for png_width to parse (sig + IHDR header)."""
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr_len = struct.pack('>I', len(ihdr_data))
    ihdr_type = b'IHDR'
    crc = b'\x00\x00\x00\x00'
    return PNG_SIG + ihdr_len + ihdr_type + ihdr_data + crc


# ──────────────────────────────────────────────────────────────────────────────
# png_width — reads IHDR for width without loading full image
# ──────────────────────────────────────────────────────────────────────────────

class TestPngWidth:
    def test_reads_correct_width(self, tmp_path):
        p = tmp_path / "test.png"
        p.write_bytes(_make_png_header(1920))
        assert png_width(p) == 1920

    def test_reads_2560_target_width(self, tmp_path):
        p = tmp_path / "test.png"
        p.write_bytes(_make_png_header(2560))
        assert png_width(p) == 2560

    def test_reads_small_width(self, tmp_path):
        p = tmp_path / "small.png"
        p.write_bytes(_make_png_header(256))
        assert png_width(p) == 256

    def test_returns_zero_for_non_png(self, tmp_path):
        p = tmp_path / "not_a_png.png"
        p.write_bytes(b"this is not a PNG file at all")
        assert png_width(p) == 0

    def test_returns_zero_for_missing_file(self, tmp_path):
        p = tmp_path / "nonexistent.png"
        assert png_width(p) == 0

    def test_returns_zero_for_empty_file(self, tmp_path):
        p = tmp_path / "empty.png"
        p.write_bytes(b"")
        assert png_width(p) == 0

    def test_returns_zero_for_truncated_png(self, tmp_path):
        # Signature present but IHDR incomplete
        p = tmp_path / "truncated.png"
        p.write_bytes(PNG_SIG + b'\x00\x00\x00')
        assert png_width(p) == 0

    def test_handles_large_width(self, tmp_path):
        p = tmp_path / "large.png"
        p.write_bytes(_make_png_header(65535))
        assert png_width(p) == 65535

    def test_width_1_edge_case(self, tmp_path):
        p = tmp_path / "one.png"
        p.write_bytes(_make_png_header(1))
        assert png_width(p) == 1


# ──────────────────────────────────────────────────────────────────────────────
# upscale_in_place — mocked subprocess + PIL
# ──────────────────────────────────────────────────────────────────────────────

class TestUpscaleInPlace:
    def _setup(self, tmp_path: Path) -> Path:
        """Create a minimal source PNG for upscaling."""
        p = tmp_path / "001-scene.png"
        p.write_bytes(_make_png_header(512))
        return p

    def _mock_realesrgan_success(self, in_path: Path):
        """Return a subprocess mock that creates the raw.png output file."""
        raw = in_path.with_suffix('.raw.png')
        def _side_effect(*args, **kwargs):
            raw.write_bytes(_make_png_header(4096))
            result = MagicMock()
            result.returncode = 0
            result.stderr = ""
            return result
        return _side_effect

    def test_returns_true_on_success(self, tmp_path):
        p = self._setup(tmp_path)
        mock_img = MagicMock()
        with patch('subprocess.run', side_effect=self._mock_realesrgan_success(p)), \
             patch('utils.upscale_watcher.Image') as mock_pil:
            mock_pil.open.return_value.__enter__ = MagicMock(return_value=mock_img)
            mock_pil.open.return_value.convert.return_value.resize.return_value = mock_img
            mock_img.save = MagicMock(side_effect=lambda path, *a, **kw: Path(path).write_bytes(b'\x89PNG' + b'\x00' * 100))
            result = upscale_in_place(p)
        assert result is True

    def test_returns_false_when_realesrgan_fails(self, tmp_path):
        p = self._setup(tmp_path)
        fail_result = MagicMock()
        fail_result.returncode = 1
        fail_result.stderr = "CUDA error"
        with patch('subprocess.run', return_value=fail_result):
            result = upscale_in_place(p)
        assert result is False

    def test_returns_false_when_realesrgan_produces_no_output(self, tmp_path):
        p = self._setup(tmp_path)
        ok_result = MagicMock()
        ok_result.returncode = 0
        ok_result.stderr = ""
        # raw.png is NOT created — subprocess reports success but file is missing
        with patch('subprocess.run', return_value=ok_result):
            result = upscale_in_place(p)
        assert result is False

    def test_cleans_up_tmp_files_on_success(self, tmp_path):
        p = self._setup(tmp_path)
        raw = p.with_suffix('.raw.png')
        tmp = p.with_suffix('.up.png')

        def fake_run(*args, **kwargs):
            raw.write_bytes(b'\x89PNG' + b'\x00' * 100)
            r = MagicMock()
            r.returncode = 0
            r.stderr = ""
            return r

        mock_final = MagicMock()
        mock_final.save = MagicMock(
            side_effect=lambda path, *a, **kw: Path(path).write_bytes(b'\x89PNG' + b'\x00' * 50)
        )
        with patch('subprocess.run', side_effect=fake_run), \
             patch('utils.upscale_watcher.Image') as mock_pil:
            mock_pil.open.return_value.convert.return_value.resize.return_value = mock_final
            upscale_in_place(p)

        assert not raw.exists(), ".raw.png should be cleaned up"

    def test_cleans_up_tmp_files_on_failure(self, tmp_path):
        p = self._setup(tmp_path)
        raw = p.with_suffix('.raw.png')
        tmp = p.with_suffix('.up.png')

        fail_result = MagicMock()
        fail_result.returncode = 1
        fail_result.stderr = "error"
        with patch('subprocess.run', return_value=fail_result):
            upscale_in_place(p)

        assert not raw.exists()
        assert not tmp.exists()

    def test_returns_false_on_exception(self, tmp_path):
        p = self._setup(tmp_path)
        with patch('subprocess.run', side_effect=OSError("binary not found")):
            result = upscale_in_place(p)
        assert result is False

    def test_passes_correct_realesrgan_args(self, tmp_path):
        p = self._setup(tmp_path)
        captured_args = []

        def fake_run(args, **kwargs):
            captured_args.extend(args)
            r = MagicMock()
            r.returncode = 1  # fail fast so we don't need PIL
            r.stderr = ""
            return r

        with patch('subprocess.run', side_effect=fake_run):
            upscale_in_place(p)

        assert str(p) in captured_args
        assert '-i' in captured_args
        assert '-o' in captured_args
        assert '-s' in captured_args
        assert '4' in captured_args
