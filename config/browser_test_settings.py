import tempfile
from pathlib import Path

from .settings import *


BROWSER_TEST_DATA_DIR = Path(tempfile.gettempdir()).resolve() / "closete-browser-test"
DEVELOPMENT_DATABASE_PATH = Path(DATABASES["default"]["NAME"]).resolve()
BROWSER_TEST_DATABASE_PATH = (
    BROWSER_TEST_DATA_DIR / "closete-browser-test.sqlite3"
).resolve()

if BROWSER_TEST_DATABASE_PATH == DEVELOPMENT_DATABASE_PATH:
    raise RuntimeError(
        "Browser-test settings must not use the development database."
    )

DATABASES = {
    **DATABASES,
    "default": {
        **DATABASES["default"],
        "NAME": BROWSER_TEST_DATABASE_PATH,
    },
}
MEDIA_ROOT = BROWSER_TEST_DATA_DIR / "media"
