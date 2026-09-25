import asyncio
import importlib
import logging
import os
import sys


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )
    agent = importlib.import_module(f"{os.environ['AGENT']}.agent")
    return asyncio.run(agent.main())


if __name__ == "__main__":
    sys.exit(main())
