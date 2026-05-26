"""Tests for src/python/drivers/notion/extractor.py (NotionExtractor).

Currently: zero coverage. This file targets:
    - _get_rich_text: annotation rendering (bold, italic, strikethrough, code)
    - _get_media_url: file / external / url variants
    - _extract_block: all Notion block types mapped to Markdown
    - _extract_table: table rows → Markdown table
    - extract_page_text: composition of _extract_block calls
    - download_text_attachment: .txt file URL fetching, non-txt skip, error handling
"""

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub notion_client (not installed in all envs) before importing the module.
_nc_stub = types.ModuleType("notion_client")
_nc_stub.Client = MagicMock()
sys.modules.setdefault("notion_client", _nc_stub)

# Stub httpx for import-time safety (no real network in tests)
_httpx_stub = types.ModuleType("httpx")
_httpx_stub.get = MagicMock()
_httpx_stub.RequestError = Exception
sys.modules.setdefault("httpx", _httpx_stub)

from drivers.notion.extractor import NotionExtractor


def _make_extractor() -> NotionExtractor:
    client = MagicMock()
    navigator = MagicMock()
    return NotionExtractor(client=client, navigator=navigator)


def _rich_text_block(block_type: str, text: str, **annotations) -> dict:
    """Build a minimal Notion block with a plain_text rich-text entry."""
    ann = {"bold": False, "italic": False, "strikethrough": False, "code": False}
    ann.update(annotations)
    return {
        "id": "block-1",
        "type": block_type,
        block_type: {
            "rich_text": [{"plain_text": text, "annotations": ann}],
        },
        "has_children": False,
    }


# ──────────────────────────────────────────────────────────────────────────────
# _get_rich_text — annotation rendering
# ──────────────────────────────────────────────────────────────────────────────

class TestGetRichText:
    ext = _make_extractor()

    def test_plain_text_returned_as_is(self):
        block = _rich_text_block("paragraph", "Hello")
        assert self.ext._get_rich_text(block, "paragraph") == "Hello"

    def test_bold_annotation(self):
        block = _rich_text_block("paragraph", "Bold", bold=True)
        result = self.ext._get_rich_text(block, "paragraph")
        assert result == "**Bold**"

    def test_italic_annotation(self):
        block = _rich_text_block("paragraph", "Italic", italic=True)
        result = self.ext._get_rich_text(block, "paragraph")
        assert result == "*Italic*"

    def test_strikethrough_annotation(self):
        block = _rich_text_block("paragraph", "Strike", strikethrough=True)
        result = self.ext._get_rich_text(block, "paragraph")
        assert result == "~~Strike~~"

    def test_code_annotation(self):
        block = _rich_text_block("paragraph", "inline", code=True)
        result = self.ext._get_rich_text(block, "paragraph")
        assert result == "`inline`"

    def test_multiple_parts_joined(self):
        block = {
            "id": "b",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [
                    {"plain_text": "Hello", "annotations": {"bold": False, "italic": False, "strikethrough": False, "code": False}},
                    {"plain_text": " world", "annotations": {"bold": False, "italic": False, "strikethrough": False, "code": False}},
                ]
            },
            "has_children": False,
        }
        result = self.ext._get_rich_text(block, "paragraph")
        assert result == "Hello world"

    def test_empty_rich_text_returns_empty_string(self):
        block = {"type": "paragraph", "paragraph": {"rich_text": []}, "has_children": False}
        assert self.ext._get_rich_text(block, "paragraph") == ""


# ──────────────────────────────────────────────────────────────────────────────
# _get_media_url — URL extraction from different block shapes
# ──────────────────────────────────────────────────────────────────────────────

class TestGetMediaUrl:
    ext = _make_extractor()

    def test_file_url(self):
        block = {"type": "image", "image": {"file": {"url": "https://s3.amazonaws.com/img.png"}}}
        assert self.ext._get_media_url(block) == "https://s3.amazonaws.com/img.png"

    def test_external_url(self):
        block = {"type": "image", "image": {"external": {"url": "https://example.com/img.png"}}}
        assert self.ext._get_media_url(block) == "https://example.com/img.png"

    def test_direct_url_field(self):
        block = {"type": "bookmark", "bookmark": {"url": "https://example.com"}}
        assert self.ext._get_media_url(block) == "https://example.com"

    def test_returns_none_when_no_url(self):
        block = {"type": "image", "image": {}}
        assert self.ext._get_media_url(block) is None


# ──────────────────────────────────────────────────────────────────────────────
# _extract_block — Notion block types → Markdown
# ──────────────────────────────────────────────────────────────────────────────

