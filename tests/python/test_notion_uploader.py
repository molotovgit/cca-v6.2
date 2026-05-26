"""Tests for src/python/drivers/notion/uploader.py.

Uses unittest.mock to simulate httpx responses; no live Notion API calls.

Coverage:
    - find_images_subpage: exact match, substring fallback, multiple matches, no images
    - upload_file_multipart: chunk calculation, too-small file, create/send/complete flow,
      per-part retry, create/complete retry, unexpected complete status
    - attach_file_block: success, 403 with helpful message, other error
"""

import io
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

from drivers.notion.uploader import (
    attach_file_block,
    find_images_subpage,
    upload_file_multipart,
    MIN_PART_BYTES,
    MAX_PART_BYTES,
)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _subpage(title: str, type_hint: str = "images") -> dict:
    return {"id": f"id-{title}", "title": title, "type_hint": type_hint}


def _mock_response(status: int, body: dict | str = None) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    if body is None:
        body = {}
    r.json.return_value = body if isinstance(body, dict) else {}
    r.text = json.dumps(body) if isinstance(body, dict) else str(body)
    return r


def _make_zip(tmp_path: Path, size_bytes: int) -> Path:
    p = tmp_path / "test.zip"
    p.write_bytes(b"Z" * size_bytes)
    return p


# ──────────────────────────────────────────────────────────────────────────────
# find_images_subpage
# ──────────────────────────────────────────────────────────────────────────────

class TestFindImagesSubpage:
    def _nav(self, subpages):
        n = MagicMock()
        n.get_chapter_subpages.return_value = subpages
        return n

    def test_returns_exact_match(self):
        nav = self._nav([_subpage("Images"), _subpage("Video", "video")])
        result = find_images_subpage(nav, "ch-id")
        assert result["title"] == "Images"

    def test_returns_none_when_no_images_subpage(self):
        nav = self._nav([_subpage("Video", "video"), _subpage("Text", "text_original")])
        result = find_images_subpage(nav, "ch-id")
        assert result is None

    def test_strict_prefers_exact_over_substring(self):
        nav = self._nav([
            _subpage("My Images Folder"),  # substring match
            _subpage("Images"),            # exact match
        ])
        result = find_images_subpage(nav, "ch-id", strict=True)
        assert result["title"] == "Images"

    def test_strict_falls_back_to_substring_when_no_exact(self):
        nav = self._nav([_subpage("Chapter Images Folder")])
        result = find_images_subpage(nav, "ch-id", strict=True)
        assert result is not None
        assert result["title"] == "Chapter Images Folder"

    def test_non_strict_returns_first_images_subpage(self):
        nav = self._nav([_subpage("Chapter Images"), _subpage("Images")])
        result = find_images_subpage(nav, "ch-id", strict=False)
        assert result["title"] == "Chapter Images"  # first match wins

    def test_images_with_number_is_exact_match(self):
        # "Images 2" should still qualify as an exact match
        nav = self._nav([_subpage("Images 2")])
        result = find_images_subpage(nav, "ch-id", strict=True)
        assert result["title"] == "Images 2"

    def test_images_case_insensitive(self):
        nav = self._nav([_subpage("images")])
        result = find_images_subpage(nav, "ch-id", strict=True)
        assert result is not None

    def test_empty_subpages_returns_none(self):
        nav = self._nav([])
        assert find_images_subpage(nav, "ch-id") is None


# ──────────────────────────────────────────────────────────────────────────────
# upload_file_multipart
# ──────────────────────────────────────────────────────────────────────────────

