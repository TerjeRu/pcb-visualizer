import pytest

from pcbv import cli
from pcbv.kwin import TITLES, RuleError, parse_assignments, rules_file


def test_titles_match_the_app_panels():
    import re
    from pathlib import Path
    layout = (Path(__file__).parents[2] / "app/js/core/layout.js").read_text()
    panels = dict(re.findall(r"^\s+(\w+): '([^']+)',$", layout.split("export const PANELS = {")[1].split("};")[0], re.M))
    assert {k: f"pcbv · {v}" for k, v in panels.items()} == {k: v for k, v in TITLES.items() if k != "main"}


def test_rules_pin_each_window_by_exact_title():
    text = rules_file({"console": 1, "main": 0})
    assert "[1]\nDescription=PCB Visualizer: pcbv · Console on monitor 1\ntitle=pcbv · Console\ntitlematch=1" in text
    assert "screen=1\nscreenrule=2" in text
    assert "[2]" in text and "title=pcbv\n" in text and "screen=0" in text
    assert "maximize" not in text
    assert "maximizehoriz=true" in rules_file({"wiki": 2}, maximize=True)


@pytest.mark.parametrize("items", [[], ["console"], ["nope=1"], ["console=left"]])
def test_bad_assignments_explain_the_format(items):
    with pytest.raises(RuleError, match="window=monitor"):
        parse_assignments(items)


def test_cli_writes_the_file(tmp_path, capsys):
    out = tmp_path / "w.kwinrule"
    assert cli.main(["kwin-rules", "main=0", "console=1", "-o", str(out)]) == 0
    assert "title=pcbv · Console" in out.read_text()
    assert "Window Rules > Import" in capsys.readouterr().out
    assert cli.main(["kwin-rules", "console"]) == 2
