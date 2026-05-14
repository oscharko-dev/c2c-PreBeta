"""Module entrypoint."""

from .config import load_config
from .server import create_configured_server


def main() -> None:
    config = load_config()
    server, _runner = create_configured_server(config)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
