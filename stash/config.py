"""Application configuration."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8080
    data_dir: Path = Path("/data")
    database: Path = Path("/data/stash.db")
    session_lifetime_days: int = 30
    cookie_secure: bool = True
    trusted_proxy_ips: str = "127.0.0.1"

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        data_dir = Path(os.getenv("STASH_DATA_DIR", "/data")).expanduser().absolute()
        return cls(
            host=os.getenv("STASH_HOST", "127.0.0.1"),
            port=int(os.getenv("STASH_PORT", "8080")),
            data_dir=data_dir,
            database=Path(os.getenv("STASH_DATABASE", str(data_dir / "stash.db")))
            .expanduser()
            .absolute(),
            session_lifetime_days=int(os.getenv("STASH_SESSION_LIFETIME_DAYS", "30")),
            cookie_secure=os.getenv("STASH_COOKIE_SECURE", "true").lower() in {"1", "true", "yes"},
            trusted_proxy_ips=os.getenv("STASH_TRUSTED_PROXY_IPS", "127.0.0.1"),
        )
