"""Per-user filesystem operations with path and symlink checks."""

import os
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from fastapi import UploadFile


class StorageError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message = message
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class FileItem:
    name: str
    path: str
    is_dir: bool
    size: int
    modified_at: str


class Storage:
    def __init__(self, data_dir: Path):
        self.users_dir = data_dir / "users"

    def root(self, user_id: int) -> Path:
        if user_id <= 0:
            raise StorageError("Invalid user", 403)
        return self.users_dir / str(user_id) / "files"

    def ensure_root(self, user_id: int) -> Path:
        root = self.root(user_id)
        for parent in (self.users_dir, root.parent):
            if parent.is_symlink():
                raise StorageError("Storage directory is a symlink", 403)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.is_symlink():
            raise StorageError("Storage root is a symlink", 403)
        return root

    @staticmethod
    def parts(path: str) -> tuple[str, ...]:
        if not isinstance(path, str) or "\x00" in path or "\\" in path or path.startswith("/"):
            raise StorageError("Invalid path")
        # Reject encoded separators/traversal even if a framework or client decodes twice.
        decoded = path
        for _ in range(3):
            next_value = unquote(decoded)
            if next_value == decoded:
                break
            decoded = next_value
        for value in (path, decoded):
            if value.startswith("/") or "\\" in value:
                raise StorageError("Invalid path")
            if any(part in {".", ".."} for part in value.split("/")):
                raise StorageError("Path traversal is forbidden", 403)
        parts = tuple(path.split("/")) if path else ()
        if any(not part or part in {".", ".."} for part in parts):
            raise StorageError("Invalid path")
        return parts

    def resolve(self, user_id: int, path: str, *, must_exist: bool = False) -> Path:
        root = self.ensure_root(user_id)
        parts = self.parts(path)
        target = root.joinpath(*parts)
        current = root
        for part in parts:
            current = current / part
            if current.is_symlink():
                raise StorageError("Symbolic links are not supported", 403)
        if must_exist and not target.exists():
            raise StorageError("File or folder not found", 404)
        if target.exists() and not (target.is_file() or target.is_dir()):
            raise StorageError("Unsupported file type", 403)
        return target

    def list_dir(self, user_id: int, path: str = "") -> list[FileItem]:
        folder = self.resolve(user_id, path, must_exist=True)
        if not folder.is_dir():
            raise StorageError("Not a folder")
        items = []
        for child in folder.iterdir():
            if child.is_symlink() or not (child.is_file() or child.is_dir()):
                continue
            info = child.stat()
            child_path = str(PurePosixPath(path) / child.name) if path else child.name
            items.append(
                FileItem(
                    child.name,
                    child_path,
                    child.is_dir(),
                    info.st_size if child.is_file() else 0,
                    datetime.fromtimestamp(info.st_mtime, UTC).isoformat(),
                )
            )
        return sorted(items, key=lambda item: (not item.is_dir, item.name.casefold()))

    def mkdir(self, user_id: int, path: str) -> None:
        if not self.parts(path):
            raise StorageError("Folder name is required")
        target = self.resolve(user_id, path)
        if not target.parent.is_dir():
            raise StorageError("Parent folder not found", 404)
        try:
            target.mkdir()
        except FileExistsError as exc:
            raise StorageError("Name already exists", 409) from exc

    async def upload(self, user_id: int, folder: str, file: UploadFile) -> str:
        name = file.filename or ""
        if len(self.parts(name)) != 1:
            raise StorageError("Invalid file name")
        target_path = f"{folder}/{name}" if folder else name
        target = self.resolve(user_id, target_path)
        if not target.parent.is_dir():
            raise StorageError("Parent folder not found", 404)
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=target.parent, prefix=".stash-upload-", delete=False
            ) as output:
                temporary = output.name
                while chunk := await file.read(1024 * 1024):
                    output.write(chunk)
            # Atomic no-overwrite publish on the same filesystem.
            os.link(temporary, target)
        except FileExistsError as exc:
            raise StorageError("Name already exists", 409) from exc
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
            await file.close()
        return target_path

    def move(self, user_id: int, source: str, destination: str) -> None:
        if not self.parts(source) or not self.parts(destination):
            raise StorageError("Source and destination are required")
        src = self.resolve(user_id, source, must_exist=True)
        dst = self.resolve(user_id, destination)
        if not dst.parent.is_dir():
            raise StorageError("Destination folder not found", 404)
        if src.is_dir() and src in dst.parents:
            raise StorageError("Cannot move a folder into itself")
        if dst.exists():
            raise StorageError("Name already exists", 409)
        os.rename(src, dst)

    def delete(self, user_id: int, path: str) -> None:
        if not self.parts(path):
            raise StorageError("Cannot delete storage root")
        target = self.resolve(user_id, path, must_exist=True)
        if target.is_dir():
            # Refuse symlinks found anywhere in a directory being removed.
            for root, dirs, files in os.walk(target, followlinks=False):
                for name in dirs + files:
                    if (Path(root) / name).is_symlink():
                        raise StorageError("Folder contains a symbolic link", 403)
            shutil.rmtree(target)
        else:
            target.unlink()

    def archive_folder(self, user_id: int, path: str) -> tuple[Path, str]:
        if not self.parts(path):
            raise StorageError("Folder path is required")
        folder = self.resolve(user_id, path, must_exist=True)
        if not folder.is_dir():
            raise StorageError("Not a folder")

        with tempfile.NamedTemporaryFile(
            prefix="stash-download-", suffix=".zip", delete=False
        ) as temporary:
            archive_path = Path(temporary.name)
        try:
            with zipfile.ZipFile(
                archive_path, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
            ) as archive:
                archive.writestr(f"{folder.name}/", b"")
                for parent, dirs, files in os.walk(folder, followlinks=False):
                    parent_path = Path(parent)
                    for name in dirs:
                        child = parent_path / name
                        if child.is_symlink():
                            raise StorageError("Folder contains a symbolic link", 403)
                        relative = child.relative_to(folder).as_posix()
                        archive.writestr(f"{folder.name}/{relative}/", b"")
                    for name in files:
                        child = parent_path / name
                        if child.is_symlink():
                            raise StorageError("Folder contains a symbolic link", 403)
                        if not child.is_file():
                            raise StorageError("Folder contains an unsupported file type", 403)
                        relative = child.relative_to(folder).as_posix()
                        archive.write(child, f"{folder.name}/{relative}")
        except Exception:
            archive_path.unlink(missing_ok=True)
            raise
        return archive_path, f"{folder.name}.zip"

    def search(self, user_id: int, query: str) -> list[FileItem]:
        root = self.ensure_root(user_id)
        result = []
        for parent, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(parent) / d).is_symlink()]
            for name in dirs + files:
                if query.casefold() not in name.casefold():
                    continue
                path = (Path(parent) / name).relative_to(root).as_posix()
                try:
                    item_path = self.resolve(user_id, path, must_exist=True)
                except StorageError:
                    continue
                info = item_path.stat()
                result.append(
                    FileItem(
                        name,
                        path,
                        item_path.is_dir(),
                        info.st_size if item_path.is_file() else 0,
                        datetime.fromtimestamp(info.st_mtime, UTC).isoformat(),
                    )
                )
                if len(result) >= 500:
                    return result
        return result

    def usage(self, user_id: int) -> dict[str, int]:
        root = self.ensure_root(user_id)
        disk = shutil.disk_usage(root)
        return {"used": disk.used, "available": disk.free, "total": disk.total}
