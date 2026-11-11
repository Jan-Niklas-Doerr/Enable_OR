import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

from food_bank_model import COST, DEMAND, SUPPLY, OptimizationError, solve


class FoodBankModelTests(unittest.TestCase):
    def assert_feasible(self, result, fairness_percent=None):
        flows = result["flows"]
        allocations = result["allocations"]
        for hub, supply in SUPPLY.items():
            self.assertAlmostEqual(sum(flows[hub].values()), supply)
        for community, demand in DEMAND.items():
            self.assertAlmostEqual(
                allocations[community], sum(flows[hub][community] for hub in SUPPLY)
            )
            self.assertLessEqual(allocations[community], demand + 1e-6)
            if fairness_percent is not None:
                self.assertGreaterEqual(
                    allocations[community] + 1e-6,
                    sum(SUPPLY.values()) * fairness_percent / 100,
                )
        for hub in SUPPLY:
            for community in DEMAND:
                self.assertGreaterEqual(flows[hub][community], -1e-6)
        self.assertAlmostEqual(
            result["objective_cost"],
            sum(COST[hub, community] * flows[hub][community]
                for hub in SUPPLY for community in DEMAND),
        )

    def test_baseline(self):
        result = solve()
        self.assertEqual(result["status"], "optimal")
        self.assert_feasible(result)
        self.assertAlmostEqual(result["objective_cost"], 1400)
        self.assertAlmostEqual(result["allocations"]["north"], 600)
        self.assertAlmostEqual(result["allocations"]["central"], 400)
        self.assertAlmostEqual(result["allocations"]["south"], 0)
        self.assertNotIn("fairness_south", result["constraints"])

    def test_fairness_changes_optimum_and_exposes_sensitivity(self):
        result = solve(25)
        self.assert_feasible(result, 25)
        self.assertAlmostEqual(result["objective_cost"], 1850)
        self.assertAlmostEqual(result["allocations"]["north"], 500)
        self.assertAlmostEqual(result["allocations"]["central"], 250)
        self.assertAlmostEqual(result["allocations"]["south"], 250)
        constraint = result["constraints"]["fairness_south"]
        self.assertEqual(constraint["sense"], ">")
        self.assertAlmostEqual(constraint["rhs"], 250)
        self.assertIsInstance(constraint["shadow_price"], float)
        self.assertIn("lower", constraint["rhs_range"])
        self.assertIn("upper", constraint["rhs_range"])

    def test_other_presenter_thresholds(self):
        for floor in range(20, 31):
            with self.subTest(floor=floor):
                result = solve(floor)
                self.assert_feasible(result, floor)
                self.assertGreaterEqual(result["objective_cost"], 1400)

    def test_infeasible_floor_is_reported(self):
        with self.assertRaises(OptimizationError):
            solve(34)

    def test_invalid_floors_are_rejected(self):
        for floor in (-1, 101, math.inf, math.nan):
            with self.subTest(floor=floor), self.assertRaises(ValueError):
                solve(floor)

    def test_cli_writes_json(self):
        script = Path(__file__).resolve().parent.parent / "food_bank_model.py"
        result = subprocess.run(
            [sys.executable, str(script), "--fairness", "25"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertAlmostEqual(json.loads(result.stdout)["objective_cost"], 1850)


if __name__ == "__main__":
    unittest.main()
