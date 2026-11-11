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

from food_bank_model import (
    BUDGET,
    FAIRNESS_DEFAULT,
    OptimizationError,
    compare_what_ifs,
    solve,
)


ROOT = Path(__file__).resolve().parent
MAX_REQUEST_BYTES = 4096


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:
        endpoint = urlsplit(self.path).path
        if endpoint not in {"/api/solve", "/api/what-if"}:
            self._send_json(404, {"error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("Request body must be between 1 and 4096 bytes")
            payload = json.loads(self.rfile.read(length))
            allowed = (
                {"fairness_percent"}
                if endpoint == "/api/solve"
                else {
                    "fairness_percent",
                    "budget",
                    "supply_increment",
                    "route_cost_reduction_percent",
                }
            )
            if not isinstance(payload, dict) or set(payload) - allowed:
                raise ValueError(f"Expected an object containing only {', '.join(sorted(allowed))}")

            fairness = payload.get("fairness_percent")
            if endpoint == "/api/what-if" and fairness is None:
                fairness = FAIRNESS_DEFAULT
            if fairness is not None:
                if isinstance(fairness, bool) or not isinstance(fairness, (int, float)):
                    raise ValueError("fairness_percent must be a number")
                try:
                    fairness = float(fairness)
                except OverflowError as error:
                    raise ValueError("fairness_percent must be finite") from error
                if not math.isfinite(fairness):
                    raise ValueError("fairness_percent must be finite")

            if endpoint == "/api/solve":
                result = solve(fairness)
            else:
                budget = self._number(payload, "budget", BUDGET)
                supply_increment = self._number(payload, "supply_increment", 200)
                cost_reduction = self._number(payload, "route_cost_reduction_percent", 25)
                result = compare_what_ifs(fairness, budget, supply_increment, cost_reduction)
            self._send_json(200, result)
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

    @staticmethod
    def _number(payload: dict[str, Any], key: str, default: float) -> float:
        value = payload.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{key} must be a number")
        try:
            value = float(value)
        except OverflowError as error:
            raise ValueError(f"{key} must be finite") from error
        if not math.isfinite(value):
            raise ValueError(f"{key} must be finite")
        return value

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
