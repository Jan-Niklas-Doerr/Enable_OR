"""Serve the presentation and its local Gurobi solve endpoint."""

from __future__ import annotations

import argparse
import json
import logging
import math
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import gurobipy as gp

from food_bank_model import OptimizationError, solve


ROOT = Path(__file__).resolve().parent
MAX_REQUEST_BYTES = 4096


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/solve":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("Request body must be between 1 and 4096 bytes")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or set(payload) - {"fairness_percent"}:
                raise ValueError("Expected an object with an optional fairness_percent")

            fairness = payload.get("fairness_percent")
            if fairness is not None:
                if isinstance(fairness, bool) or not isinstance(fairness, (int, float)):
                    raise ValueError("fairness_percent must be a number")
                try:
                    fairness = float(fairness)
                except OverflowError as error:
                    raise ValueError("fairness_percent must be finite") from error
                if not math.isfinite(fairness):
                    raise ValueError("fairness_percent must be finite")

            self._send_json(200, solve(fairness))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self._send_json(400, {"error": str(error)})
        except OptimizationError as error:
            self._send_json(422, {"error": str(error)})
        except gp.GurobiError:
            logging.exception("Gurobi failed to solve the allocation model")
            self._send_json(503, {"error": "Gurobi could not solve the model"})
        except Exception:
            logging.exception("Unexpected error solving the allocation model")
            self._send_json(500, {"error": "Unexpected solver error"})

    def _send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    with HTTPServer((args.host, args.port), DemoHandler) as server:
        print(f"Presentation available at http://{args.host}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping presentation server.")


if __name__ == "__main__":
    main()
