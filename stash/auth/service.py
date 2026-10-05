"""Passwords, server sessions and WebDAV bearer tokens."""

import secrets
from datetime import timedelta
from hashlib import sha256

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DBSession

from stash.database.models import Session, User, WebDAVToken, utcnow

password_hasher = PasswordHasher()


def digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def create_user(db: DBSession, username: str, password: str, *, is_admin: bool = False) -> User:
    username = username.strip()
    if not username or len(username) > 255 or any(c.isspace() for c in username):
        raise ValueError("Username must be 1–255 characters without whitespace")
    if len(password) < 12:
        raise ValueError("Password must contain at least 12 characters")
    if db.scalar(select(User).where(User.username == username)):
        raise ValueError("Username already exists")
    user = User(username=username, password_hash=password_hasher.hash(password), is_admin=is_admin)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def change_password(db: DBSession, username: str, password: str) -> User:
    if len(password) < 12:
        raise ValueError("Password must contain at least 12 characters")
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise ValueError("User not found")
    user.password_hash = password_hasher.hash(password)
    db.execute(delete(Session).where(Session.user_id == user.id))
    db.commit()
    return user


def verify_password(user: User | None, password: str) -> bool:
    if user is None:
        return False
    try:
        return password_hasher.verify(user.password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False


def create_session(db: DBSession, user: User, lifetime_days: int) -> str:
    token = secrets.token_urlsafe(48)
    db.add(
        Session(
            user_id=user.id,
            token_hash=digest(token),
            expires_at=utcnow() + timedelta(days=lifetime_days),
        )
    )
    db.commit()
    return token


def get_session(db: DBSession, token: str | None) -> Session | None:
    if not token:
        return None
    session = db.scalar(select(Session).where(Session.token_hash == digest(token)))
    if session and session.expires_at.replace(tzinfo=None) > utcnow().replace(tzinfo=None):
        return session
    return None


def revoke_session(db: DBSession, token: str | None) -> None:
    session = get_session(db, token)
    if session:
        db.delete(session)
        db.commit()


def create_webdav_token(db: DBSession, user: User, name: str) -> tuple[WebDAVToken, str]:
    name = name.strip()
    if not name or len(name) > 255:
        raise ValueError("Token name must be 1–255 characters")
    raw = "stash_" + secrets.token_urlsafe(32)
    record = WebDAVToken(user_id=user.id, name=name, token_hash=digest(raw))
    db.add(record)
    db.commit()
    db.refresh(record)
    return record, raw


def validate_webdav_token(db: DBSession, username: str, raw: str) -> User | None:
    if not raw.startswith("stash_"):
        return None
    record = db.scalar(
        select(WebDAVToken)
        .join(User)
        .where(
            User.username == username,
            WebDAVToken.token_hash == digest(raw),
            WebDAVToken.revoked_at.is_(None),
        )
    )
    if record is None:
        return None
    record.last_used_at = utcnow()
    db.commit()
    return record.user
