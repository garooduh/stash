from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from stash.auth.service import create_user
from stash.config import Settings
from stash.main import create_app


@pytest.fixture
def environment(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = data_dir / "stash.db"
    monkeypatch.setenv("STASH_DATA_DIR", str(data_dir))
    monkeypatch.setenv("STASH_DATABASE", str(db_path))
    monkeypatch.setenv("STASH_COOKIE_SECURE", "false")
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "head")
    return Settings(data_dir=data_dir, database=db_path, cookie_secure=False)


@pytest.fixture
def client(environment: Settings):
    app = create_app(environment)
    with app.state.session_factory() as db:
        first = create_user(db, "bobro", "long-test-password-1", is_admin=True)
        second = create_user(db, "family", "long-test-password-2")
        app.state.storage.ensure_root(first.id)
        app.state.storage.ensure_root(second.id)
    result = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
    result.stash_app = app
    return result
