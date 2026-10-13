"""runtime_paths: new installs use var/; old installs keep their legacy files."""
import runtime_paths


def test_new_install_uses_state_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_paths, "STATE_DIR", tmp_path / "var")
    p = runtime_paths.state_path("users.json", legacy=tmp_path / "backend" / "users.json")
    assert p == tmp_path / "var" / "users.json" and p.parent.is_dir()


def test_existing_legacy_file_is_used_not_moved(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_paths, "STATE_DIR", tmp_path / "var")
    legacy = tmp_path / "backend" / "users.json"
    legacy.parent.mkdir()
    legacy.write_text("{}")
    assert runtime_paths.state_path("users.json", legacy=legacy) == legacy
    assert legacy.exists()


def test_state_dir_wins_once_moved(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_paths, "STATE_DIR", tmp_path / "var")
    legacy = tmp_path / "users.json"
    legacy.write_text("{}")
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "users.json").write_text("{}")
    assert runtime_paths.state_path("users.json", legacy=legacy) == tmp_path / "var" / "users.json"
