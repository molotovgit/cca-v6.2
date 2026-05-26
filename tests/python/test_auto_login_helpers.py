"""Tests for pure helper functions in src/python/auth/auto_login.py.

Currently: zero coverage. Targets the two pure/mockable functions:
    - _classify_error: maps RuntimeError message strings to exit codes
    - _resolve_credentials: accounts.json vs .env fallback, edge cases

Browser-touching functions (login_chatgpt, login_gemini, _force_signout_*) are
excluded — they require a live Playwright CDP connection and have no testable
pure logic.
"""

import sys
import os
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

# Stub playwright so auto_login.py can be imported without a full Playwright install.
_pw_stub = types.ModuleType("playwright")
_pw_stub.sync_api = MagicMock()
sys.modules.setdefault("playwright", _pw_stub)
sys.modules.setdefault("playwright.sync_api", MagicMock())
sys.modules.setdefault("drivers.browser.chatgpt", MagicMock())
sys.modules.setdefault("drivers.browser.gemini", MagicMock())
sys.modules.setdefault("drivers.browser", MagicMock())

from auth.auto_login import _classify_error


# ──────────────────────────────────────────────────────────────────────────────
# _classify_error — exit code mapping
# ──────────────────────────────────────────────────────────────────────────────

class TestClassifyError:
    """Exit codes:
        1 — human verification required (CAPTCHA / 2FA / verify-it's-you)
        2 — wrong credentials
        3 — transient / unknown
    """

    # ── code 1: human-required blocker ──

    @pytest.mark.parametrize("msg", [
        "verify it's you",
        "Verify it's you",
        "VERIFY IT'S YOU",
        "verify it is you",
        "couldn't sign you in",
        "browser may not be secure",
        "Browser or app may not be secure",
        "2fa required",
        "2-step verification",
        "two-step verification",
        "verification code needed",
    ])
    def test_human_blocker_returns_1(self, msg):
        assert _classify_error(msg) == 1, f"Expected code 1 for: {msg!r}"

    # ── code 2: wrong credentials ──

    @pytest.mark.parametrize("msg", [
        "wrong password",
        "Wrong Password",
        "incorrect password",
        "rejected the password",
    ])
    def test_wrong_credentials_returns_2(self, msg):
        assert _classify_error(msg) == 2, f"Expected code 2 for: {msg!r}"

    # ── code 3: transient / unknown ──

    @pytest.mark.parametrize("msg", [
        "",
        "connection refused",
        "timeout",
        "unexpected error occurred",
        "some completely unrelated message",
        None,
    ])
    def test_transient_or_unknown_returns_3(self, msg):
        assert _classify_error(msg) == 3, f"Expected code 3 for: {msg!r}"

    def test_2fa_keyword_case_insensitive(self):
        assert _classify_error("2FA REQUIRED") == 1

    def test_message_with_extra_context_still_matches(self):
        # Real RuntimeError messages have surrounding context
        msg = "Auto-login failed: couldn't sign you in. Please try again."
        assert _classify_error(msg) == 1


# ──────────────────────────────────────────────────────────────────────────────
# _resolve_credentials — accounts.json vs .env fallback
# (imported at function level to avoid module-level side-effects)
# ──────────────────────────────────────────────────────────────────────────────

def _write_accounts(repo_root: Path, payload: dict) -> None:
    p = repo_root / "data" / "accounts.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    import json
    p.write_text(json.dumps(payload), encoding="utf-8")


class TestResolveCredentials:
    def _args(self, chatgpt_account_index=None, gemini_account_index=None):
        args = MagicMock()
        args.chatgpt_account_index = chatgpt_account_index
        args.gemini_account_index = gemini_account_index
        return args

    def test_uses_accounts_json_when_present(self, tmp_path):
        _write_accounts(tmp_path, {
            "chatgpt": [{"label": "cg1", "email": "cg@test.com", "password": "pass1"}],
            "gemini":  [{"label": "gm1", "email": "gm@test.com", "password": "pass2"}],
        })
        from auth.auto_login import _resolve_credentials
        with patch("auth.auto_login.REPO", tmp_path):
            result = _resolve_credentials(self._args())
        assert result["chatgpt"]["email"] == "cg@test.com"
        assert result["gemini"]["email"] == "gm@test.com"

    def test_falls_back_to_env_when_no_accounts_json(self, tmp_path):
        from auth.auto_login import _resolve_credentials
        env = {
            "CHATGPT_EMAIL": "env_cg@test.com",
            "CHATGPT_PASSWORD": "env_pass1",
            "GEMINI_EMAIL": "env_gm@test.com",
            "GEMINI_PASSWORD": "env_pass2",
        }
        with patch("auth.auto_login.REPO", tmp_path):
            with patch.dict(os.environ, env):
                result = _resolve_credentials(self._args())
        assert result["chatgpt"]["email"] == "env_cg@test.com"
        assert result["gemini"]["email"] == "env_gm@test.com"

    def test_env_fallback_label_is_env_marker(self, tmp_path):
        from auth.auto_login import _resolve_credentials
        env = {
            "CHATGPT_EMAIL": "cg@test.com",
            "CHATGPT_PASSWORD": "p",
            "GEMINI_EMAIL": "",
            "GEMINI_PASSWORD": "",
        }
        with patch("auth.auto_login.REPO", tmp_path):
            with patch.dict(os.environ, env, clear=False):
                result = _resolve_credentials(self._args())
        assert result["chatgpt"]["label"] == "(.env)"

    def test_env_missing_email_gives_none_credentials(self, tmp_path):
        from auth.auto_login import _resolve_credentials
        env = {"CHATGPT_EMAIL": "", "CHATGPT_PASSWORD": "", "GEMINI_EMAIL": "", "GEMINI_PASSWORD": ""}
        with patch("auth.auto_login.REPO", tmp_path):
            with patch.dict(os.environ, env, clear=False):
                result = _resolve_credentials(self._args())
        assert result["chatgpt"] is None
        assert result["gemini"] is None

    def test_override_index_respected(self, tmp_path):
        _write_accounts(tmp_path, {
            "chatgpt": [
                {"label": "cg1", "email": "cg1@test.com", "password": "p1"},
                {"label": "cg2", "email": "cg2@test.com", "password": "p2"},
            ],
            "gemini": [{"label": "gm1", "email": "gm@test.com", "password": "p"}],
        })
        from auth.auto_login import _resolve_credentials
        with patch("auth.auto_login.REPO", tmp_path):
            result = _resolve_credentials(self._args(chatgpt_account_index=1))
        assert result["chatgpt"]["email"] == "cg2@test.com"

    def test_out_of_range_override_index_exits(self, tmp_path):
        _write_accounts(tmp_path, {
            "chatgpt": [{"label": "cg1", "email": "cg@test.com", "password": "p"}],
            "gemini":  [{"label": "gm1", "email": "gm@test.com", "password": "p"}],
        })
        from auth.auto_login import _resolve_credentials
        with patch("auth.auto_login.REPO", tmp_path):
            with pytest.raises(SystemExit):
                _resolve_credentials(self._args(chatgpt_account_index=99))
