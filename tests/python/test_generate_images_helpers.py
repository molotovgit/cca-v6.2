"""Tests for pure helper functions in src/python/pipeline/generate_images_gemini.py.

Targets functions with no browser/Playwright dependency:
    - slugify: ASCII-only, no Uzbek/Cyrillic transliteration (simpler than fetch/refine)
    - resolve_prompts_file: filesystem glob by (grade, lang, subject, chapter)

Note: generate_images_gemini.slugify only strips non-alphanum — it does NOT
transliterate Cyrillic. This is intentional (prompts come from the already-
slugified English prompt text).
"""

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub Playwright and Gemini browser driver so the module can be imported.
sys.modules.setdefault("playwright", types.ModuleType("playwright"))
sys.modules.setdefault("playwright.sync_api", MagicMock())
sys.modules.setdefault("drivers.browser.gemini", MagicMock())
sys.modules.setdefault("drivers.browser", MagicMock())

from pipeline.generate_images_gemini import slugify, resolve_prompts_file


# ──────────────────────────────────────────────────────────────────────────────
# slugify — ASCII-only, no transliteration
# ──────────────────────────────────────────────────────────────────────────────

class TestSlugify:
    @pytest.mark.parametrize("text, expected", [
        ("Jahon tarixi",     "jahon-tarixi"),
        ("",                 "untitled"),
        ("  spaces  ",       "spaces"),
        ("Multiple   Spaces","multiple-spaces"),
        ("special!@#chars",  "specialchars"),
    ])
    def test_basic(self, text, expected):
        assert slugify(text) == expected

    def test_apostrophe_stripped(self):
        # Apostrophe and backtick should be removed, not turned into dashes
        result = slugify("it's alive")
        assert "'" not in result
        assert result  # non-empty

    def test_backtick_stripped(self):
        result = slugify("`quoted`")
        assert "`" not in result

    def test_max_len_honored(self):
        result = slugify("a" * 100, max_len=20)
        assert len(result) <= 20

    def test_no_trailing_dash_after_truncation(self):
        result = slugify("word1 word2 word3", max_len=6)
        assert not result.endswith("-")

    def test_no_leading_dash(self):
        result = slugify("-leading dash")
        assert not result.startswith("-")

    def test_returns_untitled_for_only_special_chars(self):
        result = slugify("!@#$%^&*()")
        assert result == "untitled"

    def test_hyphens_normalized(self):
        # Multiple consecutive hyphens become one
        result = slugify("a---b")
        assert result == "a-b"

    def test_does_not_transliterate_cyrillic(self):
        # Unlike fetch/refine slugify, this one just strips Cyrillic
        result = slugify("история мира")
        # Cyrillic stripped, only whitespace/dash remain → "untitled"
        assert result == "untitled"

    def test_numbers_preserved(self):
        result = slugify("chapter 3 part 2")
        assert "3" in result
        assert "2" in result

    def test_default_max_len_is_60(self):
        long = "a" * 70
        result = slugify(long)
        assert len(result) <= 60


# ──────────────────────────────────────────────────────────────────────────────
# resolve_prompts_file — filesystem glob with SystemExit on miss
# ──────────────────────────────────────────────────────────────────────────────

class TestResolvePromptsFile:
    def _make_prompts(self, tmp_path: Path, grade: int, lang: str,
                      subject_slug: str, chapter: int) -> Path:
        folder = tmp_path / "data" / "prompts" / f"g{grade}-{lang}" / subject_slug
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / f"ch{chapter:02d}-scene-prompts.json"
        prompts = [
            {"idx": 1, "slug": "opening", "image_prompt": "Wide shot of a village", "motion_script": None},
        ]
        p.write_text(json.dumps(prompts), encoding="utf-8")
        return p

    def test_finds_existing_prompts_file(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        self._make_prompts(tmp_path, 7, "uz", "jahon-tarixi", 1)
        result = gig.resolve_prompts_file(7, "uz", "jahon tarixi", 1)
        assert result.exists()
        assert result.name.startswith("ch01-")
        assert result.suffix == ".json"

    def test_exits_when_folder_missing(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        with pytest.raises(SystemExit, match="No prompts file"):
            gig.resolve_prompts_file(7, "uz", "nonexistent subject", 1)

    def test_exits_when_chapter_file_missing(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        folder = tmp_path / "data" / "prompts" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        with pytest.raises(SystemExit):
            gig.resolve_prompts_file(7, "uz", "jahon tarixi", 5)

    def test_returns_first_match_when_multiple(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        folder = tmp_path / "data" / "prompts" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "ch01-aaa.json").write_text("[]", encoding="utf-8")
        (folder / "ch01-zzz.json").write_text("[]", encoding="utf-8")
        result = gig.resolve_prompts_file(7, "uz", "jahon tarixi", 1)
        # sorted() → first alphabetically
        assert result.name == "ch01-aaa.json"

    def test_subject_slugified_for_folder_lookup(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        self._make_prompts(tmp_path, 7, "uz", "jahon-tarixi", 1)
        # Pass human-readable subject name with spaces
        result = gig.resolve_prompts_file(7, "uz", "Jahon tarixi", 1)
        assert result.exists()

    def test_chapter_zero_padded_in_glob(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        self._make_prompts(tmp_path, 7, "uz", "jahon-tarixi", 9)
        result = gig.resolve_prompts_file(7, "uz", "jahon tarixi", 9)
        assert result.name.startswith("ch09-")

    def test_grade_and_lang_in_path(self, tmp_path, monkeypatch):
        import pipeline.generate_images_gemini as gig
        monkeypatch.setattr(gig, "REPO", tmp_path)
        self._make_prompts(tmp_path, 8, "ru", "algebra", 2)
        result = gig.resolve_prompts_file(8, "ru", "algebra", 2)
        assert "g8-ru" in result.parts
        assert "algebra" in result.parts


# ──────────────────────────────────────────────────────────────────────────────
# Edge cases: refine_chapter vs generate_images_gemini slugify divergence
# ──────────────────────────────────────────────────────────────────────────────

class TestSlugifyDivergenceFromFetchChapter:
    """generate_images_gemini.slugify intentionally skips Cyrillic transliteration.
    These tests document and protect that behavioral difference.
    """

    def test_cyrillic_stripped_not_transliterated(self):
        from pipeline.generate_images_gemini import slugify as gen_slugify
        result = gen_slugify("история")
        # Cyrillic chars have no mapping → stripped → empty → "untitled"
        assert result == "untitled"

    def test_ascii_prompt_slug_preserved(self):
        from pipeline.generate_images_gemini import slugify as gen_slugify
        result = gen_slugify("wide shot of ancient rome at dawn")
        assert "wide" in result
        assert "rome" in result
        assert "dawn" in result