class TestExtractBlock:
    def setup_method(self):
        self.ext = _make_extractor()

    def test_heading_1(self):
        block = _rich_text_block("heading_1", "Big Title")
        result = self.ext._extract_block(block)
        assert result == "# Big Title"

    def test_heading_2(self):
        block = _rich_text_block("heading_2", "Sub Title")
        result = self.ext._extract_block(block)
        assert result == "## Sub Title"

    def test_heading_3(self):
        block = _rich_text_block("heading_3", "Small Title")
        result = self.ext._extract_block(block)
        assert result == "### Small Title"

    def test_paragraph(self):
        block = _rich_text_block("paragraph", "Normal text.")
        result = self.ext._extract_block(block)
        assert result == "Normal text."

    def test_bulleted_list_item(self):
        block = _rich_text_block("bulleted_list_item", "Item A")
        result = self.ext._extract_block(block)
        assert result == "- Item A"

    def test_bulleted_list_item_nested(self):
        block = _rich_text_block("bulleted_list_item", "Item A")
        result = self.ext._extract_block(block, depth=1)
        assert result == "  - Item A"

    def test_numbered_list_item(self):
        block = _rich_text_block("numbered_list_item", "First")
        result = self.ext._extract_block(block)
        assert result == "1. First"

    def test_to_do_unchecked(self):
        block = {
            "id": "b1", "type": "to_do",
            "to_do": {"rich_text": [{"plain_text": "Task", "annotations": {}}], "checked": False},
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result == "- [ ] Task"

    def test_to_do_checked(self):
        block = {
            "id": "b1", "type": "to_do",
            "to_do": {"rich_text": [{"plain_text": "Done", "annotations": {}}], "checked": True},
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result == "- [x] Done"

    def test_quote(self):
        block = _rich_text_block("quote", "A quoted text")
        result = self.ext._extract_block(block)
        assert result == "> A quoted text"

    def test_callout_with_emoji(self):
        block = {
            "id": "b1", "type": "callout",
            "callout": {
                "rich_text": [{"plain_text": "Note", "annotations": {}}],
                "icon": {"emoji": "💡"},
            },
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result == "> 💡 Note"

    def test_callout_without_icon(self):
        block = {
            "id": "b1", "type": "callout",
            "callout": {
                "rich_text": [{"plain_text": "Note", "annotations": {}}],
                "icon": None,
            },
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result is not None
        assert "Note" in result

    def test_code_block(self):
        block = {
            "id": "b1", "type": "code",
            "code": {
                "rich_text": [{"plain_text": "x = 1", "annotations": {}}],
                "language": "python",
            },
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result == "```python\nx = 1\n```"

    def test_divider(self):
        block = {"id": "b1", "type": "divider", "divider": {}, "has_children": False}
        result = self.ext._extract_block(block)
        assert result == "---"

    def test_child_page_returns_none(self):
        block = {"id": "b1", "type": "child_page", "child_page": {"title": "Sub"}, "has_children": False}
        result = self.ext._extract_block(block)
        assert result is None

    def test_image_block_with_url(self):
        block = {
            "id": "b1", "type": "image",
            "image": {"file": {"url": "https://img.example.com/pic.jpg"}},
            "has_children": False,
        }
        result = self.ext._extract_block(block)
        assert result is not None
        assert "image:" in result
        assert "https://img.example.com/pic.jpg" in result

    def test_image_block_without_url(self):
        block = {"id": "b1", "type": "image", "image": {}, "has_children": False}
        result = self.ext._extract_block(block)
        assert result == "[image]"

    def test_unknown_block_type_with_no_text_returns_none(self):
        block = {"id": "b1", "type": "some_future_block", "some_future_block": {}, "has_children": False}
        result = self.ext._extract_block(block)
        assert result is None

    def test_block_with_nested_children_appended(self):
        parent = _rich_text_block("paragraph", "Parent text")
        parent["has_children"] = True
        child = _rich_text_block("paragraph", "Child text")
        self.ext.client.get_block_children.return_value = [child]
        result = self.ext._extract_block(parent)
        assert "Parent text" in result
        assert "Child text" in result

    def test_toggle_block_renders_text(self):
        block = _rich_text_block("toggle", "Toggle label")
        result = self.ext._extract_block(block)
        assert result == "Toggle label"


# ──────────────────────────────────────────────────────────────────────────────
# _extract_table — rows → Markdown
# ──────────────────────────────────────────────────────────────────────────────

class TestExtractTable:
    def setup_method(self):
        self.ext = _make_extractor()

    def _table_row(self, *cells: str) -> dict:
        return {
            "type": "table_row",
            "table_row": {
                "cells": [[{"plain_text": c}] for c in cells]
            },
        }

    def test_two_column_table(self):
        block = {"id": "tbl", "type": "table", "table": {}, "has_children": True}
        rows = [self._table_row("Name", "Age"), self._table_row("Alice", "30")]
        self.ext.client.get_block_children.return_value = rows
        result = self.ext._extract_table(block)
        assert result is not None
        assert "| Name | Age |" in result
        assert "| --- | --- |" in result
        assert "| Alice | 30 |" in result

    def test_single_row_still_adds_separator(self):
        block = {"id": "tbl", "type": "table", "table": {}, "has_children": True}
        rows = [self._table_row("Col1", "Col2")]
        self.ext.client.get_block_children.return_value = rows
        result = self.ext._extract_table(block)
        assert "---" in result

    def test_returns_none_when_no_children(self):
        block = {"id": "tbl", "type": "table", "table": {}, "has_children": False}
        result = self.ext._extract_table(block)
        assert result is None

    def test_returns_none_when_rows_empty(self):
        block = {"id": "tbl", "type": "table", "table": {}, "has_children": True}
        self.ext.client.get_block_children.return_value = []
        result = self.ext._extract_table(block)
        assert result is None


# ──────────────────────────────────────────────────────────────────────────────
# extract_page_text — integration of _extract_block calls
# ──────────────────────────────────────────────────────────────────────────────

class TestExtractPageText:
    def setup_method(self):
        self.ext = _make_extractor()

    def test_combines_blocks_with_double_newline(self):
        blocks = [
            _rich_text_block("paragraph", "First"),
            _rich_text_block("paragraph", "Second"),
        ]
        self.ext.client.get_block_children.return_value = blocks
        result = self.ext.extract_page_text("page-id")
        assert result == "First\n\nSecond"

    def test_skips_blocks_that_produce_no_text(self):
        blocks = [
            _rich_text_block("paragraph", "Real"),
            {"id": "cp", "type": "child_page", "child_page": {"title": "Sub"}, "has_children": False},
        ]
        self.ext.client.get_block_children.return_value = blocks
        result = self.ext.extract_page_text("page-id")
        assert "child_page" not in result
        assert "Real" in result

    def test_empty_page_returns_empty_string(self):
        self.ext.client.get_block_children.return_value = []
        assert self.ext.extract_page_text("page-id") == ""


# ──────────────────────────────────────────────────────────────────────────────
# download_text_attachment
# ──────────────────────────────────────────────────────────────────────────────

class TestDownloadTextAttachment:
    def setup_method(self):
        self.ext = _make_extractor()

    def _file_block(self, name: str, url: str, is_external: bool = False) -> dict:
        if is_external:
            file_data = {"name": name, "external": {"url": url}}
        else:
            file_data = {"name": name, "file": {"url": url}}
        return {"id": "fb1", "type": "file", "file": file_data}

    def test_downloads_txt_file_via_file_url(self):
        self.ext.client.get_block_children.return_value = [
            self._file_block("chapter.txt", "https://s3.example.com/chapter.txt")
        ]
        mock_resp = MagicMock()
        mock_resp.text = "Chapter content here."
        mock_resp.raise_for_status = MagicMock()
        with patch("httpx.get", return_value=mock_resp):
            result = self.ext.download_text_attachment("page-id")
        assert result == "Chapter content here."

    def test_downloads_txt_via_external_url(self):
        self.ext.client.get_block_children.return_value = [
            self._file_block("doc.txt", "https://external.example.com/doc.txt", is_external=True)
        ]
        mock_resp = MagicMock()
        mock_resp.text = "External content."
        mock_resp.raise_for_status = MagicMock()
        with patch("httpx.get", return_value=mock_resp):
            result = self.ext.download_text_attachment("page-id")
        assert result == "External content."

    def test_skips_non_txt_files(self):
        block = self._file_block("image.png", "https://s3.example.com/image.png")
        self.ext.client.get_block_children.return_value = [block]
        with patch("httpx.get") as mock_get:
            result = self.ext.download_text_attachment("page-id")
        mock_get.assert_not_called()
        assert result == ""

    def test_skips_blocks_without_url(self):
        block = {"id": "fb1", "type": "file", "file": {"name": "file.txt"}}  # no url
        self.ext.client.get_block_children.return_value = [block]
        with patch("httpx.get") as mock_get:
            result = self.ext.download_text_attachment("page-id")
        mock_get.assert_not_called()
        assert result == ""

    def test_handles_httpx_error_gracefully(self):
        self.ext.client.get_block_children.return_value = [
            self._file_block("chapter.txt", "https://s3.example.com/chapter.txt")
        ]
        import httpx as _httpx
        with patch("httpx.get", side_effect=Exception("network error")):
            result = self.ext.download_text_attachment("page-id")
        assert result == ""

    def test_skips_empty_txt_content(self):
        self.ext.client.get_block_children.return_value = [
            self._file_block("chapter.txt", "https://example.com/empty.txt")
        ]
        mock_resp = MagicMock()
        mock_resp.text = "   \n  "
        mock_resp.raise_for_status = MagicMock()
        with patch("httpx.get", return_value=mock_resp):
            result = self.ext.download_text_attachment("page-id")
        assert result == ""

    def test_concatenates_multiple_txt_blocks(self):
        blocks = [
            self._file_block("a.txt", "https://example.com/a.txt"),
            self._file_block("b.txt", "https://example.com/b.txt"),
        ]
        self.ext.client.get_block_children.return_value = blocks
        mock_resp_a = MagicMock()
        mock_resp_a.text = "Part A"
        mock_resp_a.raise_for_status = MagicMock()
        mock_resp_b = MagicMock()
        mock_resp_b.text = "Part B"
        mock_resp_b.raise_for_status = MagicMock()
        with patch("httpx.get", side_effect=[mock_resp_a, mock_resp_b]):
            result = self.ext.download_text_attachment("page-id")
        assert "Part A" in result
        assert "Part B" in result
