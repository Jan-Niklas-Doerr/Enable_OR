# Food-bank allocation demonstration

Run the local server from the `orllmbench` environment, then open
`http://127.0.0.1:8000/`. Do not open `index.html` directly: the browser needs
the local API to ask Gurobi to solve the model.

In VS Code, select `orllmbench` as the workspace Python interpreter. Alternatively,
activate it in a terminal before running the commands below.

## Gurobi model

`server.py` serves the presentation and its same-origin `/api/solve` endpoint.
The endpoint calls `food_bank_model.py` in the server's Python process; no
additional web framework or service is required. Bindings default to localhost.
Select the existing `orllmbench` environment, which must have `gurobipy` and a
working Gurobi license, before starting the server.

From the repository root:

```powershell
conda activate orllmbench
python server.py
```

In another terminal using the same environment:

```powershell
python food_bank_model.py
python food_bank_model.py --fairness 25
python -m unittest discover -s tests -v
```

The commands print a JSON solution: the cost, flows on all six routes, totals
per community, and each constraint's slack, shadow price, and allowable
right-hand-side range. A `null` range endpoint means the bound is infinite.
Sensitivity ranges and shadow prices describe the optimal LP basis and apply
to a change in **one constraint's right-hand side at a time**. Changing the
fairness slider changes three right-hand sides simultaneously, so re-solve
the model rather than extrapolating from an individual range. The model uses
simplex so that a basis is available for sensitivity analysis.

The model shares the demo's supply (600 and 400 crates), community demands
(800, 600, and 500), and six routes. It assumes all available crates must be
shipped; otherwise, minimizing positive delivery costs alone would ship
nothing. Allocations are continuous to support LP sensitivity analysis. The
optional fairness constraint guarantees each community the specified
percentage of the **total supply**, not of its individual demand. Values above
one third are infeasible for the three communities and are reported as solver
errors.

Route costs are illustrative cost units, not measured dollar amounts. The
browser now displays allocations, objective values, and sensitivity data from
the live Gurobi solve. Moving the fairness slider triggers a new solve; a
short debounce avoids needless requests while dragging.

The Q&amp;A drawer is a scripted, rule-based demo, not an LLM integration. It
answers a limited set of topics using the active solver results, with no
external model calls.
