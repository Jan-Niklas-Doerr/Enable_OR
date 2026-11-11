import json
import threading
import unittest
from http.server import HTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import DemoHandler


class SolveEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), DemoHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post_json(self, path, payload):
        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            try:
                return error.code, json.load(error)
            finally:
                error.close()

    def test_baseline_endpoint_returns_real_solver_result(self):
        status, result = self.post_json("/api/solve", {})
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["allocations"], {
            "north": 600.0,
            "central": 400.0,
            "south": 0.0,
        })

    def test_fairness_endpoint_returns_sensitivity_data(self):
        status, result = self.post_json("/api/solve", {"fairness_percent": 25})
        self.assertEqual(status, 200)
        self.assertEqual(result["allocations"], {
            "north": 500.0,
            "central": 250.0,
            "south": 250.0,
        })
        self.assertEqual(result["objective_cost"], 1850.0)
        self.assertIn("shadow_price", result["constraints"]["fairness_south"])

    def test_infeasible_and_invalid_requests_are_reported(self):
        status, result = self.post_json("/api/solve", {"fairness_percent": 34})
        self.assertEqual(status, 422)
        self.assertIn("optimal solution", result["error"])

        status, result = self.post_json("/api/solve", {"fairness_percent": True})
        self.assertEqual(status, 400)
        self.assertIn("must be a number", result["error"])

    def test_unknown_api_route_is_not_served_as_a_file(self):
        status, result = self.post_json("/api/other", {})
        self.assertEqual(status, 404)
        self.assertEqual(result["error"], "Not found")


if __name__ == "__main__":
    unittest.main()
