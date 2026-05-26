"""Tests for src/python/auth/accounts.py.

Coverage targets:
    - load_accounts: happy path, missing file, placeholder scrubbing, malformed schema
    - get_active: first account, stale state reset, override_index
    - rotate: advance, exhaustion, wrap-around
    - reset: returns index-0 account
    - status: no file, mixed providers
    - _write_state: atomic tmp→rename
"""

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src" / "python"))

from auth.accounts import (
    AccountsFileMissingError,
    NoMoreAccountsError,
    get_active,
    load_accounts,
    reset,
    rotate,
    status,
)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _write_accounts(repo_root: Path, payload: dict) -> None:
    p = repo_root / "data" / "accounts.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload), encoding="utf-8")


def _write_state(repo_root: Path, state: dict) -> None:
    sp = repo_root / "data" / ".cca" / "active_accounts.json"
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(json.dumps(state), encoding="utf-8")


# ──────────────────────────────────────────────────────────────────────────────
# load_accounts
# ──────────────────────────────────────────────────────────────────────────────

class TestLoadAccounts:
    def test_returns_both_providers(self, accounts_file):
        accs = load_accounts(accounts_file)
        assert set(accs.keys()) == {"chatgpt", "gemini"}

    def test_chatgpt_count(self, accounts_file):
        accs = load_accounts(accounts_file)
        assert len(accs["chatgpt"]) == 2

    def test_gemini_count(self, accounts_file):
        accs = load_accounts(accounts_file)
        assert len(accs["gemini"]) == 1

    def test_missing_file_raises(self, tmp_repo):
        with pytest.raises(AccountsFileMissingError):
            load_accounts(tmp_repo)

    def test_placeholder_email_stripped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "x", "email": "your-email@example.com", "password": "abc"}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"] == []

    def test_placeholder_password_stripped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "x", "email": "real@test.com", "password": "your-password"}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"] == []

    def test_empty_email_stripped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "x", "email": "", "password": "pass"}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"] == []

    def test_empty_password_stripped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "x", "email": "real@test.com", "password": ""}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"] == []

    def test_malformed_provider_not_list(self, tmp_repo):
        _write_accounts(tmp_repo, {"chatgpt": {"email": "x"}, "gemini": []})
        with pytest.raises(ValueError, match="must be a list"):
            load_accounts(tmp_repo)

    def test_missing_provider_returns_empty_list(self, tmp_repo):
        _write_accounts(tmp_repo, {"chatgpt": []})
        accs = load_accounts(tmp_repo)
        assert accs["gemini"] == []

    def test_auto_generated_label(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"email": "a@b.com", "password": "p"}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"][0]["label"] == "acct-1"

    def test_whitespace_email_stripped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "x", "email": "  real@test.com  ", "password": "pass"}],
            "gemini": [],
        })
        accs = load_accounts(tmp_repo)
        assert accs["chatgpt"][0]["email"] == "real@test.com"


# ──────────────────────────────────────────────────────────────────────────────
# get_active
# ──────────────────────────────────────────────────────────────────────────────

class TestGetActive:
    def test_returns_first_account_by_default(self, accounts_file):
        a = get_active("chatgpt", accounts_file)
        assert a["email"] == "user1@test.com"
        assert a["index"] == 0

    def test_override_index(self, accounts_file):
        a = get_active("chatgpt", accounts_file, override_index=1)
        assert a["email"] == "user2@test.com"
        assert a["index"] == 1

    def test_override_index_out_of_range(self, accounts_file):
        with pytest.raises(IndexError):
            get_active("chatgpt", accounts_file, override_index=99)

    def test_stale_state_resets_to_zero(self, accounts_file):
        # Write state pointing past the list
        _write_state(accounts_file, {"chatgpt": {"index": 50, "label": "gone"}})
        a = get_active("chatgpt", accounts_file)
        assert a["index"] == 0

    def test_no_accounts_raises(self, tmp_repo):
        _write_accounts(tmp_repo, {"chatgpt": [], "gemini": []})
        with pytest.raises(NoMoreAccountsError):
            get_active("chatgpt", tmp_repo)

    def test_persisted_index_respected(self, accounts_file):
        _write_state(accounts_file, {"chatgpt": {"index": 1, "label": "cg2"}})
        a = get_active("chatgpt", accounts_file)
        assert a["email"] == "user2@test.com"
        assert a["index"] == 1


# ──────────────────────────────────────────────────────────────────────────────
# rotate
# ──────────────────────────────────────────────────────────────────────────────

