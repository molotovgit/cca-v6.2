"""Tests for pure helper functions in src/python/pipeline/refine_chapter.py.

Targets the testable helpers (no browser/Playwright dependency):
    - slugify: Uzbek/Cyrillic transliteration and slug generation
    - resolve_chapter_file: filesystem lookup by (grade, lang, subject, chapter)
    - stage_path: 'chapters' anchor replacement — distinct from generate_prompts.stage_path
"""

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub browser imports so refine_chapter can be imported without Playwright.
sys.modules.setdefault("playwright", types.ModuleType("playwright"))
sys.modules.setdefault("playwright.sync_api", MagicMock())
sys.modules.setdefault("drivers.browser.chatgpt", MagicMock())
sys.modules.setdefault("drivers.browser", MagicMock())

from pipeline.refine_chapter import slugify, resolve_chapter_file, stage_path


# ──────────────────────────────────────────────────────────────────────────────
# slugify — Uzbek/Cyrillic-aware, same transliteration table as fetch_chapter
# ──────────────────────────────────────────────────────────────────────────────

class TestSlugify:
    @pytest.mark.parametrize("text, expected", [
        ("Jahon tarixi",         "jahon-tarixi"),
        ("",                     "untitled"),
        ("  spaces  ",           "spaces"),
        ("Multiple   Spaces",    "multiple-spaces"),
        ("special!@#chars",      "specialchars"),
        ("O'zbekiston tarixi",   "ozbekiston-tarixi"),
    ])
    def test_basic(self, text, expected):
        assert slugify(text) == expected

    def test_uzbek_cyrillic_transliteration(self):
        # ў→o, қ→q, ғ→g, ҳ→h
        assert slugify("ўқғҳ") == "oqgh"

    def test_russian_cyrillic_transliteration(self):
        # и→i с→s т→t о→o р→r и→i я→ya → "istoriya"
        result = slugify("история")
        assert result == "istoriya"

    def test_uzbek_digraphs(self):
        # ш→sh, ч→ch, ц→ts, ж→j, й→y (no spaces → no dashes)
        result = slugify("шчцжй")
        assert result == "shchtsjy"

    def test_max_len_truncated(self):
        result = slugify("a" * 100, max_len=20)
        assert len(result) <= 20

    def test_no_trailing_dash_after_truncation(self):
        result = slugify("word1 word2 word3", max_len=6)
        assert not result.endswith("-")

    def test_soft_signs_removed(self):
        # ъ, ь, ʼ, ' should all disappear
        result = slugify("maʼno")
        assert "'" not in result
        assert result  # not empty

    def test_returns_untitled_for_whitespace_only(self):
        assert slugify("   ") == "untitled"

    def test_max_len_applied_before_trailing_dash_strip(self):
        # Ensure no off-by-one leaves a trailing dash
        result = slugify("ab cd ef gh", max_len=5)
        assert not result.endswith("-")
        assert len(result) <= 5


# ──────────────────────────────────────────────────────────────────────────────
# resolve_chapter_file — filesystem glob with SystemExit on miss
# ──────────────────────────────────────────────────────────────────────────────

