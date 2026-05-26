"""Tests for src/python/drivers/notion/client.py (NotionClientWrapper).

Currently: zero coverage. This file establishes baseline coverage for:
    - __init__: API key validation (missing, placeholder, invalid prefix, quote stripping)
    - get_page_title: rich-text title extraction
    - get_child_pages: child_page block filtering
    - get_text_blocks: text-type block filtering
    - stats: request counter
    - get_block_children: pagination (has_more, cursor forwarding)
"""

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub notion_client (not installed in all envs) before importing the module.
_nc_stub = types.ModuleType("notion_client")
_nc_stub.Client = MagicMock()
sys.modules.setdefault("notion_client", _nc_stub)

from drivers.notion.client import NotionClientWrapper


def _make_client(api_key: str = "ntn_validkey123") -> NotionClientWrapper:
    """Build a NotionClientWrapper with the Notion SDK client mocked out."""
    with patch("drivers.notion.client.Client"):
        return NotionClientWrapper(api_key=api_key)


# ──────────────────────────────────────────────────────────────────────────────
# __init__ — API key validation
# ──────────────────────────────────────────────────────────────────────────────

class TestNotionClientWrapperInit:
    def test_raises_when_no_api_key_and_no_env(self):
        with patch("drivers.notion.client.Client"):
            with patch.dict("os.environ", {}, clear=True):
                with pytest.raises(ValueError, match="NOTION_API_KEY"):
                    NotionClientWrapper(api_key=None)

    def test_raises_for_placeholder_key(self):
        with patch("drivers.notion.client.Client"):
            with pytest.raises(ValueError):
                NotionClientWrapper(api_key="your_api_key_here")

    def test_raises_for_empty_string(self):
        with patch("drivers.notion.client.Client"):
            with pytest.raises(ValueError):
                NotionClientWrapper(api_key="")

    def test_raises_for_invalid_prefix(self):
        with patch("drivers.notion.client.Client"):
            with pytest.raises(ValueError, match="invalid"):
                NotionClientWrapper(api_key="invalid_prefix_key")

    def test_accepts_ntn_prefix(self):
        with patch("drivers.notion.client.Client"):
            client = NotionClientWrapper(api_key="ntn_abc123")
        assert client.api_key == "ntn_abc123"

    def test_accepts_secret_prefix(self):
        with patch("drivers.notion.client.Client"):
            client = NotionClientWrapper(api_key="secret_abc123")
        assert client.api_key == "secret_abc123"

    def test_strips_surrounding_quotes(self):
        with patch("drivers.notion.client.Client"):
            client = NotionClientWrapper(api_key='"ntn_abc123"')
        assert client.api_key == "ntn_abc123"

    def test_strips_surrounding_whitespace(self):
        with patch("drivers.notion.client.Client"):
            client = NotionClientWrapper(api_key="  ntn_abc123  ")
        assert client.api_key == "ntn_abc123"

    def test_initial_request_count_is_zero(self):
        client = _make_client()
        assert client.stats["total_requests"] == 0


# ──────────────────────────────────────────────────────────────────────────────
# get_page_title
# ──────────────────────────────────────────────────────────────────────────────

class TestGetPageTitle:
    def _page(self, parts: list[str]) -> dict:
        rich_text = [{"plain_text": p} for p in parts]
        return {"properties": {"Title": {"type": "title", "title": rich_text}}}

    def test_extracts_single_text_part(self):
        client = _make_client()
        page = self._page(["Chapter One"])
        assert client.get_page_title(page) == "Chapter One"

    def test_joins_multiple_parts(self):
        client = _make_client()
        page = self._page(["Hello", " ", "World"])
        assert client.get_page_title(page) == "Hello World"

    def test_returns_empty_on_no_title_property(self):
        client = _make_client()
        page = {"properties": {"Name": {"type": "rich_text", "rich_text": []}}}
        assert client.get_page_title(page) == ""

    def test_returns_empty_on_missing_properties(self):
        client = _make_client()
        assert client.get_page_title({}) == ""

    def test_returns_empty_for_empty_title_array(self):
        client = _make_client()
        page = {"properties": {"Title": {"type": "title", "title": []}}}
        assert client.get_page_title(page) == ""


# ──────────────────────────────────────────────────────────────────────────────
# get_child_pages — filters to child_page type only
# ──────────────────────────────────────────────────────────────────────────────

