"""Gurobi linear program for the food-bank presentation."""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

import gurobipy as gp
from gurobipy import GRB


SUPPLY = {"north_hub": 600, "south_hub": 400}
DEMAND = {"north": 800, "central": 600, "south": 500}

# Illustrative delivery costs per crate, not observed transport costs.
COST = {
    ("north_hub", "north"): 1.0,
    ("north_hub", "central"): 3.0,
    ("north_hub", "south"): 4.0,
    ("south_hub", "north"): 3.0,
    ("south_hub", "central"): 2.0,
    ("south_hub", "south"): 3.0,
}


class OptimizationError(RuntimeError):
    """The solver did not return an optimal solution."""


def _finite_bound(value: float) -> float | None:
    """Represent Gurobi's infinite sensitivity bounds as JSON null."""
    return None if abs(value) >= GRB.INFINITY else value


def _constraint_result(constraint: gp.Constr) -> dict[str, Any]:
    return {
        "sense": constraint.Sense,
        "rhs": constraint.RHS,
        "slack": constraint.Slack,
        "shadow_price": constraint.Pi,
        "rhs_range": {
            "lower": _finite_bound(constraint.SARHSLow),
            "upper": _finite_bound(constraint.SARHSUp),
        },
    }


def solve(fairness_percent: float | None = None) -> dict[str, Any]:
    """Solve the baseline, or guarantee each community a share of total supply.

    The fairness percentage is a percentage of the total available crates,
    not a percentage of each community's demand.
    """
    if fairness_percent is not None and (
        not math.isfinite(fairness_percent)
        or not 0 <= fairness_percent <= 100
    ):
        raise ValueError("fairness_percent must be a finite number between 0 and 100")

    total_supply = sum(SUPPLY.values())
    with gp.Env(empty=True) as env:
        env.setParam("OutputFlag", 0)
        env.start()
        return _solve_with_env(env, fairness_percent, total_supply)


def _solve_with_env(
    env: gp.Env, fairness_percent: float | None, total_supply: int
) -> dict[str, Any]:
    with gp.Model("food_bank_allocation", env=env) as model:
        # A simplex solution supplies the basis required for sensitivity ranges.
        model.Params.Method = 1

        flow = model.addVars(SUPPLY, DEMAND, lb=0, vtype=GRB.CONTINUOUS, name="flow")
        model.setObjective(
            gp.quicksum(COST[hub, community] * flow[hub, community]
                        for hub in SUPPLY for community in DEMAND),
            GRB.MINIMIZE,
        )

        constraints: dict[str, gp.Constr] = {}
        for hub, supply in SUPPLY.items():
            constraints[f"supply_{hub}"] = model.addConstr(
                gp.quicksum(flow[hub, community] for community in DEMAND) == supply,
                name=f"supply_{hub}",
            )
        for community, demand in DEMAND.items():
            allocation = gp.quicksum(flow[hub, community] for hub in SUPPLY)
            constraints[f"demand_{community}"] = model.addConstr(
                allocation <= demand, name=f"demand_{community}"
            )
            if fairness_percent is not None:
                constraints[f"fairness_{community}"] = model.addConstr(
                    allocation >= total_supply * fairness_percent / 100,
                    name=f"fairness_{community}",
                )

        model.optimize()
        if model.Status != GRB.OPTIMAL:
            raise OptimizationError(
                f"Gurobi did not find an optimal solution (status {model.Status})"
            )

        flows = {
            hub: {community: flow[hub, community].X for community in DEMAND}
            for hub in SUPPLY
        }
        allocations = {
            community: sum(flows[hub][community] for hub in SUPPLY)
            for community in DEMAND
        }
        return {
            "status": "optimal",
            "fairness_percent": fairness_percent,
            "supply": dict(SUPPLY),
            "demand": dict(DEMAND),
            "unit_costs": {
                hub: {community: COST[hub, community] for community in DEMAND}
                for hub in SUPPLY
            },
            "total_supply": total_supply,
            "objective_cost": model.ObjVal,
            "flows": flows,
            "allocations": allocations,
            "constraints": {
                name: _constraint_result(constraint)
                for name, constraint in constraints.items()
            },
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fairness",
        type=float,
        metavar="PERCENT",
        help="minimum percentage of total supply allocated to each community",
    )
    args = parser.parse_args()
    result = solve(args.fairness)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
