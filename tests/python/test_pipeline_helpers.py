"""Tests for pure helper functions in the pipeline stages.

These functions have no external I/O dependencies so they can be tested
without mocking Playwright or Notion.

Modules under test:
    - pipeline/fetch_chapter.py  : clean_chapter_title, slugify
    - pipeline/generate_prompts.py : extract_json_array, normalize_entry, stage_path
"""

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# generate_prompts.py imports playwright at module level; stub it so we can
# import the module without a full Playwright installation.
_pw_stub = types.ModuleType("playwright")
_pw_stub.sync_api = MagicMock()
sys.modules.setdefault("playwright", _pw_stub)
sys.modules.setdefault("playwright.sync_api", MagicMock())

# Also stub the chatgpt driver that generate_prompts imports
sys.modules.setdefault("drivers.browser.chatgpt", MagicMock())
sys.modules.setdefault("drivers.browser", MagicMock())

from pipeline.fetch_chapter import clean_chapter_title
from pipeline.fetch_chapter import slugify as fetch_slugify
from pipeline.generate_prompts import extract_json_array, normalize_entry, stage_path
from pipeline.generate_prompts import slugify as prompts_slugify


# ──────────────────────────────────────────────────────────────────────────────
# clean_chapter_title
# ──────────────────────────────────────────────────────────────────────────────

class TestCleanChapterTitle:
    @pytest.mark.parametrize("raw, expected", [
        ("1-mavzu. German qabilalari",   "German qabilalari"),
        ("2-3-mavzu: Franklar davlati",  "Franklar davlati"),
        ("Mavzu 7. Title",               "Title"),
        ("5-§. Tarixda yil hisobi",      "Tarixda yil hisobi"),
        ("§5. Title",                    "Title"),
        ("Глава 7. Title",               "Title"),
        ("Боб 7. Mavzu",                 "Mavzu"),
        ("Тема 7. Mavzu",                "Mavzu"),
        ("Урок 7. Mavzu",                "Mavzu"),
        ("5. Plain title",               "Plain title"),
        ("5: Colon title",               "Colon title"),
        ("5) Paren title",               "Paren title"),
        ("No prefix at all",             "No prefix at all"),
        ("  1-mavzu.  Leading spaces  ", "Leading spaces"),
    ])
    def test_strips_prefix(self, raw, expected):
        assert clean_chapter_title(raw) == expected

    def test_empty_string_returns_empty(self):
        assert clean_chapter_title("") == ""

    def test_only_prefix_returns_empty(self):
        # "1-mavzu. " stripped → empty → strip() → ""
        result = clean_chapter_title("1-mavzu. ")
        assert result == ""

    def test_does_not_strip_mid_title_numbers(self):
        # "Jahon tarixi 5-mavzu" — "5-mavzu" is NOT at start, should not be stripped
        result = clean_chapter_title("Jahon tarixi 5-mavzu")
        assert "tarixi" in result


# ──────────────────────────────────────────────────────────────────────────────
# slugify (both pipeline modules share identical logic)
# ──────────────────────────────────────────────────────────────────────────────

class TestSlugify:
    @pytest.mark.parametrize("text, expected", [
        ("German qabilalari",     "german-qabilalari"),
        ("  leading spaces  ",    "leading-spaces"),
        ("Multiple   Spaces",     "multiple-spaces"),
        ("special!@#chars",       "specialchars"),
        ("",                      "untitled"),
        ("O'zbekiston tarixi",    "ozbekiston-tarixi"),
        ("Jahon tarixi",          "jahon-tarixi"),
    ])
    def test_basic_slugify(self, text, expected):
        assert fetch_slugify(text) == expected

    def test_uzbek_latin_transliteration(self):
        result = fetch_slugify("ўқғҳ")
        assert result == "oqgh"

    def test_cyrillic_basic(self):
        result = fetch_slugify("история")
        assert result == "istoriya"

    def test_max_len_truncated(self):
        long_text = "a" * 100
        result = fetch_slugify(long_text, max_len=20)
        assert len(result) <= 20

    def test_max_len_no_trailing_dash(self):
        # If truncation falls on a dash, it should be stripped
        result = fetch_slugify("word1 word2 word3", max_len=6)
        assert not result.endswith("-")

    def test_both_modules_same_output(self):
        text = "Jahon tarixi"
        assert fetch_slugify(text) == prompts_slugify(text)


# ──────────────────────────────────────────────────────────────────────────────
# extract_json_array
# ──────────────────────────────────────────────────────────────────────────────

