import zipfile

import httpx
import pytest

from stash.files.storage import StorageError


def test_folder_archive_isolated_and_safe(client: httpx.AsyncClient, environment):
    storage = client.stash_app.state.storage
    first = environment.data_dir / "users/1/files/Проекты"
    second = environment.data_dir / "users/2/files/Проекты"
    first.joinpath("Пустая папка").mkdir(parents=True)
    first.joinpath("описание.txt").write_text("первый", encoding="utf-8")
    second.mkdir()
    second.joinpath("описание.txt").write_text("второй", encoding="utf-8")

    archive_path, filename = storage.archive_folder(1, "Проекты")
    try:
        assert filename == "Проекты.zip"
        with zipfile.ZipFile(archive_path) as archive:
            assert set(archive.namelist()) == {
                "Проекты/",
                "Проекты/Пустая папка/",
                "Проекты/описание.txt",
            }
            assert archive.read("Проекты/описание.txt") == "первый".encode()
            assert archive.testzip() is None
    finally:
        archive_path.unlink(missing_ok=True)

    with pytest.raises(StorageError):
        storage.archive_folder(1, "../2/files/Проекты")

    first.joinpath("ссылка").symlink_to(second / "описание.txt")
    with pytest.raises(StorageError, match="symbolic link"):
        storage.archive_folder(1, "Проекты")
