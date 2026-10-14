"""settings: validation, prod secret enforcement and .env loading."""
import os

import pytest

import settings as settings_mod
from settings import SettingsError, from_env, load_env_files


@pytest.fixture
def env(monkeypatch):
    for k in ("MACROKIT_ENV", "SECRET_KEY", "CORS_ORIGINS", "ANALYTICS_DATA_SOURCE", "PORT", "LOGIN_MAX_FAILURES"):
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_dev_defaults(env):
    s = from_env()
    assert s.env == "dev" and not s.is_prod and s.secret_key == ""
    assert s.data_source == "csv" and "http://localhost:5173" in s.cors_origins


def test_prod_requires_a_real_secret(env):
    env.setenv("MACROKIT_ENV", "prod")
    with pytest.raises(SettingsError, match="SECRET_KEY"):
        from_env()
    env.setenv("SECRET_KEY", "short")
    with pytest.raises(SettingsError):
        from_env()
    env.setenv("SECRET_KEY", "x" * 40)
    assert from_env().is_prod


@pytest.mark.parametrize("name,value", [("MACROKIT_ENV", "staging"), ("ANALYTICS_DATA_SOURCE", "excel"),
                                        ("PORT", "eighty"), ("LOGIN_MAX_FAILURES", "0")])
def test_invalid_values_fail_fast(env, name, value):
    env.setenv(name, value)
    with pytest.raises(SettingsError, match=name):
        from_env()


def test_cors_origins_from_env(env):
    env.setenv("CORS_ORIGINS", "https://a.example, https://b.example")
    assert from_env().cors_origins == ("https://a.example", "https://b.example")


def test_env_files_never_override_the_environment(tmp_path, env):
    f = tmp_path / ".env"
    f.write_text('# comment\nexport MK_TEST_A="from-file"\nMK_TEST_B=from-file\n')
    env.setenv("MK_TEST_B", "from-env")
    load_env_files((f,))
    assert os.environ["MK_TEST_A"] == "from-file" and os.environ["MK_TEST_B"] == "from-env"
    env.delenv("MK_TEST_A")


def test_module_settings_loaded():
    assert settings_mod.settings.env in ("dev", "prod")