class TestRotate:
    def test_advances_to_next_account(self, accounts_file):
        a = rotate("chatgpt", accounts_file)
        assert a["email"] == "user2@test.com"
        assert a["index"] == 1

    def test_persists_after_rotate(self, accounts_file):
        rotate("chatgpt", accounts_file)
        a = get_active("chatgpt", accounts_file)
        assert a["index"] == 1

    def test_exhaustion_raises_by_default(self, accounts_file):
        rotate("chatgpt", accounts_file)  # index 0 → 1
        with pytest.raises(NoMoreAccountsError):
            rotate("chatgpt", accounts_file)  # 1 → 2 (only 2 accounts)

    def test_wrap_true_cycles_to_zero(self, accounts_file):
        rotate("chatgpt", accounts_file)  # 0 → 1
        a = rotate("chatgpt", accounts_file, wrap=True)  # 1 → 0 (wraps)
        assert a["index"] == 0
        assert a["email"] == "user1@test.com"

    def test_single_account_wrap(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "gemini": [{"label": "gm1", "email": "gm1@t.com", "password": "p"}],
            "chatgpt": [],
        })
        a = rotate("gemini", tmp_repo, wrap=True)
        assert a["index"] == 0

    def test_single_account_no_wrap_raises(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "gemini": [{"label": "gm1", "email": "gm1@t.com", "password": "p"}],
            "chatgpt": [],
        })
        with pytest.raises(NoMoreAccountsError):
            rotate("gemini", tmp_repo)

    def test_error_message_includes_provider(self, accounts_file):
        rotate("chatgpt", accounts_file)
        with pytest.raises(NoMoreAccountsError, match="chatgpt"):
            rotate("chatgpt", accounts_file)


# ──────────────────────────────────────────────────────────────────────────────
# reset
# ──────────────────────────────────────────────────────────────────────────────

class TestReset:
    def test_returns_first_account(self, accounts_file):
        rotate("chatgpt", accounts_file)
        a = reset("chatgpt", accounts_file)
        assert a["index"] == 0
        assert a["email"] == "user1@test.com"

    def test_persists_after_reset(self, accounts_file):
        rotate("chatgpt", accounts_file)
        reset("chatgpt", accounts_file)
        a = get_active("chatgpt", accounts_file)
        assert a["index"] == 0

    def test_no_accounts_raises(self, tmp_repo):
        _write_accounts(tmp_repo, {"chatgpt": [], "gemini": []})
        with pytest.raises(NoMoreAccountsError):
            reset("chatgpt", tmp_repo)


# ──────────────────────────────────────────────────────────────────────────────
# status
# ──────────────────────────────────────────────────────────────────────────────

class TestStatus:
    def test_returns_both_keys(self, accounts_file):
        s = status(accounts_file)
        assert "chatgpt" in s and "gemini" in s

    def test_chatgpt_total_count(self, accounts_file):
        s = status(accounts_file)
        assert s["chatgpt"]["total_accounts"] == 2

    def test_gemini_total_count(self, accounts_file):
        s = status(accounts_file)
        assert s["gemini"]["total_accounts"] == 1

    def test_missing_file_returns_none_values(self, tmp_repo):
        s = status(tmp_repo)
        assert s["chatgpt"] is None
        assert s["gemini"] is None

    def test_active_label_reflects_rotated_state(self, accounts_file):
        rotate("chatgpt", accounts_file)
        s = status(accounts_file)
        assert s["chatgpt"]["active_label"] == "cg2"
        assert s["chatgpt"]["active_index"] == 1

    def test_empty_provider_skipped(self, tmp_repo):
        _write_accounts(tmp_repo, {
            "chatgpt": [{"label": "cg", "email": "a@b.com", "password": "p"}],
            "gemini": [],
        })
        s = status(tmp_repo)
        assert s["chatgpt"] is not None
        assert s["gemini"] is None


# ──────────────────────────────────────────────────────────────────────────────
# State persistence (atomic write)
# ──────────────────────────────────────────────────────────────────────────────

class TestStatePersistence:
    def test_no_tmp_file_left_after_write(self, accounts_file):
        rotate("chatgpt", accounts_file)
        cca = accounts_file / "data" / ".cca"
        tmp_files = list(cca.glob("*.tmp"))
        assert tmp_files == []

    def test_state_file_valid_json(self, accounts_file):
        rotate("chatgpt", accounts_file)
        sp = accounts_file / "data" / ".cca" / "active_accounts.json"
        data = json.loads(sp.read_text())
        assert "chatgpt" in data
        assert data["chatgpt"]["index"] == 1

    def test_corrupted_state_file_ignored(self, accounts_file):
        sp = accounts_file / "data" / ".cca" / "active_accounts.json"
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text("NOT JSON", encoding="utf-8")
        # Should fall back to index 0 without raising
        a = get_active("chatgpt", accounts_file)
        assert a["index"] == 0