class TestUploadFileMultipart:
    _UPLOAD_ID = "upload-abc-123"

    def _create_response(self):
        return _mock_response(200, {
            "id": self._UPLOAD_ID,
            "upload_url": "https://api.notion.com/v1/file_uploads/upload-abc-123/send",
        })

    def _send_response(self):
        return _mock_response(200, {})

    def _complete_response(self):
        return _mock_response(200, {"status": "uploaded", "id": self._UPLOAD_ID})

    def test_raises_for_chunk_too_small(self, tmp_path):
        p = _make_zip(tmp_path, 30 * 1024 * 1024)
        with pytest.raises(RuntimeError, match="out of Notion's allowed range"):
            upload_file_multipart("key", p, chunk_mb=4)

    def test_raises_for_chunk_too_large(self, tmp_path):
        p = _make_zip(tmp_path, 30 * 1024 * 1024)
        with pytest.raises(RuntimeError, match="out of Notion's allowed range"):
            upload_file_multipart("key", p, chunk_mb=21)

    def test_raises_for_file_too_small(self, tmp_path):
        p = _make_zip(tmp_path, 100)  # 100 bytes < 5 MiB minimum part size
        with pytest.raises(RuntimeError, match="too small for multi-part"):
            upload_file_multipart("key", p)

    def test_single_part_upload_happy_path(self, tmp_path):
        size = 6 * 1024 * 1024  # 6 MiB → 1 part at chunk_mb=15
        p = _make_zip(tmp_path, size)
        with patch("httpx.post") as mock_post:
            mock_post.side_effect = [
                self._create_response(),
                self._send_response(),
                self._complete_response(),
            ]
            uid = upload_file_multipart("key", p)
        assert uid == self._UPLOAD_ID
        assert mock_post.call_count == 3

    def test_multi_part_upload_correct_part_count(self, tmp_path):
        # 35 MiB with chunk_mb=15 → 3 parts (15+15+5)
        size = 35 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        with patch("httpx.post") as mock_post:
            # 1 create + 3 parts + 1 complete = 5 calls
            mock_post.side_effect = (
                [self._create_response()]
                + [self._send_response()] * 3
                + [self._complete_response()]
            )
            upload_file_multipart("key", p)
        assert mock_post.call_count == 5

    def test_per_part_retry_on_transient_failure(self, tmp_path):
        size = 6 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        fail_then_ok = [_mock_response(503), self._send_response()]
        with patch("httpx.post") as mock_post:
            with patch("time.sleep"):
                mock_post.side_effect = (
                    [self._create_response()]
                    + fail_then_ok
                    + [self._complete_response()]
                )
                uid = upload_file_multipart("key", p, max_retries_per_part=3)
        assert uid == self._UPLOAD_ID

    def test_part_exhausts_retries_raises(self, tmp_path):
        size = 6 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        with patch("httpx.post") as mock_post:
            with patch("time.sleep"):
                mock_post.side_effect = (
                    [self._create_response()]
                    + [_mock_response(503)] * 5
                )
                with pytest.raises(RuntimeError, match="failed after"):
                    upload_file_multipart("key", p, max_retries_per_part=3)

    def test_unexpected_complete_status_raises(self, tmp_path):
        size = 6 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        bad_complete = _mock_response(200, {"status": "pending"})
        with patch("httpx.post") as mock_post:
            mock_post.side_effect = [
                self._create_response(),
                self._send_response(),
                bad_complete,
            ]
            with pytest.raises(RuntimeError, match="unexpected status"):
                upload_file_multipart("key", p)

    def test_create_failure_retries_and_raises(self, tmp_path):
        size = 6 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        with patch("httpx.post") as mock_post:
            with patch("time.sleep"):
                mock_post.return_value = _mock_response(500, "server error")
                with pytest.raises(RuntimeError, match="create failed"):
                    upload_file_multipart("key", p)

    def test_returns_upload_id_string(self, tmp_path):
        size = 6 * 1024 * 1024
        p = _make_zip(tmp_path, size)
        with patch("httpx.post") as mock_post:
            mock_post.side_effect = [
                self._create_response(),
                self._send_response(),
                self._complete_response(),
            ]
            result = upload_file_multipart("key", p)
        assert isinstance(result, str)
        assert result == self._UPLOAD_ID


# ──────────────────────────────────────────────────────────────────────────────
# attach_file_block
# ──────────────────────────────────────────────────────────────────────────────

class TestAttachFileBlock:
    def test_happy_path_returns_block_id(self):
        resp = _mock_response(200, {"results": [{"id": "block-xyz"}]})
        with patch("httpx.patch", return_value=resp):
            block_id = attach_file_block("key", "page-id", "upload-id", "test.zip")
        assert block_id == "block-xyz"

    def test_403_raises_with_helpful_message(self):
        resp = _mock_response(403)
        with patch("httpx.patch", return_value=resp):
            with pytest.raises(RuntimeError, match="Insert content"):
                attach_file_block("key", "page-id", "upload-id", "test.zip")

    def test_other_error_raises_generic(self):
        resp = _mock_response(500, "internal error")
        with patch("httpx.patch", return_value=resp):
            with pytest.raises(RuntimeError, match="block attach failed"):
                attach_file_block("key", "page-id", "upload-id", "test.zip")

    def test_empty_results_raises(self):
        resp = _mock_response(200, {"results": []})
        with patch("httpx.patch", return_value=resp):
            with pytest.raises(RuntimeError, match="empty results"):
                attach_file_block("key", "page-id", "upload-id", "test.zip")

    def test_authorization_header_sent(self):
        resp = _mock_response(200, {"results": [{"id": "blk"}]})
        with patch("httpx.patch", return_value=resp) as mock_patch:
            attach_file_block("my-key", "page-id", "upload-id", "test.zip")
        _, kwargs = mock_patch.call_args
        assert "Authorization" in kwargs["headers"]
        assert "my-key" in kwargs["headers"]["Authorization"]

    def test_notion_version_header_sent(self):
        resp = _mock_response(200, {"results": [{"id": "blk"}]})
        with patch("httpx.patch", return_value=resp) as mock_patch:
            attach_file_block("key", "page-id", "upload-id", "test.zip")
        _, kwargs = mock_patch.call_args
        assert "Notion-Version" in kwargs["headers"]
