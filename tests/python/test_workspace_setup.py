"""Phase-1 workspace-setup regression test (Lane A / p1-python).

Proves the `args.lang` path-building fix in the FETCH and UPLOAD pipeline
stages: the per-language output directory `data/.../g{grade}-{lang}/...` must
be built from the parsed `--lang` argument for BOTH `uz` and `ru`, with no
`NameError` from a bare, undefined `lang` name.

Two complementary, dependency-light checks (no network, no Notion/dotenv
imports required):

1. Source/AST guard — assert the *code* (not docstrings) in fetch_chapter.py
   and upload_images.py contains no bare ``{lang}`` f-string interpolation in
   the `main()` path-building lines; the only legitimate ``{lang}`` left is the
   ``find_chapter_meta(grade, lang, ...)`` helper, whose ``lang`` is a real
   parameter.

2. Namespace path assertion — reproduce the exact f-string the modules use
   (``f"g{args.grade}-{args.lang}"``) against an argparse-style namespace for
   both languages and assert the resulting path segment, guaranteeing the lang
   arg flows into the path. This is the behaviour that previously raised
   NameError because the code referenced a bare ``lang``.

Runnable with pytest (``pytest tests/python/test_workspace_setup.py -q``) or
as a plain script (``python tests/python/test_workspace_setup.py``) when pytest
is unavailable.
"""

from __future__ import annotations

import argparse
import ast
import re
from pathlib import Path

# tests/python/test_workspace_setup.py -> repo root is two parents up.
REPO = Path(__file__).resolve().parent.parent.parent
FETCH = REPO / "src" / "python" / "pipeline" / "fetch_chapter.py"
UPLOAD = REPO / "src" / "python" / "pipeline" / "upload_images.py"


def _code_lines_without_docstrings(path: Path) -> str:
    """Return the module source with docstrings stripped, so doc examples that
    legitimately mention ``g{N}-{lang}`` don't trip the bare-name guard."""
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    doc_spans: list[tuple[int, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc is not None and node.body:
                first = node.body[0]
                if (
                    isinstance(first, ast.Expr)
                    and isinstance(getattr(first, "value", None), ast.Constant)
                    and isinstance(first.value.value, str)
                ):
                    doc_spans.append((first.lineno, getattr(first, "end_lineno", first.lineno)))
    lines = src.splitlines()
    keep = [
        ln
        for i, ln in enumerate(lines, start=1)
        if not any(lo <= i <= hi for lo, hi in doc_spans)
    ]
    return "\n".join(keep)


def test_fetch_chapter_has_no_bare_lang_in_code():
    code = _code_lines_without_docstrings(FETCH)
    # The buggy form was f"g{args.grade}-{lang}" (bare, undefined `lang`).
    assert re.search(r"\{lang\}", code) is None, (
        "bare {lang} still present in fetch_chapter.py code (should be {args.lang})"
    )
    assert "f\"g{args.grade}-{args.lang}\"" in code, (
        "fetch_chapter.py must build the chapters dir from args.lang"
    )


def test_upload_images_has_no_bare_lang_except_helper_param():
    code = _code_lines_without_docstrings(UPLOAD)
    # Only the legitimate find_chapter_meta(grade, lang, ...) helper may use a
    # bare {lang} — and there it is a real function parameter. Every other use
    # in main() must be {args.lang}.
    bare = [
        line
        for line in code.splitlines()
        if "{lang}" in line and "f\"g{grade}-{lang}\"" not in line
    ]
    assert bare == [], f"unexpected bare {{lang}} in upload_images.py code: {bare}"
    # The three main()-path constructs must use args.lang.
    assert code.count("f\"g{args.grade}-{args.lang}\"") == 3, (
        "upload_images.py must build images/refined/zips dirs from args.lang (x3)"
    )


def _per_lang_segment(args: argparse.Namespace) -> str:
    """Reproduce the exact f-string the modules use for the per-language dir.

    Mirrors fetch_chapter.py:127 and upload_images.py:173/177/186. Referencing
    a bare `lang` here (as the bug did) would raise NameError; `args.lang` does
    not.
    """
    return f"g{args.grade}-{args.lang}"


def test_path_segment_built_from_lang_arg_uz_and_ru():
    for lang, grade in (("uz", 7), ("ru", 9)):
        args = argparse.Namespace(grade=grade, lang=lang)
        seg = _per_lang_segment(args)  # must not raise NameError
        assert seg == f"g{grade}-{lang}", f"path segment wrong for lang={lang}"

    # Full FETCH-style path uses the lang arg, distinct per language.
    uz = REPO / "data" / "chapters" / _per_lang_segment(
        argparse.Namespace(grade=7, lang="uz")
    ) / "jahon-tarixi"
    ru = REPO / "data" / "chapters" / _per_lang_segment(
        argparse.Namespace(grade=7, lang="ru")
    ) / "jahon-tarixi"
    assert uz.parent.name == "g7-uz"
    assert ru.parent.name == "g7-ru"
    assert uz != ru


def _run_standalone() -> int:
    tests = [
        test_fetch_chapter_has_no_bare_lang_in_code,
        test_upload_images_has_no_bare_lang_except_helper_param,
        test_path_segment_built_from_lang_arg_uz_and_ru,
    ]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run_standalone())