class TestResolveChapterFile:
    def _make_chapter(self, tmp_path: Path, grade: int, lang: str,
                      subject_slug: str, chapter: int, suffix: str = "") -> Path:
        folder = tmp_path / "data" / "chapters" / f"g{grade}-{lang}" / subject_slug
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / f"ch{chapter:02d}-some-title{suffix}.md"
        p.write_text("chapter content", encoding="utf-8")
        return p

    def test_finds_existing_chapter(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        self._make_chapter(tmp_path, 7, "uz", "jahon-tarixi", 1)
        result = rc.resolve_chapter_file(7, "uz", "jahon tarixi", 1)
        assert result.exists()
        assert result.name.startswith("ch01-")
        assert not result.name.endswith(".refined.md")

    def test_exits_when_folder_missing(self, tmp_path, monkeypatch):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        with pytest.raises(SystemExit, match="run fetch_chapter"):
            rc.resolve_chapter_file(7, "uz", "nonexistent subject", 1)

    def test_exits_when_no_matching_chapter(self, tmp_path, monkeypatch):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        folder = tmp_path / "data" / "chapters" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        with pytest.raises(SystemExit):
            rc.resolve_chapter_file(7, "uz", "jahon tarixi", 3)

    def test_skips_refined_md_files(self, tmp_path, monkeypatch):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        folder = tmp_path / "data" / "chapters" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        # Only the .refined.md exists — should not be found
        (folder / "ch01-title.refined.md").write_text("refined", encoding="utf-8")
        with pytest.raises(SystemExit):
            rc.resolve_chapter_file(7, "uz", "jahon tarixi", 1)

    def test_warns_and_uses_first_on_multiple_matches(self, tmp_path, monkeypatch, capsys):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        folder = tmp_path / "data" / "chapters" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "ch01-title-a.md").write_text("a", encoding="utf-8")
        (folder / "ch01-title-b.md").write_text("b", encoding="utf-8")
        result = rc.resolve_chapter_file(7, "uz", "jahon tarixi", 1)
        captured = capsys.readouterr()
        assert "[warn]" in captured.out
        assert result.exists()

    def test_chapter_zero_padded(self, tmp_path, monkeypatch):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        self._make_chapter(tmp_path, 7, "uz", "jahon-tarixi", 9)
        result = rc.resolve_chapter_file(7, "uz", "jahon tarixi", 9)
        assert result.name.startswith("ch09-")

    def test_subject_slugified_for_folder_lookup(self, tmp_path, monkeypatch):
        import pipeline.refine_chapter as rc
        monkeypatch.setattr(rc, "REPO", tmp_path)
        # Subject with spaces → folder is slugified
        folder = tmp_path / "data" / "chapters" / "g7-uz" / "jahon-tarixi"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "ch01-title.md").write_text("x", encoding="utf-8")
        # Pass the non-slugified subject name
        result = rc.resolve_chapter_file(7, "uz", "Jahon tarixi", 1)
        assert result.exists()


# ──────────────────────────────────────────────────────────────────────────────
# stage_path — 'chapters' anchor replacement (NOT 'refined' like generate_prompts)
# ──────────────────────────────────────────────────────────────────────────────

class TestStagePath:
    def test_chapters_replaced_with_refined(self, tmp_path):
        p = tmp_path / "chapters" / "g7-uz" / "jahon-tarixi" / "ch01-test.md"
        result = stage_path(p, "refined")
        assert "refined" in result.parts
        assert "chapters" not in result.parts
        assert result.name == "ch01-test.md"

    def test_chapters_replaced_with_arbitrary_stage(self, tmp_path):
        p = tmp_path / "chapters" / "g8-ru" / "algebra" / "ch03-x.md"
        result = stage_path(p, "prompts")
        assert "prompts" in result.parts
        assert result.name == "ch03-x.md"

    def test_preserves_grade_lang_and_subject_subpath(self, tmp_path):
        p = tmp_path / "chapters" / "g9-uz" / "fizika" / "ch05-dynamics.md"
        result = stage_path(p, "refined")
        assert "g9-uz" in result.parts
        assert "fizika" in result.parts
        assert result.name == "ch05-dynamics.md"

    def test_exits_when_no_chapters_segment(self, tmp_path):
        # If input doesn't contain 'chapters/', stage_path should raise SystemExit
        p = tmp_path / "data" / "refined" / "g7-uz" / "ch01-x.md"
        with pytest.raises(SystemExit, match="chapters"):
            stage_path(p, "refined")

    def test_only_first_chapters_segment_replaced(self, tmp_path):
        # Paths containing multiple 'chapters' occurrences — replace the first one
        p = tmp_path / "chapters" / "g7-uz" / "chapters-backup" / "ch01.md"
        result = stage_path(p, "refined")
        # The segment at the 'chapters' index is replaced; deeper segments unchanged
        assert result.parts.count("chapters") < p.resolve().parts.count("chapters")
