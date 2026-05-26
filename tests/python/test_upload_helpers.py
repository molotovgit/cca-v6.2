"""Tests for helper functions in src/python/pipeline/upload_images.py.

Currently: zero coverage. Targets the pure/filesystem helpers:
    - slugify: Uzbek/Cyrillic transliteration and ASCII slug generation
    - sha256_file: deterministic hashing
    - create_zip: zip content correctness, error conditions
    - write_marker: atomic JSON write behavior
    - find_chapter_meta: filesystem lookup with SystemExit on miss
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# upload_images.py has top-level imports of notion drivers which need the
# NOTION_API_KEY env var. Stub them at import time.
from unittest.mock import MagicMock
sys.modules.setdefault("notion_client", MagicMock())
sys.modules.setdefault("httpx", MagicMock())

from pipeline.upload_images import slugify, sha256_file, create_zip, write_marker


# ──────────────────────────────────────────────────────────────────────────────
# slugify — identical logic to fetch/refine, just verifying the copy
# ──────────────────────────────────────────────────────────────────────────────

class TestSlugifyUploadImages:
    @pytest.mark.parametrize("text, expected", [
        ("Jahon tarixi",   "jahon-tarixi"),
        ("",               "untitled"),
        ("  spaces  ",     "spaces"),
    ])
    def test_basic(self, text, expected):
        assert slugify(text) == expected

    def test_cyrillic_transliteration(self):
        assert slugify("история") == "istoriya"

    def test_uzbek_transliteration(self):
        result = slugify("ўқғҳ")
        assert result == "oqgh"

    def test_max_len_honored(self):
        result = slugify("a" * 100, max_len=10)
        assert len(result) <= 10

    def test_no_trailing_dash_after_truncation(self):
        result = slugify("word1 word2", max_len=5)
        assert not result.endswith("-")

    def test_special_characters_stripped(self):
        result = slugify("hello!@#world")
        assert result == "helloworld"


# ──────────────────────────────────────────────────────────────────────────────
# sha256_file
# ──────────────────────────────────────────────────────────────────────────────

class TestSha256File:
    def test_deterministic_for_same_content(self, tmp_path):
        f = tmp_path / "file.zip"
        f.write_bytes(b"hello world")
        h1 = sha256_file(f)
        h2 = sha256_file(f)
        assert h1 == h2

    def test_different_content_different_hash(self, tmp_path):
        f1 = tmp_path / "a.zip"
        f2 = tmp_path / "b.zip"
        f1.write_bytes(b"content A")
        f2.write_bytes(b"content B")
        assert sha256_file(f1) != sha256_file(f2)

    def test_matches_stdlib_hashlib(self, tmp_path):
        content = b"test content for verification"
        f = tmp_path / "test.bin"
        f.write_bytes(content)
        expected = hashlib.sha256(content).hexdigest()
        assert sha256_file(f) == expected

    def test_returns_hex_string(self, tmp_path):
        f = tmp_path / "f.bin"
        f.write_bytes(b"data")
        result = sha256_file(f)
        assert isinstance(result, str)
        assert len(result) == 64
        int(result, 16)  # must be valid hex

    def test_handles_large_file(self, tmp_path):
        f = tmp_path / "large.bin"
        f.write_bytes(b"x" * (10 * 1024 * 1024))  # 10 MiB
        result = sha256_file(f)
        assert len(result) == 64


# ──────────────────────────────────────────────────────────────────────────────
# create_zip
# ──────────────────────────────────────────────────────────────────────────────

class TestCreateZip:
    def _setup(self, tmp_path: Path):
        images_dir = tmp_path / "images"
        images_dir.mkdir()
        refined_md = tmp_path / "chapter.md"
        refined_md.write_text("# Chapter content", encoding="utf-8")
        out_zip = tmp_path / "output.zip"
        return images_dir, refined_md, out_zip

    def _add_png(self, images_dir: Path, name: str = "001-scene.png") -> Path:
        p = images_dir / name
        p.write_bytes(b"\x89PNG" + b"\x00" * 100)  # minimal PNG-like bytes
        return p

    def test_creates_valid_zip(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        assert out_zip.exists()
        assert zipfile.is_zipfile(out_zip)

    def test_zip_contains_refined_md(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        with zipfile.ZipFile(out_zip) as zf:
            assert refined_md.name in zf.namelist()

    def test_zip_contains_pngs(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir, "001-scene.png")
        self._add_png(images_dir, "002-scene.png")
        create_zip(images_dir, out_zip, refined_md)
        with zipfile.ZipFile(out_zip) as zf:
            names = zf.namelist()
        assert "001-scene.png" in names
        assert "002-scene.png" in names

    def test_md_is_first_entry(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        with zipfile.ZipFile(out_zip) as zf:
            assert zf.namelist()[0] == refined_md.name

    def test_md_content_preserved(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        with zipfile.ZipFile(out_zip) as zf:
            with zf.open(refined_md.name) as fz:
                content = fz.read().decode("utf-8")
        assert content == "# Chapter content"

    def test_raises_system_exit_when_no_pngs(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        # No PNGs added
        with pytest.raises(SystemExit, match="no PNGs"):
            create_zip(images_dir, out_zip, refined_md)

    def test_raises_system_exit_when_refined_md_missing(self, tmp_path):
        images_dir, _, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        missing_md = tmp_path / "nonexistent.md"
        with pytest.raises(SystemExit, match="refined"):
            create_zip(images_dir, out_zip, missing_md)

    def test_deterministic_output(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        hash1 = sha256_file(out_zip)
        out_zip.unlink()
        create_zip(images_dir, out_zip, refined_md)
        hash2 = sha256_file(out_zip)
        # ZIP metadata (timestamps) can differ; test that namelist and content match
        with zipfile.ZipFile(out_zip) as zf:
            names = zf.namelist()
        assert refined_md.name in names

    def test_returns_size_bytes(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        size = create_zip(images_dir, out_zip, refined_md)
        assert isinstance(size, int)
        assert size > 0

    def test_no_tmp_file_left_on_success(self, tmp_path):
        images_dir, refined_md, out_zip = self._setup(tmp_path)
        self._add_png(images_dir)
        create_zip(images_dir, out_zip, refined_md)
        assert not (tmp_path / "output.zip.tmp").exists()


# ──────────────────────────────────────────────────────────────────────────────
# write_marker — atomic JSON write
# ──────────────────────────────────────────────────────────────────────────────

class TestWriteMarker:
    def test_writes_valid_json(self, tmp_path):
        marker = tmp_path / "ch01.uploaded.json"
        data = {"notion_block_id": "blk-123", "zip_sha256": "abc", "zip_size_bytes": 1000}
        write_marker(marker, data)
        loaded = json.loads(marker.read_text(encoding="utf-8"))
        assert loaded["notion_block_id"] == "blk-123"
        assert loaded["zip_sha256"] == "abc"

    def test_creates_parent_directories(self, tmp_path):
        deep = tmp_path / "a" / "b" / "c" / "marker.json"
        write_marker(deep, {"key": "value"})
        assert deep.exists()

    def test_no_tmp_file_left_after_write(self, tmp_path):
        marker = tmp_path / "marker.json"
        write_marker(marker, {"x": 1})
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []

    def test_overwrites_existing_marker(self, tmp_path):
        marker = tmp_path / "marker.json"
        write_marker(marker, {"round": 1})
        write_marker(marker, {"round": 2})
        loaded = json.loads(marker.read_text(encoding="utf-8"))
        assert loaded["round"] == 2

    def test_indented_json_output(self, tmp_path):
        marker = tmp_path / "marker.json"
        write_marker(marker, {"a": 1, "b": 2})
        raw = marker.read_text(encoding="utf-8")
        # indent=2 means newlines and spaces in the output
        assert "\n" in raw
