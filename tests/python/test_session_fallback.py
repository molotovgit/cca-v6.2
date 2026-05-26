"""Phase-3 browser-session-init + fallback DECISION-logic tests (Lane C / rp3-tests).

Covers the PURE seams of the auto-login resilience layer — the parts that decide
*what to do* without ever touching a real browser/CDP/Playwright session:

  * ``auth.auto_login._resolve_credentials`` — the credential source-of-truth
    tree: accounts.json (preferred, rotation-aware) → ``--*-account-index``
    override → out-of-range override exits 2 → ``.env`` legacy fallback →
    both-absent → None. Provider-specific mixing (ChatGPT from accounts.json,
    Gemini from .env) is also exercised.
  * ``auth.auto_login._classify_error`` — the RuntimeError-message → exit-code
    classifier (1 human-blocker, 2 wrong-creds, 3 transient/unknown), including
    the "verify" boundary and the None/empty case.
  * ``auth.accounts`` rotation state machine — ``rotate`` advances + persists,
    ``rotate(wrap=True)`` cycles, exhaustion raises ``NoMoreAccountsError``,
    ``get_active`` self-heals a stale index past the list end, and ``reset``
    returns to index 0.

The actual browser-touching functions (``login_chatgpt`` / ``login_gemini`` /
``_force_signout_*`` / ``find_signed_in_gemini``) need a live CDP/Playwright
session and are OUT OF SCOPE here (integration-only).

Self-contained: this file defines its own tmp-repo + accounts-writer helpers and
does NOT depend on a conftest fixture being present. Heavy deps (dotenv,
playwright, drivers.browser.*) are stubbed before importing ``auto_login`` so the
module imports with no real browser/network.

Runnable two ways:
  * pytest:     ``python3 -m pytest tests/python/test_session_fallback.py -q``
  * standalone: ``python3 tests/python/test_session_fallback.py``  (prints
                PASS/FAIL per test; process exit code is 0 iff all green).
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

# ── Convention (from the existing suite): repo root is two parents up; put
#    src/python on the path so ``from auth.auto_login import ...`` resolves. ──
REPO = Path(__file__).resolve().parents[2]
SRC_PYTHON = REPO / "src" / "python"
if str(SRC_PYTHON) not in sys.path:
    sys.path.insert(0, str(SRC_PYTHON))

# ── Stub heavy deps BEFORE importing auto_login so the module imports without a
#    real browser / dotenv / playwright. auto_login does, at module scope:
#        from dotenv import load_dotenv
#        from drivers.browser import chatgpt as cg
#        from drivers.browser import gemini as gm
#        from playwright.sync_api import sync_playwright
#    None of those are installed in this environment (and none are needed for the
#    pure helpers under test), so we replace them with MagicMocks. ──
for _name in (
    "dotenv",
    "playwright",
    "playwright.sync_api",
    "drivers",
    "drivers.browser",
    "drivers.browser.chatgpt",
    "drivers.browser.gemini",
):
    sys.modules.setdefault(_name, MagicMock())

# ``auth.accounts`` is the REAL module under test (no browser deps) — import it
# directly, and import ``auto_login`` (now that its heavy deps are stubbed).
from auth import accounts as acct  # noqa: E402
from auth import auto_login as al  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
#  Self-contained helpers: build a throwaway repo with data/accounts.json.
# ─────────────────────────────────────────────────────────────────────────────
def _make_repo(tmp_root: Path, *, chatgpt=None, gemini=None) -> Path:
    """Create a fake repo at ``tmp_root`` with ``data/accounts.json`` populated
    from the given per-provider account lists. Each entry may be a full dict
    ({label,email,password}) or a (label, email, password) tuple."""
    data_dir = tmp_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    def _norm(lst):
        out = []
        for a in lst or []:
            if isinstance(a, dict):
                out.append(a)
            else:
                label, email, password = a
                out.append({"label": label, "email": email, "password": password})
        return out

    payload = {"chatgpt": _norm(chatgpt), "gemini": _norm(gemini)}
    (data_dir / "accounts.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return tmp_root


def _make_args(**overrides) -> SimpleNamespace:
    """Build an argparse-like namespace matching what ``main()`` passes to
    ``_resolve_credentials``. Only the ``*_account_index`` attrs are read."""
    base = {"chatgpt_account_index": None, "gemini_account_index": None}
    base.update(overrides)
    return SimpleNamespace(**base)


class _PatchRepo:
    """Context manager: point ``auth.auto_login.REPO`` at a tmp repo (so the
    credential resolver reads our fake accounts.json) and restore it after."""

    def __init__(self, repo: Path):
        self.repo = repo
        self._orig = None

    def __enter__(self):
        self._orig = al.REPO
        al.REPO = self.repo
        return self

    def __exit__(self, *exc):
        al.REPO = self._orig
        return False


class _PatchEnv:
    """Context manager: set/clear the legacy ``.env`` credential vars in
    ``os.environ`` (auto_login reads them via ``os.getenv``) and restore."""

    KEYS = ("CHATGPT_EMAIL", "CHATGPT_PASSWORD", "GEMINI_EMAIL", "GEMINI_PASSWORD")

    def __init__(self, **values):
        self.values = values
        self._saved = {}

    def __enter__(self):
        for k in self.KEYS:
            self._saved[k] = os.environ.get(k)
        # Clear all four first so a test never leaks a value from the real env.
        for k in self.KEYS:
            os.environ.pop(k, None)
        for k, v in self.values.items():
            if v is not None:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  _resolve_credentials — credential source-of-truth tree.
# ─────────────────────────────────────────────────────────────────────────────
def test_resolve_credentials_accounts_json_picks_active(tmp_repo_factory):
    """accounts.json present → active account (index 0 by default) per provider,
    carrying label/email through. State file absent ⇒ index 0."""
    repo = tmp_repo_factory(
        chatgpt=[("cg-primary", "cg0@x.com", "cgpw0"), ("cg-backup", "cg1@x.com", "cgpw1")],
        gemini=[("gm-primary", "gm0@x.com", "gmpw0")],
    )
    with _PatchRepo(repo), _PatchEnv():
        creds = al._resolve_credentials(_make_args())
    assert creds["chatgpt"]["email"] == "cg0@x.com"
    assert creds["chatgpt"]["label"] == "cg-primary"
    assert creds["chatgpt"]["index"] == 0
    assert creds["chatgpt"]["password"] == "cgpw0"
    assert creds["gemini"]["email"] == "gm0@x.com"
    assert creds["gemini"]["label"] == "gm-primary"
    assert creds["gemini"]["index"] == 0


def test_resolve_credentials_index_override_picks_that_index(tmp_repo_factory):
    """``--chatgpt-account-index`` override selects that index without touching
    persisted state; the other provider stays on its default active index."""
    repo = tmp_repo_factory(
        chatgpt=[("cg0", "cg0@x.com", "p0"), ("cg1", "cg1@x.com", "p1"), ("cg2", "cg2@x.com", "p2")],
        gemini=[("gm0", "gm0@x.com", "g0"), ("gm1", "gm1@x.com", "g1")],
    )
    with _PatchRepo(repo), _PatchEnv():
        creds = al._resolve_credentials(_make_args(chatgpt_account_index=2))
    assert creds["chatgpt"]["index"] == 2
    assert creds["chatgpt"]["email"] == "cg2@x.com"
    assert creds["chatgpt"]["label"] == "cg2"
    # Gemini had no override → default active index 0.
    assert creds["gemini"]["index"] == 0
    assert creds["gemini"]["email"] == "gm0@x.com"


def test_resolve_credentials_override_out_of_range_exits_2(tmp_repo_factory):
    """An out-of-range override surfaces as IndexError inside get_active, which
    _resolve_credentials converts to ``sys.exit(2)`` (documented wrong-creds /
    config-error code)."""
    repo = tmp_repo_factory(chatgpt=[("cg0", "cg0@x.com", "p0")], gemini=[("gm0", "gm0@x.com", "g0")])
    with _PatchRepo(repo), _PatchEnv():
        try:
            al._resolve_credentials(_make_args(chatgpt_account_index=5))
        except SystemExit as e:
            assert e.code == 2, f"expected exit code 2 for out-of-range index, got {e.code}"
        else:
            raise AssertionError("out-of-range override should have called sys.exit(2)")


def test_resolve_credentials_env_fallback_when_accounts_absent():
    """accounts.json ABSENT (resolver hits AccountsFileMissingError) + .env vars
    set → legacy fallback with label '(.env)' and index 0 for both providers."""
    # Use a tmp dir with NO data/accounts.json so get_active raises
    # AccountsFileMissingError, triggering the .env branch.
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        empty_repo = Path(td)
        with _PatchRepo(empty_repo), _PatchEnv(
            CHATGPT_EMAIL="env-cg@x.com",
            CHATGPT_PASSWORD="env-cg-pw",
            GEMINI_EMAIL="env-gm@x.com",
            GEMINI_PASSWORD="env-gm-pw",
        ):
            creds = al._resolve_credentials(_make_args())
    assert creds["chatgpt"]["email"] == "env-cg@x.com"
    assert creds["chatgpt"]["label"] == "(.env)"
    assert creds["chatgpt"]["index"] == 0
    assert creds["gemini"]["email"] == "env-gm@x.com"
    assert creds["gemini"]["label"] == "(.env)"


def test_resolve_credentials_env_strips_quotes_and_whitespace():
    """.env values are stripped of surrounding whitespace and matching quotes
    (the resolver does ``.strip().strip('\"').strip(\"'\")``)."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        with _PatchRepo(Path(td)), _PatchEnv(
            CHATGPT_EMAIL='  "quoted-cg@x.com"  ',
            CHATGPT_PASSWORD="'pw-with-quotes'",
        ):
            creds = al._resolve_credentials(_make_args())
    assert creds["chatgpt"]["email"] == "quoted-cg@x.com"
    assert creds["chatgpt"]["password"] == "pw-with-quotes"


def test_resolve_credentials_both_absent_returns_none():
    """accounts.json absent + no .env creds → both providers resolve to None."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        with _PatchRepo(Path(td)), _PatchEnv():  # _PatchEnv() clears all four vars
            creds = al._resolve_credentials(_make_args())
    assert creds["chatgpt"] is None
    assert creds["gemini"] is None


def test_resolve_credentials_provider_specific_mix():
    """Provider-specific resolution: when accounts.json is absent, only the
    provider(s) with .env creds resolve — ChatGPT-only here, Gemini stays None.
    (This is the closest the resolver gets to mixing sources: accounts.json is
    all-or-nothing per the AccountsFileMissingError branch, but within the .env
    fallback each provider is independent.)"""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        with _PatchRepo(Path(td)), _PatchEnv(
            CHATGPT_EMAIL="only-cg@x.com",
            CHATGPT_PASSWORD="only-cg-pw",
            # GEMINI_* deliberately unset
        ):
            creds = al._resolve_credentials(_make_args())
    assert creds["chatgpt"] is not None
    assert creds["chatgpt"]["email"] == "only-cg@x.com"
    assert creds["gemini"] is None


def test_resolve_credentials_env_requires_both_email_and_password():
    """.env fallback only populates a provider when BOTH email AND password are
    present — email alone (no password) leaves the provider as None."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        with _PatchRepo(Path(td)), _PatchEnv(
            GEMINI_EMAIL="gm@x.com",  # password missing
        ):
            creds = al._resolve_credentials(_make_args())
    assert creds["gemini"] is None
    assert creds["chatgpt"] is None


# ─────────────────────────────────────────────────────────────────────────────
#  _classify_error — RuntimeError message → exit code.
#  Codes asserted against the ACTUAL mapping in auto_login.py:
#    1 human-blocker / 2 wrong-creds / 3 transient/unknown (incl. None/empty).
# ─────────────────────────────────────────────────────────────────────────────
def test_classify_error_human_blocker_phrases():
    for msg in [
        "Verify it's you",
        "verify it is you to continue",
        "Couldn't sign you in",
        "This browser may not be secure",
        "browser or app may not be secure",
        "Enter your 2FA code",
        "2-Step Verification required",
        "two-step verification",
        "Enter the verification code we sent",
    ]:
        assert al._classify_error(msg) == 1, f"expected human-blocker (1) for: {msg!r}"


def test_classify_error_wrong_credentials_phrases():
    for msg in [
        "Wrong password. Try again.",
        "incorrect password",
        "Google rejected the password",
    ]:
        assert al._classify_error(msg) == 2, f"expected wrong-creds (2) for: {msg!r}"


def test_classify_error_transient_and_unknown():
    for msg in [
        "Connection timeout after 30s",
        "net::ERR_CONNECTION_REFUSED",
        "Navigation timeout exceeded",
        "some totally unrelated runtime error",
    ]:
        assert al._classify_error(msg) == 3, f"expected transient/unknown (3) for: {msg!r}"


def test_classify_error_verify_boundary():
    """Boundary: the bare word 'verify' is NOT in any human-blocker phrase, so a
    message containing only 'verify' falls through to 3; the full phrase
    "verify it's you" matches → 1."""
    assert al._classify_error("please verify your email address") == 3
    assert al._classify_error("we need to verify it's you") == 1


def test_classify_error_none_and_empty():
    """None and empty string both classify as transient/unknown (3)."""
    assert al._classify_error(None) == 3  # type: ignore[arg-type]
    assert al._classify_error("") == 3


def test_classify_error_is_case_insensitive():
    """The classifier lowercases the message, so uppercase variants still match."""
    assert al._classify_error("WRONG PASSWORD") == 2
    assert al._classify_error("VERIFY IT'S YOU") == 1


# ─────────────────────────────────────────────────────────────────────────────
#  accounts — rotation state machine (rotate / get_active / reset).
# ─────────────────────────────────────────────────────────────────────────────
def test_rotate_advances_and_persists(tmp_repo_factory):
    """rotate() advances the active index and persists it so a subsequent
    get_active() returns the new account."""
    repo = tmp_repo_factory(
        chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1"), ("a2", "a2@x.com", "p2")],
    )
    nxt = acct.rotate("chatgpt", repo)
    assert nxt["index"] == 1
    assert nxt["email"] == "a1@x.com"
    # Persistence: a fresh get_active reflects the rotation.
    assert acct.get_active("chatgpt", repo)["index"] == 1
    # Rotate again.
    nxt2 = acct.rotate("chatgpt", repo)
    assert nxt2["index"] == 2
    assert acct.get_active("chatgpt", repo)["index"] == 2


def test_rotate_wrap_cycles_to_zero(tmp_repo_factory):
    """rotate(wrap=True) past the last account cycles back to index 0."""
    repo = tmp_repo_factory(chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1")])
    assert acct.rotate("chatgpt", repo)["index"] == 1  # 0 -> 1 (last)
    wrapped = acct.rotate("chatgpt", repo, wrap=True)   # 1 -> wrap -> 0
    assert wrapped["index"] == 0
    assert wrapped["email"] == "a0@x.com"
    assert acct.get_active("chatgpt", repo)["index"] == 0


def test_rotate_exhaustion_raises(tmp_repo_factory):
    """rotate() (wrap=False) past the last account raises NoMoreAccountsError and
    does NOT advance persisted state beyond the last index."""
    repo = tmp_repo_factory(chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1")])
    assert acct.rotate("chatgpt", repo)["index"] == 1  # now at last
    try:
        acct.rotate("chatgpt", repo)  # 1 -> would be 2 (out of range)
    except acct.NoMoreAccountsError:
        pass
    else:
        raise AssertionError("rotate past last account should raise NoMoreAccountsError")
    # State unchanged after the failed rotate.
    assert acct.get_active("chatgpt", repo)["index"] == 1


def test_get_active_self_heals_stale_index(tmp_repo_factory):
    """A persisted index past the end of the (shrunken) list is treated as stale
    and get_active falls back to index 0 instead of raising."""
    repo = tmp_repo_factory(chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1")])
    # Forcibly write a stale state pointing at index 5 (list only has 2).
    acct._set_active_index(repo, "chatgpt", 5, "ghost")
    active = acct.get_active("chatgpt", repo)
    assert active["index"] == 0, "stale index past list length should reset to 0"
    assert active["email"] == "a0@x.com"


def test_reset_returns_to_index_zero(tmp_repo_factory):
    """reset() returns index 0 and persists it (after a rotation away)."""
    repo = tmp_repo_factory(chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1"), ("a2", "a2@x.com", "p2")])
    acct.rotate("chatgpt", repo)
    acct.rotate("chatgpt", repo)
    assert acct.get_active("chatgpt", repo)["index"] == 2
    r = acct.reset("chatgpt", repo)
    assert r["index"] == 0
    assert r["email"] == "a0@x.com"
    assert acct.get_active("chatgpt", repo)["index"] == 0


def test_override_index_does_not_persist(tmp_repo_factory):
    """get_active(override_index=...) returns that account but must NOT mutate
    persisted state (the documented behaviour for --*-account-index)."""
    repo = tmp_repo_factory(chatgpt=[("a0", "a0@x.com", "p0"), ("a1", "a1@x.com", "p1"), ("a2", "a2@x.com", "p2")])
    picked = acct.get_active("chatgpt", repo, override_index=2)
    assert picked["index"] == 2
    # Persisted active index is still the default 0 (override didn't write state).
    assert acct.get_active("chatgpt", repo)["index"] == 0


# ─────────────────────────────────────────────────────────────────────────────
#  pytest fixture shim (only used when pytest is present). When running
#  standalone we inject a plain factory manually (see _run_standalone).
# ─────────────────────────────────────────────────────────────────────────────
try:
    import pytest  # type: ignore

    @pytest.fixture()
    def tmp_repo_factory(tmp_path):
        """Return a builder that writes data/accounts.json under a unique subdir
        of pytest's tmp_path, so each call gets isolated state files."""
        counter = {"n": 0}

        def _factory(**kw):
            counter["n"] += 1
            sub = tmp_path / f"repo{counter['n']}"
            sub.mkdir(parents=True, exist_ok=True)
            return _make_repo(sub, **kw)

        return _factory

except ImportError:  # pragma: no cover - exercised only when pytest is absent
    pytest = None  # type: ignore


# ─────────────────────────────────────────────────────────────────────────────
#  Standalone runner (pytest-free). Collects every top-level test_* function,
#  supplies a tmp_repo_factory where the signature asks for one, and reports
#  PASS/FAIL with a process exit code of 0 iff all pass.
# ─────────────────────────────────────────────────────────────────────────────
def _run_standalone() -> int:
    import inspect
    import tempfile

    g = globals()
    tests = [
        (name, fn)
        for name, fn in sorted(g.items())
        if name.startswith("test_") and inspect.isfunction(fn)
    ]

    passed = 0
    failed = 0
    with tempfile.TemporaryDirectory() as root_td:
        root = Path(root_td)
        counter = {"n": 0}

        def _factory(**kw):
            counter["n"] += 1
            sub = root / f"repo{counter['n']}"
            sub.mkdir(parents=True, exist_ok=True)
            return _make_repo(sub, **kw)

        for name, fn in tests:
            needs_factory = "tmp_repo_factory" in inspect.signature(fn).parameters
            try:
                if needs_factory:
                    fn(_factory)
                else:
                    fn()
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
            except SystemExit as e:
                # Some tests intentionally trigger SystemExit and assert on it
                # internally; reaching here means it escaped (a failure).
                failed += 1
                print(f"FAIL {name}: unexpected SystemExit({e.code})")
            except Exception as e:  # pragma: no cover - surfaces unexpected errors
                failed += 1
                print(f"ERROR {name}: {type(e).__name__}: {e}")
            else:
                passed += 1
                print(f"PASS {name}")

    total = passed + failed
    print(f"\n{passed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_standalone())
