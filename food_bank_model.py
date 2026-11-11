"""Gurobi allocation model and deterministic what-if comparisons."""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

import gurobipy as gp
from gurobipy import GRB


SUPPLY = {"north_hub": 600, "south_hub": 400}
DEMAND = {"north": 800, "central": 600, "south": 500}
BUDGET = 1400.0
FAIRNESS_DEFAULT = 15.0
FAIRNESS_MIN = 0.0
FAIRNESS_MAX = 30.0
COST = {
    ("north_hub", "north"): 1.0,
    ("north_hub", "central"): 3.0,
    ("north_hub", "south"): 4.0,
    ("south_hub", "north"): 3.0,
    ("south_hub", "central"): 2.0,
    ("south_hub", "south"): 3.0,
}


class OptimizationError(RuntimeError):
    """The solver did not find an optimal allocation."""


def _finite_bound(value: float) -> float | None:
    if abs(value) >= GRB.INFINITY:
        return None
    return value


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


def _validate_inputs(
    fairness_percent: float | None,
    budget: float,
    supply_increase: dict[str, float] | None = None,
    route_costs: dict[tuple[str, str], float] | None = None,
) -> None:
    if not math.isfinite(budget) or budget <= 0:
        raise ValueError("budget must be finite and greater than zero")
    if fairness_percent is not None and (
        not math.isfinite(fairness_percent)
        or not FAIRNESS_MIN <= fairness_percent <= FAIRNESS_MAX
    ):
        raise ValueError(
            f"fairness_percent must be between {FAIRNESS_MIN:g} and {FAIRNESS_MAX:g}"
        )
    if supply_increase:
        if set(supply_increase) - set(SUPPLY):
            raise ValueError("supply_increase contains an unknown hub")
        if any(not math.isfinite(amount) or amount < 0 for amount in supply_increase.values()):
            raise ValueError("supply increases must be finite and non-negative")
    if route_costs:
        if set(route_costs) - set(COST):
            raise ValueError("route_costs contains an unknown route")
        if any(not math.isfinite(value) or value <= 0 for value in route_costs.values()):
            raise ValueError("route costs must be finite and greater than zero")


