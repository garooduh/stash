"""Authentication and file API routes."""

import logging
from collections.abc import Iterator
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession
from starlette.background import BackgroundTask

from stash.auth.service import (
    create_session,
    create_webdav_token,
    get_session,
    revoke_session,
    verify_password,
)
from stash.database.models import User, WebDAVToken, utcnow
from stash.files.storage import StorageError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


def db_session(request: Request) -> Iterator[DBSession]:
    with request.app.state.session_factory() as db:
        yield db


def current_user(request: Request, db: DBSession = Depends(db_session)) -> User:
    session = get_session(db, request.cookies.get("stash_session"))
    if session is None:
        raise HTTPException(401, "Authentication required")
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(401, "Authentication required")
    return user


def mutation_guard(request: Request) -> None:
    if request.headers.get("x-stash-csrf") != "1":
        raise HTTPException(403, "Missing CSRF header")


class LoginRequest(BaseModel):
    username: str
    password: str


class PathRequest(BaseModel):
    path: str


class RenameRequest(PathRequest):
    name: str


class MoveRequest(PathRequest):
    destination: str


class TokenRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)


@router.post("/auth/login")
def login(
    payload: LoginRequest, request: Request, response: Response, db: DBSession = Depends(db_session)
) -> dict[str, object]:
    user = db.scalar(select(User).where(User.username == payload.username))
    if not verify_password(user, payload.password):
        logger.warning("Failed login attempt")
        raise HTTPException(401, "Invalid username or password")
    assert user is not None
    token = create_session(db, user, request.app.state.settings.session_lifetime_days)
    response.set_cookie(
        "stash_session",
        token,
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
        max_age=request.app.state.settings.session_lifetime_days * 86400,
        path="/",
    )
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin}


@router.post("/auth/logout", dependencies=[Depends(mutation_guard)])
def logout(
    request: Request, response: Response, db: DBSession = Depends(db_session)
) -> dict[str, bool]:
    revoke_session(db, request.cookies.get("stash_session"))
    response.delete_cookie(
        "stash_session",
        path="/",
        secure=request.app.state.settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"ok": True}


@router.get("/auth/me")
def me(user: User = Depends(current_user)) -> dict[str, object]:
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin}


@router.get("/files")
def list_files(
    request: Request, path: str = "", user: User = Depends(current_user)
) -> dict[str, object]:
    return {"path": path, "items": request.app.state.storage.list_dir(user.id, path)}


@router.get("/files/search")
def search_files(q: str, request: Request, user: User = Depends(current_user)) -> dict[str, object]:
    return {"items": request.app.state.storage.search(user.id, q) if q.strip() else []}


@router.post("/folders", dependencies=[Depends(mutation_guard)], status_code=201)
def create_folder(
    payload: PathRequest, request: Request, user: User = Depends(current_user)
) -> dict[str, str]:
    request.app.state.storage.mkdir(user.id, payload.path)
    return {"path": payload.path}


@router.get("/folders/download")
def download_folder(
    path: str, request: Request, user: User = Depends(current_user)
) -> FileResponse:
    archive, filename = request.app.state.storage.archive_folder(user.id, path)
    return FileResponse(
        archive,
        filename=filename,
        media_type="application/zip",
        background=BackgroundTask(archive.unlink, missing_ok=True),
    )


@router.post("/files/upload", dependencies=[Depends(mutation_guard)], status_code=201)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    folder: str = Form(""),
    user: User = Depends(current_user),
) -> dict[str, str]:
    path = await request.app.state.storage.upload(user.id, folder, file)
    logger.info("Uploaded user_id=%s path=%s", user.id, path)
    return {"path": path}


@router.get("/files/download")
def download_file(path: str, request: Request, user: User = Depends(current_user)) -> FileResponse:
    target = request.app.state.storage.resolve(user.id, path, must_exist=True)
    if not target.is_file():
        raise StorageError("Not a file")
    return FileResponse(target, filename=target.name, media_type=None)


@router.patch("/files/rename", dependencies=[Depends(mutation_guard)])
def rename_file(
    payload: RenameRequest, request: Request, user: User = Depends(current_user)
) -> dict[str, str]:
    if len(request.app.state.storage.parts(payload.name)) != 1:
        raise StorageError("Invalid name")
    parent = str(PurePosixPath(payload.path).parent)
    destination = f"{parent}/{payload.name}" if parent != "." else payload.name
    request.app.state.storage.move(user.id, payload.path, destination)
    logger.info("Renamed user_id=%s source=%s destination=%s", user.id, payload.path, destination)
    return {"path": destination}


@router.post("/files/move", dependencies=[Depends(mutation_guard)])
def move_file(
    payload: MoveRequest, request: Request, user: User = Depends(current_user)
) -> dict[str, str]:
    request.app.state.storage.move(user.id, payload.path, payload.destination)
    logger.info(
        "Moved user_id=%s source=%s destination=%s", user.id, payload.path, payload.destination
    )
    return {"path": payload.destination}


@router.delete("/files", dependencies=[Depends(mutation_guard)])
def delete_file(path: str, request: Request, user: User = Depends(current_user)) -> dict[str, bool]:
    request.app.state.storage.delete(user.id, path)
    logger.info("Deleted user_id=%s path=%s", user.id, path)
    return {"ok": True}


@router.get("/storage")
def storage_info(request: Request, user: User = Depends(current_user)) -> dict[str, int]:
    return request.app.state.storage.usage(user.id)


@router.get("/webdav-tokens")
def list_tokens(
    user: User = Depends(current_user), db: DBSession = Depends(db_session)
) -> dict[str, object]:
    records = db.scalars(
        select(WebDAVToken).where(WebDAVToken.user_id == user.id, WebDAVToken.revoked_at.is_(None))
    ).all()
    return {
        "items": [
            {"id": r.id, "name": r.name, "created_at": r.created_at, "last_used_at": r.last_used_at}
            for r in records
        ]
    }


@router.post("/webdav-tokens", dependencies=[Depends(mutation_guard)], status_code=201)
def new_token(
    payload: TokenRequest, user: User = Depends(current_user), db: DBSession = Depends(db_session)
) -> dict[str, object]:
    try:
        record, raw = create_webdav_token(db, user, payload.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    logger.info("Created WebDAV token user_id=%s token_id=%s", user.id, record.id)
    return {"id": record.id, "name": record.name, "token": raw}


@router.delete("/webdav-tokens/{token_id}", dependencies=[Depends(mutation_guard)])
def revoke_token(
    token_id: int, user: User = Depends(current_user), db: DBSession = Depends(db_session)
) -> dict[str, bool]:
    record = db.scalar(
        select(WebDAVToken).where(WebDAVToken.id == token_id, WebDAVToken.user_id == user.id)
    )
    if record is None or record.revoked_at:
        raise HTTPException(404, "Token not found")
    record.revoked_at = utcnow()
    db.commit()
    return {"ok": True}
