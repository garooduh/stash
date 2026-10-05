"""FastAPI application and WsgiDAV mount."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from asgiref.wsgi import WsgiToAsgi
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text

from stash.api.routes import router
from stash.config import Settings
from stash.database.core import make_engine, make_session_factory
from stash.files.storage import Storage, StorageError
from stash.webdav.server import make_webdav_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)
PACKAGE_DIR = Path(__file__).parent


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    storage = Storage(settings.data_dir)
    storage.users_dir.mkdir(parents=True, exist_ok=True)
    engine = make_engine(settings.database)
    session_factory = make_session_factory(engine)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Stash starting on %s:%s", settings.host, settings.port)
        yield
        logger.info("Stash stopping")
        engine.dispose()

    app = FastAPI(title="Stash", lifespan=lifespan)
    app.state.settings = settings
    app.state.storage = storage
    app.state.session_factory = session_factory
    app.add_exception_handler(
        StorageError,
        lambda request, exc: JSONResponse({"detail": exc.message}, status_code=exc.status),
    )
    app.include_router(router)
    app.mount("/static", StaticFiles(directory=PACKAGE_DIR / "static"), name="static")
    app.mount("/dav", WsgiToAsgi(make_webdav_app(storage, session_factory)))
    templates = Jinja2Templates(directory=PACKAGE_DIR / "templates")

    @app.get("/", response_class=HTMLResponse)
    def index(request: Request):
        return templates.TemplateResponse(request, "index.html")

    @app.get("/health")
    def health():
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1 FROM users LIMIT 1"))
            if not storage.users_dir.is_dir():
                raise RuntimeError("Storage directory unavailable")
        except Exception:
            logger.exception("Health check failed")
            return JSONResponse({"status": "error"}, status_code=503)
        return {"status": "ok"}

    return app
