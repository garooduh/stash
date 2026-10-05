from stash.__main__ import main
from stash.auth.service import verify_password
from stash.database.core import make_engine, make_session_factory
from stash.database.models import User


def test_cli_creates_first_admin(environment, monkeypatch):
    passwords = iter(["a-strong-password-123", "a-strong-password-123"])
    monkeypatch.setattr("getpass.getpass", lambda prompt: next(passwords))
    assert main(["user", "create", "first", "--admin"]) == 0
    engine = make_engine(environment.database)
    with make_session_factory(engine)() as db:
        user = db.query(User).filter_by(username="first").one()
        assert user.is_admin
        assert user.password_hash != "a-strong-password-123"
        assert environment.data_dir.joinpath("users", str(user.id), "files").is_dir()
    engine.dispose()


def test_cli_changes_password(environment, monkeypatch):
    passwords = iter(
        ["first-password-123", "first-password-123", "new-password-456", "new-password-456"]
    )
    monkeypatch.setattr("getpass.getpass", lambda prompt: next(passwords))
    assert main(["user", "create", "bobro", "--admin"]) == 0
    assert main(["user", "password", "bobro"]) == 0
    engine = make_engine(environment.database)
    with make_session_factory(engine)() as db:
        user = db.query(User).filter_by(username="bobro").one()
        assert not verify_password(user, "first-password-123")
        assert verify_password(user, "new-password-456")
    engine.dispose()