class TestGetChildPages:
    def test_returns_only_child_page_blocks(self):
        client = _make_client()
        blocks = [
            {"id": "cp1", "type": "child_page", "child_page": {"title": "Chapter 1"}},
            {"id": "p1",  "type": "paragraph",  "paragraph": {}},
            {"id": "cp2", "type": "child_page", "child_page": {"title": "Chapter 2"}},
        ]
        with patch.object(client, "get_block_children", return_value=blocks):
            pages = client.get_child_pages("parent-id")
        assert len(pages) == 2
        assert pages[0]["title"] == "Chapter 1"
        assert pages[1]["title"] == "Chapter 2"

    def test_returns_empty_when_no_child_pages(self):
        client = _make_client()
        blocks = [
            {"id": "p1", "type": "paragraph", "paragraph": {}},
        ]
        with patch.object(client, "get_block_children", return_value=blocks):
            pages = client.get_child_pages("parent-id")
        assert pages == []

    def test_includes_id_in_result(self):
        client = _make_client()
        blocks = [{"id": "cp1", "type": "child_page", "child_page": {"title": "Title"}}]
        with patch.object(client, "get_block_children", return_value=blocks):
            pages = client.get_child_pages("parent-id")
        assert pages[0]["id"] == "cp1"


# ──────────────────────────────────────────────────────────────────────────────
# get_text_blocks — filters to text-type blocks only
# ──────────────────────────────────────────────────────────────────────────────

class TestGetTextBlocks:
    def test_includes_paragraph(self):
        client = _make_client()
        blocks = [
            {"id": "b1", "type": "paragraph"},
            {"id": "b2", "type": "image"},
            {"id": "b3", "type": "heading_1"},
        ]
        with patch.object(client, "get_block_children", return_value=blocks):
            text_blocks = client.get_text_blocks("page-id")
        ids = [b["id"] for b in text_blocks]
        assert "b1" in ids
        assert "b3" in ids
        assert "b2" not in ids

    def test_includes_all_list_types(self):
        client = _make_client()
        blocks = [
            {"id": "b1", "type": "bulleted_list_item"},
            {"id": "b2", "type": "numbered_list_item"},
        ]
        with patch.object(client, "get_block_children", return_value=blocks):
            result = client.get_text_blocks("page-id")
        assert len(result) == 2

    def test_excludes_non_text_types(self):
        client = _make_client()
        blocks = [
            {"id": "b1", "type": "image"},
            {"id": "b2", "type": "file"},
            {"id": "b3", "type": "child_page"},
            {"id": "b4", "type": "divider"},
        ]
        with patch.object(client, "get_block_children", return_value=blocks):
            result = client.get_text_blocks("page-id")
        assert result == []


# ──────────────────────────────────────────────────────────────────────────────
# get_block_children — pagination
# ──────────────────────────────────────────────────────────────────────────────

class TestGetBlockChildrenPagination:
    def test_returns_all_results_across_pages(self):
        client = _make_client()
        page1 = {"results": [{"id": "b1"}, {"id": "b2"}], "has_more": True, "next_cursor": "cur1"}
        page2 = {"results": [{"id": "b3"}], "has_more": False, "next_cursor": None}

        client.client.blocks.children.list.side_effect = [page1, page2]
        with patch.object(client, "_rate_limit"):
            result = client.get_block_children("block-id")
        assert [b["id"] for b in result] == ["b1", "b2", "b3"]

    def test_passes_cursor_on_second_call(self):
        client = _make_client()
        page1 = {"results": [{"id": "b1"}], "has_more": True, "next_cursor": "my-cursor"}
        page2 = {"results": [{"id": "b2"}], "has_more": False, "next_cursor": None}
        client.client.blocks.children.list.side_effect = [page1, page2]
        with patch.object(client, "_rate_limit"):
            client.get_block_children("block-id")
        second_call_kwargs = client.client.blocks.children.list.call_args_list[1][1]
        assert second_call_kwargs.get("start_cursor") == "my-cursor"

    def test_single_page_no_cursor(self):
        client = _make_client()
        page = {"results": [{"id": "b1"}], "has_more": False}
        client.client.blocks.children.list.return_value = page
        with patch.object(client, "_rate_limit"):
            result = client.get_block_children("block-id")
        assert len(result) == 1
        assert client.client.blocks.children.list.call_count == 1


# ──────────────────────────────────────────────────────────────────────────────
# stats property
# ──────────────────────────────────────────────────────────────────────────────

class TestStats:
    def test_stats_increments_per_request(self):
        client = _make_client()
        with patch("time.sleep"), patch("time.time", return_value=999.0):
            client._rate_limit()
            client._rate_limit()
        assert client.stats["total_requests"] == 2

    def test_stats_contains_total_requests_key(self):
        client = _make_client()
        assert "total_requests" in client.stats