class TestExtractJsonArray:
    def test_plain_json_array(self):
        text = '[{"idx": 1, "slug": "s", "image_prompt": "p", "motion_script": null}]'
        result = extract_json_array(text)
        assert isinstance(result, list)
        assert result[0]["idx"] == 1

    def test_fenced_json_block(self):
        text = '```json\n[{"idx": 1, "slug": "s", "image_prompt": "p", "motion_script": null}]\n```'
        result = extract_json_array(text)
        assert result[0]["slug"] == "s"

    def test_fenced_no_lang_label(self):
        text = '```\n[{"idx": 1, "slug": "s", "image_prompt": "p", "motion_script": null}]\n```'
        result = extract_json_array(text)
        assert len(result) == 1

    def test_array_buried_in_prose(self):
        text = 'Here is the output:\n[{"idx": 1, "slug": "s", "image_prompt": "p", "motion_script": null}]\nThank you!'
        result = extract_json_array(text)
        assert result[0]["idx"] == 1

    def test_raises_on_plain_prose(self):
        with pytest.raises(ValueError, match="Could not extract"):
            extract_json_array("This is just a paragraph of text with no JSON.")

    def test_raises_on_empty_string(self):
        with pytest.raises(ValueError):
            extract_json_array("")

    def test_multi_entry_array(self):
        entries = [{"idx": i, "slug": f"s{i}", "image_prompt": f"p{i}", "motion_script": None} for i in range(1, 21)]
        text = json.dumps(entries)
        result = extract_json_array(text)
        assert len(result) == 20

    def test_single_entry_returns_list(self):
        text = '[{"idx": 1, "slug": "s", "image_prompt": "p", "motion_script": null}]'
        result = extract_json_array(text)
        assert isinstance(result, list)

    def test_raises_on_json_object_not_array(self):
        with pytest.raises(ValueError):
            extract_json_array('{"idx": 1}')


# ──────────────────────────────────────────────────────────────────────────────
# normalize_entry
# ──────────────────────────────────────────────────────────────────────────────

class TestNormalizeEntry:
    def _valid(self, **overrides):
        base = {"idx": 1, "slug": "test-slug", "image_prompt": "A great prompt", "motion_script": None}
        base.update(overrides)
        return base

    def test_passthrough_valid_entry(self):
        raw = self._valid()
        result = normalize_entry(raw, expected_idx=1)
        assert result["idx"] == 1
        assert result["image_prompt"] == "A great prompt"

    def test_idx_replaced_with_expected(self):
        raw = self._valid(idx=99)
        result = normalize_entry(raw, expected_idx=5)
        assert result["idx"] == 5

    def test_missing_slug_auto_generated(self):
        raw = self._valid(slug="")
        result = normalize_entry(raw, expected_idx=1)
        assert result["slug"]  # not empty
        assert result["slug"] != ""

    def test_missing_image_prompt_raises(self):
        raw = self._valid(image_prompt="")
        with pytest.raises(ValueError, match="missing image_prompt"):
            normalize_entry(raw, expected_idx=1)

    def test_prompt_field_alias(self):
        # Some models return "prompt" instead of "image_prompt"
        raw = {"idx": 1, "slug": "s", "prompt": "A prompt", "motion_script": None}
        result = normalize_entry(raw, expected_idx=1)
        assert result["image_prompt"] == "A prompt"

    def test_motion_script_none_preserved(self):
        raw = self._valid(motion_script=None)
        result = normalize_entry(raw, expected_idx=1)
        assert result["motion_script"] is None

    def test_motion_script_string_null_becomes_none(self):
        for val in ("null", "none", "n/a", "NULL"):
            raw = self._valid(motion_script=val)
            result = normalize_entry(raw, expected_idx=1)
            assert result["motion_script"] is None, f"Expected None for motion_script={val!r}"

    def test_motion_script_real_string_preserved(self):
        raw = self._valid(motion_script="drone shot slowly")
        result = normalize_entry(raw, expected_idx=1)
        assert result["motion_script"] == "drone shot slowly"

    def test_whitespace_slug_stripped(self):
        raw = self._valid(slug="  my-slug  ")
        result = normalize_entry(raw, expected_idx=1)
        assert result["slug"] == "my-slug"


# ──────────────────────────────────────────────────────────────────────────────
# stage_path
# ──────────────────────────────────────────────────────────────────────────────

class TestStagePath:
    def test_refined_to_prompts(self, tmp_path):
        # Build a fake refined path structure
        p = tmp_path / "refined" / "g7-uz" / "jahon-tarixi" / "ch01-test.md"
        result = stage_path(p, "prompts")
        assert "prompts" in result.parts
        assert "refined" not in result.parts
        assert result.name == "ch01-test.md"

    def test_refined_to_images(self, tmp_path):
        p = tmp_path / "refined" / "g7-uz" / "subject" / "ch02-x.md"
        result = stage_path(p, "images")
        assert "images" in result.parts

    def test_raises_if_no_refined_segment(self, tmp_path):
        p = tmp_path / "chapters" / "g7-uz" / "subject" / "ch01-x.md"
        with pytest.raises(SystemExit, match="refined"):
            stage_path(p, "prompts")

    def test_preserves_grade_lang_and_subject(self, tmp_path):
        p = tmp_path / "refined" / "g8-ru" / "algebra" / "ch03-equations.md"
        result = stage_path(p, "prompts")
        assert "g8-ru" in result.parts
        assert "algebra" in result.parts
        assert result.name == "ch03-equations.md"
