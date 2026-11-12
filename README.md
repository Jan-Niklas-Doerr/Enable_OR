# Food-bank allocation demonstration

This presenter-led demo tells one continuous optimization story across five
stages: frame the food-bank problem, solve a budget-capped allocation, add a
controllable minimum-share rule, then explore route-cost and added-supply
sensitivity in separate tabs. The same network stays visible throughout, with
per-crate route costs and correctly subscripted flow variables on its edges.
Asking the scripted assistant to formulate the Python/Gurobi model reveals the
equations and advances to the baseline tab. After the baseline solve, asking to
introduce fairness opens the fairness tab, where the presenter sets the minimum share.
Model solves and what-if comparisons remain explicit presenter actions.

Run the local server from the `orllmbench` environment, then open
`http://127.0.0.1:8000/`. Do not open `index.html` directly: the browser needs
the local API to ask Gurobi to solve the model.

In VS Code, select `orllmbench` as the workspace Python interpreter. The
environment must have `gurobipy` and a working Gurobi license.

```powershell
conda activate orllmbench
python server.py
```

In another terminal using the same environment:

```powershell
python food_bank_model.py
python food_bank_model.py --fairness 15
python -m unittest discover -s tests -v
```

## Optimization model

The LP defines a continuous non-negative route variable `x_ij` for every hub
and community pair. It maximizes total crates delivered subject to:

- Shipments out of each hub do not exceed its available supply (600 and 400
  crates).
- Deliveries to each community do not exceed its demand (800, 600, and 500
  crates).
- Total route cost does not exceed the illustrative 1,400-unit budget.
- In the fairness stage, every community receives at least the selected
  percentage of **actual total deliveries**.

Route costs are illustrative units, not dollars. The fairness rule is linear:
each community's allocation is constrained to be at least `p` times the sum
of all route variables. Allocations are continuous to support LP sensitivity
analysis.

The CLI and `/api/solve` endpoint return route flows, community totals, budget
use, constraint slacks and shadow prices, allowable RHS ranges, and route
reduced costs. Sensitivity ranges and shadow prices describe the current
optimal LP basis and apply to one constraint RHS change at a time. Fairness
changes several coupled constraints, so the demo re-solves rather than
extrapolating sensitivity values.

The `/api/what-if` endpoint compares fresh Gurobi solves: it reduces each
route's unit cost by a selected percentage, and separately adds a selected
amount of supply at each hub while keeping the budget unchanged. The route-cost
and added-supply tabs visualize delivery changes and community allocations on
the network. Both compare scenarios at the currently selected fairness floor.
The recommended route and hub are determined by the current solve results.

## Conversation and presentation

The conversation is simulated and makes no external LLM calls. Its model
formulation is scripted to match the displayed supplies, demands, costs, and
budget; Gurobi solves that corresponding LP when requested. Allocation and
what-if answers use actual local solver results. This is a staged demonstration,
not arbitrary natural-language-to-model generation. Responses pause briefly,
appear word by word, and remain on screen before presenter-led stage transitions.
The desktop layout scales typography with the viewport and keeps the
conversation beside the network; longer model and sensitivity content can
scroll. Smaller screens use a responsive stacked layout.
