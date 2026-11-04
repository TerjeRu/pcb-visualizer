import re

from starlette.testclient import TestClient

from pcbv.playbooks import load_all
from pcbv.server import create_app
from pcbv.wiki import builtin_dir, contents, get_figure, get_page, list_pages

TOKEN = "test-token-123"
AUTH = {"X-PCBV-Protocol": "2", "Authorization": f"Bearer {TOKEN}"}
LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
FIGURE_RE = re.compile(r"^!\[[^\]]*\]\(([^)\s]+)\)$", re.M)
# Stock phrases that make reference text read as generated filler.
FILLER = ("delve", "crucial", "seamless", "leverage", "in summary", "it's important to note", "it is important to note",
          "let's", "dive in", "game-changer", "in conclusion", "whether you're", "embark", "journey", "navigate the")


def test_starter_pages_have_titles_and_follow_the_house_style():
    pages = list_pages(None)
    names = {p["name"] for p in pages}
    assert {"uart", "safety", "multimeter", "glossary"} <= names
    for path in builtin_dir().glob("*.md"):
        text = path.read_text(encoding="utf-8")
        assert text.startswith("# "), f"{path.name} needs a # title on its first line"
        assert "—" not in text, f"{path.name} contains an em dash"
        lowered = text.lower()
        assert not [w for w in FILLER if w in lowered], f"{path.name} uses filler: {[w for w in FILLER if w in lowered]}"


def test_every_built_in_page_is_in_exactly_one_section():
    listed = [name for section in contents() for name in section["pages"]]
    files = {path.stem for path in builtin_dir().glob("*.md")}
    assert len(listed) == len(set(listed)), "a page is listed twice in contents.yaml"
    assert set(listed) == files
    assert contents()[0]["title"] == "Start here"


def test_figures_used_by_pages_exist_and_are_plain_svg():
    for path in builtin_dir().glob("*.md"):
        for file in FIGURE_RE.findall(path.read_text(encoding="utf-8")):
            found = get_figure(file)
            assert found is not None, f"{path.name} shows missing figure {file!r}"
            svg = found[0].read_text(encoding="utf-8")
            assert "<script" not in svg and "href=\"http" not in svg and "—" not in svg, file


def test_every_wiki_page_a_playbook_names_exists():
    names = {p["name"] for p in list_pages(None)}
    playbooks, _ = load_all(None)
    wanted = {w for pb in playbooks for step in pb["steps"] for w in step["wiki"]}
    assert wanted - names == set()


def test_links_between_starter_pages_resolve():
    names = {p["name"] for p in list_pages(None)}
    for path in builtin_dir().glob("*.md"):
        for target in LINK_RE.findall(path.read_text(encoding="utf-8")):
            if not target.startswith(("http://", "https://")):
                assert target in names, f"{path.name} links to missing page {target!r}"


def test_data_repo_pages_replace_and_extend(tmp_path):
    (tmp_path / "uart.md").write_text("# My UART notes\n\nShorter.\n")
    (tmp_path / "bench.md").write_text("# Bench inventory\n")
    (tmp_path / "Bad Name.md").write_text("# skipped\n")
    (tmp_path / "evil.md").symlink_to("/etc/passwd")
    pages = {p["name"]: p for p in list_pages(tmp_path)}
    assert pages["uart"] == {"name": "uart", "title": "My UART notes", "origin": "data repo", "section": "Interfaces"}
    assert pages["bench"]["origin"] == "data repo"
    assert "evil" not in pages and "Bad Name" not in pages
    assert get_page("uart", tmp_path)["markdown"].startswith("# My UART notes")
    assert get_page("safety", tmp_path)["origin"] == "builtin"
    assert get_page("evil", tmp_path) is None
    assert get_page("../etc/passwd", tmp_path) is None


def test_index_follows_the_sections_and_puts_your_pages_after_them(tmp_path):
    (tmp_path / "nimbus.md").write_text("# Nimbus notes\n")
    (tmp_path / "bench.md").write_text("# Bench inventory\n")
    pages = list_pages(tmp_path)
    sections = [p["section"] for p in pages]
    assert sections[0] == "Start here" and pages[0]["name"] == "start-here"
    assert [p["name"] for p in pages if p["section"] == "Your pages"] == ["bench", "nimbus"]
    assert sections.index("Your pages") > sections.index("Reference")
    assert sections == sorted(sections, key=sections.index), "each section is listed in one run"


def test_figures_follow_the_page_rules(tmp_path):
    (tmp_path / "mine.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (tmp_path / "link.svg").symlink_to("/etc/passwd")
    (tmp_path / "big.png").write_bytes(b"0" * 1_000_001)
    assert get_figure("mine.svg", tmp_path) == (tmp_path / "mine.svg", "image/svg+xml")
    assert get_figure("mine.svg") is None
    assert get_figure("link.svg", tmp_path) is None
    assert get_figure("big.png", tmp_path) is None
    for bad in ("../mine.svg", "Mine.svg", "mine.html", "mine.svg.html", "", None):
        assert get_figure(bad, tmp_path) is None


def test_api_serves_pages_behind_the_token(tmp_path):
    root = tmp_path / "hw" / "boards"
    root.mkdir(parents=True)
    (tmp_path / "hw" / "wiki").mkdir()
    (tmp_path / "hw" / "wiki" / "bench.md").write_text("# Bench inventory\n")
    with TestClient(create_app(root, TOKEN), base_url="http://localhost:8765") as client:
        assert client.get("/api/wiki").status_code == 401
        index = client.get("/api/wiki", headers=AUTH).json()["pages"]
        assert any(p["name"] == "bench" for p in index)
        page = client.get("/api/wiki/uart", headers=AUTH).json()
        assert page["title"] == "UART (serial console)" and "115200" in page["markdown"]
        missing = client.get("/api/wiki/no-such-page", headers=AUTH)
        assert missing.status_code == 404 and "no-such-page.md" in missing.json()["message"]
        assert client.get("/api/wiki/..%2F..%2Fetc", headers=AUTH).status_code == 404
        (tmp_path / "hw" / "wiki" / "bench.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
        assert client.get("/api/wiki/figures/bench.svg").status_code == 401
        figure = client.get("/api/wiki/figures/bench.svg", headers=AUTH)
        assert figure.status_code == 200 and figure.headers["content-type"] == "image/svg+xml"
        assert "default-src 'none'" in figure.headers["content-security-policy"]
        assert figure.headers["x-content-type-options"] == "nosniff"
        assert client.get("/api/wiki/figures/nope.svg", headers=AUTH).status_code == 404
        assert client.get("/api/wiki/figures/bench.md", headers=AUTH).status_code == 404


def test_the_github_backup_page_is_listed_and_loads_in_the_start_here_section():
    start = next(s for s in contents() if s["title"] == "Start here")
    assert "github-backup" in start["pages"]
    page = get_page("github-backup")
    assert page["title"] == "Back up to GitHub" and "private" in page["markdown"].lower()
    assert "(github-backup)" in get_page("settings-and-privacy")["markdown"]