def solve(
    fairness_percent: float | None = None,
    budget: float = BUDGET,
    supply_increase: dict[str, float] | None = None,
    route_costs: dict[tuple[str, str], float] | None = None,
) -> dict[str, Any]:
    """Maximize total deliveries within a budget, with optional relative fairness.

    The fairness rule guarantees each community at least the requested
    percentage of actual total deliveries, rather than total available supply.
    """
    _validate_inputs(fairness_percent, budget, supply_increase, route_costs)
    supply = {
        hub: amount + (supply_increase or {}).get(hub, 0)
        for hub, amount in SUPPLY.items()
    }
    costs = {route: (route_costs or {}).get(route, base) for route, base in COST.items()}

    with gp.Env(empty=True) as env:
        env.setParam("OutputFlag", 0)
        env.start()
        with gp.Model("food_bank_allocation", env=env) as model:
            model.Params.Method = 1
            flow = model.addVars(SUPPLY, DEMAND, lb=0, vtype=GRB.CONTINUOUS, name="x")
            allocation = {
                community: gp.quicksum(flow[hub, community] for hub in SUPPLY)
                for community in DEMAND
            }
            total_deliveries = gp.quicksum(allocation.values())
            total_cost = gp.quicksum(
                costs[hub, community] * flow[hub, community]
                for hub in SUPPLY for community in DEMAND
            )
            model.setObjective(total_deliveries, GRB.MAXIMIZE)

            constraints: dict[str, gp.Constr] = {}
            for hub, available in supply.items():
                constraints[f"supply_{hub}"] = model.addConstr(
                    gp.quicksum(flow[hub, community] for community in DEMAND) <= available,
                    name=f"supply_{hub}",
                )
            for community, demand in DEMAND.items():
                constraints[f"demand_{community}"] = model.addConstr(
                    allocation[community] <= demand, name=f"demand_{community}"
                )
            constraints["budget"] = model.addConstr(total_cost <= budget, name="budget")

            if fairness_percent is not None:
                share = fairness_percent / 100
                for community in DEMAND:
                    constraints[f"fairness_{community}"] = model.addConstr(
                        allocation[community] >= share * total_deliveries,
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
            total = sum(allocations.values())
            used_budget = sum(
                costs[hub, community] * flows[hub][community]
                for hub in SUPPLY for community in DEMAND
            )
            return {
                "status": "optimal",
                "objective": "maximize_total_deliveries",
                "fairness_percent": fairness_percent,
                "supply": supply,
                "demand": dict(DEMAND),
                "unit_costs": {
                    hub: {community: costs[hub, community] for community in DEMAND}
                    for hub in SUPPLY
                },
                "total_supply": sum(supply.values()),
                "total_demand": sum(DEMAND.values()),
                "total_deliveries": total,
                "budget": budget,
                "budget_used": used_budget,
                "budget_remaining": budget - used_budget,
                "objective_cost": used_budget,
                "flows": flows,
                "allocations": allocations,
                "constraints": {
                    name: _constraint_result(constraint)
                    for name, constraint in constraints.items()
                },
                "route_reduced_costs": {
                    hub: {community: flow[hub, community].RC for community in DEMAND}
                    for hub in SUPPLY
                },
            }


def compare_what_ifs(
    fairness_percent: float,
    budget: float = BUDGET,
    supply_increment: float = 200,
    route_cost_reduction_percent: float = 25,
) -> dict[str, Any]:
    """Compare every route-cost reduction and added supply from each hub."""
    if not math.isfinite(supply_increment) or supply_increment <= 0:
        raise ValueError("supply_increment must be finite and greater than zero")
    if (
        not math.isfinite(route_cost_reduction_percent)
        or not 0 < route_cost_reduction_percent < 100
    ):
        raise ValueError("route_cost_reduction_percent must be between 0 and 100")

    baseline = solve(fairness_percent, budget)
    route_scenarios = []
    for (hub, community), original_cost in COST.items():
        scenario = solve(
            fairness_percent,
            budget,
            route_costs={
                (hub, community): original_cost * (1 - route_cost_reduction_percent / 100)
            },
        )
        route_scenarios.append({
            "type": "route_cost",
            "hub": hub,
            "community": community,
            "original_unit_cost": original_cost,
            "reduced_unit_cost": original_cost * (1 - route_cost_reduction_percent / 100),
            "deliveries": scenario["total_deliveries"],
            "delivery_change": scenario["total_deliveries"] - baseline["total_deliveries"],
            "budget_used": scenario["budget_used"],
            "flows": scenario["flows"],
        })

    supply_scenarios = []
    for hub in SUPPLY:
        scenario = solve(
            fairness_percent,
            budget,
            supply_increase={hub: supply_increment},
        )
        supply_scenarios.append({
            "type": "hub_supply",
            "hub": hub,
            "supply_increase": supply_increment,
            "deliveries": scenario["total_deliveries"],
            "delivery_change": scenario["total_deliveries"] - baseline["total_deliveries"],
            "budget_used": scenario["budget_used"],
            "flows": scenario["flows"],
        })

    return {
        "baseline": baseline,
        "route_cost_reduction_percent": route_cost_reduction_percent,
        "route_scenarios": route_scenarios,
        "hub_supply_scenarios": supply_scenarios,
        "best_route": max(
            route_scenarios,
            key=lambda item: (item["deliveries"], -item["budget_used"]),
        ),
        "best_hub": max(
            supply_scenarios,
            key=lambda item: (item["deliveries"], -item["budget_used"]),
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fairness", type=float)
    parser.add_argument("--budget", type=float, default=BUDGET)
    args = parser.parse_args()
    print(json.dumps(solve(args.fairness, args.budget), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
