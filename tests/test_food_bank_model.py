import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

from food_bank_model import (
    BUDGET,
    COST,
    DEMAND,
    FAIRNESS_DEFAULT,
    SUPPLY,
    OptimizationError,
    compare_what_ifs,
    solve,
)


class FoodBankModelTests(unittest.TestCase):
    def assert_feasible(self, result, fairness_percent=None, supply_increase=None):
        flows = result["flows"]
        allocations = result["allocations"]
        actual_supply = {
            hub: amount + (supply_increase or {}).get(hub, 0)
            for hub, amount in SUPPLY.items()
        }
        for hub, available in actual_supply.items():
            self.assertLessEqual(sum(flows[hub].values()), available + 1e-6)
        for community, demand in DEMAND.items():
            self.assertAlmostEqual(
                allocations[community], sum(flows[hub][community] for hub in SUPPLY)
            )
            self.assertLessEqual(allocations[community], demand + 1e-6)
            if fairness_percent is not None:
                self.assertGreaterEqual(
                    allocations[community] + 1e-6,
                    result["total_deliveries"] * fairness_percent / 100,
                )
        for hub in SUPPLY:
            for community in DEMAND:
                self.assertGreaterEqual(flows[hub][community], -1e-6)
        self.assertLessEqual(result["budget_used"], result["budget"] + 1e-6)
        self.assertAlmostEqual(
            result["objective_cost"],
            sum(COST[hub, community] * flows[hub][community]
                for hub in SUPPLY for community in DEMAND),
        )
        self.assertAlmostEqual(result["total_deliveries"], sum(allocations.values()))

    def test_baseline_maximizes_deliveries_under_budget(self):
        result = solve()
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["objective"], "maximize_total_deliveries")
        self.assert_feasible(result)
        self.assertAlmostEqual(result["total_deliveries"], 1000)
        self.assertAlmostEqual(result["budget_used"], BUDGET)
        self.assertEqual(result["allocations"], {
            "north": 600.0,
            "central": 400.0,
            "south": 0.0,
        })
        self.assertNotIn("fairness_south", result["constraints"])

    def test_fairness_is_based_on_actual_deliveries_and_changes_optimum(self):
        result = solve(FAIRNESS_DEFAULT)
        self.assert_feasible(result, FAIRNESS_DEFAULT)
        self.assertAlmostEqual(result["total_deliveries"], 930.2325581395)
        self.assertAlmostEqual(result["budget_used"], BUDGET)
        self.assertGreater(result["allocations"]["south"], 0)
        constraint = result["constraints"]["fairness_south"]
        self.assertEqual(constraint["sense"], ">")
        self.assertAlmostEqual(constraint["rhs"], 0)
        self.assertIsInstance(constraint["shadow_price"], float)
        self.assertIn("lower", constraint["rhs_range"])
        self.assertIn("upper", constraint["rhs_range"])

    def test_budget_and_fairness_variants_are_feasible(self):
        for floor in range(0, 31, 5):
            with self.subTest(floor=floor):
                result = solve(floor, budget=1500)
                self.assert_feasible(result, floor)
        result = solve(budget=1000)
        self.assert_feasible(result)
        self.assertLessEqual(result["total_deliveries"], 1000)

    def test_infeasible_zero_budget_is_reported(self):
        with self.assertRaises(ValueError):
            solve(budget=0)

    def test_invalid_floors_and_parameters_are_rejected(self):
        for floor in (-1, 31, math.inf, math.nan):
            with self.subTest(floor=floor), self.assertRaises(ValueError):
                solve(floor)
        with self.assertRaises(ValueError):
            solve(supply_increase={"unknown": 10})
        with self.assertRaises(ValueError):
            solve(route_costs={("north_hub", "north"): 0})

    def test_what_if_compares_hub_supply_and_route_cost_changes(self):
        result = compare_what_ifs(FAIRNESS_DEFAULT)
        self.assert_feasible(result["baseline"], FAIRNESS_DEFAULT)
        self.assertEqual(len(result["route_scenarios"]), len(COST))
        self.assertEqual(len(result["hub_supply_scenarios"]), len(SUPPLY))
        hub_changes = {
            scenario["hub"]: scenario["delivery_change"]
            for scenario in result["hub_supply_scenarios"]
        }
        self.assertGreater(hub_changes["north_hub"], 0)
        self.assertAlmostEqual(hub_changes["south_hub"], 0)
        for scenario in result["hub_supply_scenarios"]:
            self.assertGreaterEqual(scenario["delivery_change"], -1e-6)
            self.assert_feasible(
                {
                    **result["baseline"],
                    "flows": scenario["flows"],
                    "budget_used": scenario["budget_used"],
                    "total_deliveries": scenario["deliveries"],
                    "allocations": {
                        community: sum(
                            scenario["flows"][hub][community] for hub in SUPPLY
                        )
                        for community in DEMAND
                    },
                },
                FAIRNESS_DEFAULT,
                {scenario["hub"]: scenario["supply_increase"]},
            )
        self.assertAlmostEqual(
            result["best_hub"]["delivery_change"],
            max(hub_changes.values()),
        )

    def test_cli_writes_json(self):
        script = Path(__file__).resolve().parent.parent / "food_bank_model.py"
        result = subprocess.run(
            [sys.executable, str(script), "--fairness", str(FAIRNESS_DEFAULT)],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertAlmostEqual(
            json.loads(result.stdout)["total_deliveries"], 930.2325581395
        )


if __name__ == "__main__":
    unittest.main()
