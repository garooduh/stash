"""Map authenticated WebDAV users to their own filesystem roots."""

import logging

from sqlalchemy.orm import Session, sessionmaker
from wsgidav.dav_error import HTTP_FORBIDDEN, DAVError
from wsgidav.dc.base_dc import BaseDomainController
from wsgidav.fs_dav_provider import FilesystemProvider
from wsgidav.wsgidav_app import WsgiDAVApp

from stash.auth.service import validate_webdav_token
from stash.files.storage import Storage, StorageError

logger = logging.getLogger(__name__)


class TokenDomainController(BaseDomainController):
    session_factory: sessionmaker[Session]

    def get_domain_realm(self, path_info, environ):
        return "Stash"

    def require_authentication(self, realm, environ):
        return True

    def supports_http_digest_auth(self):
        return False

    def basic_auth_user(self, realm, user_name, password, environ):
        with self.session_factory() as db:
            user = validate_webdav_token(db, user_name, password)
            if user is None:
                return False
            environ["stash.user_id"] = user.id
            return True


class UserFilesystemProvider(FilesystemProvider):
    def __init__(self, storage: Storage):
        storage.users_dir.mkdir(parents=True, exist_ok=True)
        super().__init__(str(storage.users_dir), fs_opts={"follow_symlinks": False})
        self.storage = storage

    def _loc_to_file_path(self, path: str, environ: dict | None = None) -> str:
        user_id = environ.get("stash.user_id") if environ else None
        if not isinstance(user_id, int):
            raise DAVError(HTTP_FORBIDDEN, "Authentication required")
        try:
            return str(self.storage.resolve(user_id, path.strip("/")))
        except StorageError as exc:
            logger.warning(
                "WebDAV path rejected user_id=%s path=%r reason=%s", user_id, path, exc.message
            )
            raise DAVError(HTTP_FORBIDDEN, exc.message) from exc


def make_webdav_app(storage: Storage, session_factory: sessionmaker[Session]) -> WsgiDAVApp:
    class BoundDomainController(TokenDomainController):
        pass

    BoundDomainController.session_factory = session_factory
    return WsgiDAVApp(
        {
            "mount_path": "/dav",
            "provider_mapping": {"/": UserFilesystemProvider(storage)},
            "http_authenticator": {
                "domain_controller": BoundDomainController,
                "accept_basic": True,
                "accept_digest": False,
                "default_to_digest": False,
            },
            "dir_browser": {"enable": False},
            "lock_storage": True,
            "verbose": 1,
        }
    )
