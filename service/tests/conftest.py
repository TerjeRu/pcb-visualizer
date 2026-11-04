import pytest

from pcbv import github
from pcbv.board import Board

import helpers


@pytest.fixture(autouse=True)
def private_config_folder(tmp_path, monkeypatch):
    """Reading the settings can write them back, and the tutorial writes its practice board, so no test may reach the real ~/.config/pcbv or ~/.local/share/pcbv."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))


@pytest.fixture
def board(tmp_path):
    b = Board.create(tmp_path / "test-board", "Test board")
    yield b
    b.close()


@pytest.fixture
def seeded(board):
    """A board with one photo, one header and one marker linking them."""
    board.apply(helpers.add_asset(), "test")
    board.apply(helpers.add_marker(), "test")
    return board


@pytest.fixture(autouse=True)
def no_github(monkeypatch):
    """No test may reach GitHub: the private check answers 404 (private). A test that wants another answer
    replaces `github.github_status`; the tests of the real function put it back."""
    monkeypatch.setattr(github, "github_status", lambda owner, repo: 404)
