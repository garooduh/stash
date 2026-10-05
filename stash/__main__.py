"""CLI for running Stash and creating users."""

import argparse
import getpass
import logging
import sys

import uvicorn

from stash.auth.service import change_password, create_user
from stash.config import Settings
from stash.database.core import make_engine, make_session_factory
from stash.files.storage import Storage

logger = logging.getLogger(__name__)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m stash")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", help="Run the HTTP application")
    user_cmd = commands.add_parser("user", help="Manage users")
    user_commands = user_cmd.add_subparsers(dest="user_command", required=True)
    create_cmd = user_commands.add_parser("create", help="Create a user")
    create_cmd.add_argument("username")
    create_cmd.add_argument("--admin", action="store_true")
    password_cmd = user_commands.add_parser("password", help="Change a user's password")
    password_cmd.add_argument("username")
    args = parser.parse_args(argv)
    settings = Settings.from_env()
    if args.command == "serve":
        uvicorn.run(
            "stash.main:create_app",
            factory=True,
            host=settings.host,
            port=settings.port,
            proxy_headers=True,
            forwarded_allow_ips=settings.trusted_proxy_ips,
        )
        return 0
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match", file=sys.stderr)
        return 1
    engine = make_engine(settings.database)
    try:
        with make_session_factory(engine)() as db:
            if args.user_command == "create":
                user = create_user(db, args.username, password, is_admin=args.admin)
                Storage(settings.data_dir).ensure_root(user.id)
            else:
                user = change_password(db, args.username, password)
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        engine.dispose()
    if args.user_command == "create":
        print(f"Created user {user.username} (id={user.id})")
    else:
        print(f"Changed password for {user.username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
