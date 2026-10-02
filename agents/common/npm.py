import re
import subprocess

PACKAGE = re.compile(r"(@[a-z0-9._-]+/)?[a-z0-9._-]+")


def latest_version(package: str) -> dict:
    """Return the latest published version of an npm package.

    Args:
      package: npm package name, for example multer.
    """
    if not PACKAGE.fullmatch(package):
        return {"error": "invalid package name"}
    proc = subprocess.run(
        ["npm", "view", package, "version"],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        return {"error": proc.stderr[-300:]}
    return {"package": package, "latest": proc.stdout.strip()}
