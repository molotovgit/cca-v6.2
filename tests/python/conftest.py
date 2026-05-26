"""Shared fixtures for all Python test modules."""

import json
import pytest
from pathlib import Path


@pytest.fixture
def tmp_repo(tmp_path):
    """Minimal repo root with accounts.json and data/.cca/ skeleton."""
    data = tmp_path / "data"
    data.mkdir()
    (data / ".cca").mkdir()
    return tmp_path


@pytest.fixture
def accounts_file(tmp_repo):
    """Write a valid accounts.json and return its directory root."""
    payload = {
        "chatgpt": [
            {"label": "cg1", "email": "user1@test.com", "password": "pass1"},
            {"label": "cg2", "email": "user2@test.com", "password": "pass2"},
        ],
        "gemini": [
            {"label": "gm1", "email": "gm1@test.com", "password": "gmpass1"},
        ],
    }
    (tmp_repo / "data" / "accounts.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )
    return tmp_repo
