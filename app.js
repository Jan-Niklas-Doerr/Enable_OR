const stages = [
  {
    kicker: 'THE CHALLENGE',
    title: 'Three communities. One limited supply.',
    description: 'Food arrives at two distribution hubs. Each community has a different need—and every mile costs money.',
    insight: 'Every route and demand is visible. The question is what “best” should mean.',
    detail: 'With 1,000 crates available and 1,900 requested, the model has to choose how to share what is scarce.',
  },
  {
    kicker: 'THE FIRST ANSWER',
    title: 'The cheapest plan leaves a gap.',
    description: 'The original model minimizes delivery cost. It serves every area, but Southside receives the smallest share.',
    insight: 'The model did exactly what we asked: minimize cost. It had no reason to prioritize an even share.',
    detail: 'The lowest-cost allocation can leave a community underserved.',
  },
  {
    kicker: 'THE MODEL CHANGES',
    title: 'Add one constraint. See the decision change.',
    description: 'Keep the same routes, supply, and objective. Now guarantee every community a minimum share.',
    insight: 'Only one line changed. The original objective and supply limits stay in place; the new floor redistributes the same crates.',
    detail: 'Any crates above the floor still follow the original cost preference, so the minimum is protected without forcing equal shares.',
  },
];

const stageLinks = [...document.querySelectorAll('.stage-link')];
const fairnessRow = document.getElementById('fairnessRow');
const resultsPanel = document.getElementById('resultsPanel');
const fairnessControl = document.getElementById('fairnessControl');
const slider = document.getElementById('fairnessSlider');
const insightText = document.getElementById('insightText');
const cachedSolutions = new Map();
let currentStage = 0;
let insightExpanded = false;
let displayedSolution = null;
let baselineSolution = null;
let solveRequest = 0;
let sliderTimer;
const metricFrames = new WeakMap();

function formatNumber(value, decimals = 0) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function renderAllocations(solution) {
  displayedSolution = solution;
  const shares = Object.fromEntries(
    Object.entries(solution.allocations).map(([community, crates]) => [
      community,
      (crates / solution.total_supply) * 100,
    ]),
  );
  document.querySelectorAll('[data-bar]').forEach((bar) => {
    const share = shares[bar.dataset.bar];
    bar.style.width = `${share}%`;
  });
  document.querySelectorAll('[data-value]').forEach((value) => {
    const community = value.dataset.value;
    value.textContent = `${shares[community].toFixed(1)}% · ${formatNumber(solution.allocations[community])} crates`;
  });
  document.querySelectorAll('[data-allocation]').forEach((label) => {
    label.textContent = `${formatNumber(solution.allocations[label.dataset.allocation])} crates`;
  });

  const leastServed = Math.min(...Object.values(shares));
  const baselineCost = baselineSolution ? baselineSolution.objective_cost : solution.objective_cost;
  const hasFairness = solution.fairness_percent !== null;
  animateMetric(document.getElementById('costMetric'), solution.objective_cost, formatNumber);
  animateMetric(document.getElementById('serviceMetric'), leastServed, (value) => `${value.toFixed(1)}%`);
  document.getElementById('resultsTitle').textContent = hasFairness
    ? 'Fairness-constrained allocation'
    : 'Original cost-optimal allocation';
  document.getElementById('networkStatus').textContent = solution.fairness_percent === null
    ? 'COST-OPTIMAL'
    : `${formatNumber(solution.fairness_percent)}% FAIRNESS`;
  document.getElementById('networkStatus').classList.add('is-live');
  document.querySelector('.network').classList.add('is-allocated');
  document.getElementById('comparisonNote').hidden = !hasFairness;
  if (hasFairness) {
    const additionalCost = solution.objective_cost - baselineCost;
    document.getElementById('comparisonText').textContent =
      `Same ${formatNumber(solution.total_supply)} crates. The ${formatNumber(solution.fairness_percent)}% floor adds ${formatNumber(additionalCost)} cost units vs. the original plan.`;
  }
}

function animateMetric(element, target, format) {
  const previousFrame = metricFrames.get(element);
  if (previousFrame) cancelAnimationFrame(previousFrame);

  const initial = Number(element.textContent.replace(/[^\d.-]/g, ''));
  const startingValue = Number.isFinite(initial) ? initial : target;
  const startedAt = performance.now();
  const duration = 450;
  element.classList.remove('metric-changed');
  void element.offsetWidth;
  element.classList.add('metric-changed');

  function update(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(startingValue + (target - startingValue) * eased);
    if (progress < 1) {
      metricFrames.set(element, requestAnimationFrame(update));
    } else {
      metricFrames.delete(element);
      element.classList.remove('metric-changed');
    }
  }

  metricFrames.set(element, requestAnimationFrame(update));
}

function renderStage(stage) {
  currentStage = Math.max(0, Math.min(stages.length - 1, stage));
  window.clearTimeout(sliderTimer);
  const content = stages[currentStage];
  document.getElementById('stageKicker').innerHTML = `${content.kicker} <span>0${currentStage + 1} / 03</span>`;
  document.getElementById('stageTitle').textContent = content.title;
  document.getElementById('stageDescription').textContent = content.description;
  document.getElementById('modelHeading').textContent = currentStage === 2
    ? 'Same model. New requirement.'
    : 'Optimization model';
  stageLinks.forEach((link, index) => {
    link.classList.toggle('is-active', index === currentStage);
    link.classList.toggle('is-complete', index < currentStage);
    if (index === currentStage) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });
  document.getElementById('progressFill').style.width = `${currentStage * 50}%`;
  document.getElementById('backButton').disabled = currentStage === 0;
  document.getElementById('nextButton').hidden = currentStage === stages.length - 1;
  document.getElementById('nextLabel').textContent = currentStage === 0
    ? 'Reveal the first answer'
    : 'Add the fairness requirement';
  document.getElementById('presenterHint').textContent = currentStage === 2
    ? 'Presenter controlled · adjust the fairness floor'
    : 'Presenter controlled · advance when ready';
  insightText.textContent = content.insight;

  const hasResults = currentStage > 0;
  resultsPanel.hidden = !hasResults;
  fairnessRow.hidden = currentStage !== 2;
  fairnessControl.hidden = currentStage !== 2;
  document.getElementById('solverError').hidden = true;
  document.getElementById('modelInsight').classList.remove('is-expanded');
  insightExpanded = false;
  document.getElementById('insightButton').innerHTML = 'A model note <span aria-hidden="true">+</span>';

  if (currentStage === 0) {
    solveRequest += 1;
    displayedSolution = null;
    document.querySelector('.network').classList.remove('is-allocated');
    document.getElementById('networkStatus').textContent = 'DEMAND';
    document.getElementById('networkStatus').classList.remove('is-live');
    document.getElementById('networkStatus').classList.remove('is-error');
  } else {
    loadCurrentSolution();
  }
}

async function requestSolution(fairnessPercent) {
  const key = fairnessPercent === null ? 'baseline' : `fairness-${fairnessPercent}`;
  if (cachedSolutions.has(key)) return cachedSolutions.get(key);

  const body = fairnessPercent === null ? {} : { fairness_percent: fairnessPercent };
  const pending = fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Solver request failed (${response.status})`);
    return result;
  });
  cachedSolutions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    cachedSolutions.delete(key);
    throw error;
  }
}

async function loadCurrentSolution() {
  const requestId = ++solveRequest;
  const stage = currentStage;
  const floor = stage === 2 ? Number(slider.value) : null;
  const status = document.getElementById('networkStatus');
  const errorMessage = document.getElementById('solverError');
  status.textContent = 'SOLVING…';
  status.classList.remove('is-error');
  status.classList.add('is-live');
  errorMessage.hidden = true;
  try {
    baselineSolution = await requestSolution(null);
    const solution = floor === null ? baselineSolution : await requestSolution(floor);
    if (requestId !== solveRequest) return;
    renderAllocations(solution);
  } catch (error) {
    if (requestId !== solveRequest) return;
    status.textContent = 'SOLVER ERROR';
    status.classList.add('is-error');
    errorMessage.textContent = `Could not solve the model: ${error.message}. Start the demo with the configured Gurobi environment.`;
    errorMessage.hidden = false;
  }
}

function updateFairnessControl() {
  const floor = Number(slider.value);
  document.getElementById('fairnessOutput').value = `${floor}%`;
  document.getElementById('constraintThreshold').textContent = `${floor}%`;
  if (currentStage !== 2) return;
  const status = document.getElementById('networkStatus');
  status.textContent = 'UPDATING…';
  status.classList.remove('is-error');
  status.classList.add('is-live');
  window.clearTimeout(sliderTimer);
  sliderTimer = window.setTimeout(loadCurrentSolution, 140);
}

document.getElementById('nextButton').addEventListener('click', () => {
  renderStage(currentStage + 1);
});
document.getElementById('backButton').addEventListener('click', () => {
  renderStage(currentStage - 1);
});
stageLinks.forEach((link) => {
  link.addEventListener('click', () => renderStage(Number(link.dataset.stage)));
});
slider.addEventListener('input', updateFairnessControl);
document.getElementById('insightButton').addEventListener('click', (event) => {
  insightExpanded = !insightExpanded;
  document.getElementById('modelInsight').classList.toggle('is-expanded', insightExpanded);
  const stage = stages[currentStage];
  const detail = currentStage === 2
    ? `At a ${slider.value}% floor, any crates above the minimum still follow the original cost preference.`
    : currentStage === 1 && displayedSolution
      ? `The solver assigned ${formatNumber(displayedSolution.allocations.south)} crates to Southside; it minimizes route cost without a minimum-share rule.`
      : stage.detail;
  insightText.textContent = insightExpanded
    ? `${stage.insight} ${detail}`
    : stage.insight;
  event.currentTarget.innerHTML = insightExpanded
    ? 'Less context <span aria-hidden="true">−</span>'
    : 'A model note <span aria-hidden="true">+</span>';
});

function addChatMessage(text, role) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}-message`;
  message.textContent = text;
  document.getElementById('chatMessages').append(message);
  message.scrollIntoView({ block: 'nearest' });
}

function answerModelQuestion(question) {
  if (currentStage === 0) {
    return 'Reveal the first answer to see a Gurobi result. Then I can answer questions about that allocation.';
  }
  if (!displayedSolution || !baselineSolution) {
    return 'Gurobi is still solving this allocation. Ask again when the result appears.';
  }

  const text = question.toLowerCase();
  const result = displayedSolution;
  if (currentStage === 2 && result.fairness_percent !== Number(slider.value)) {
    return 'Gurobi is solving the updated fairness floor. Ask again when the new result appears.';
  }
  const baselineCost = baselineSolution.objective_cost;
  const addedCost = result.objective_cost - baselineCost;
  const floor = result.fairness_percent;
  const south = result.allocations.south;
  const southShare = (south / result.total_supply) * 100;

  if (/sensitiv|shadow|marginal|rhs range/.test(text)) {
    if (floor === null) {
      return 'The original model has no fairness constraint to analyze. Add the fairness floor to see Gurobi shadow prices and RHS ranges.';
    }
    const community = /south/.test(text)
      ? 'south'
      : /central/.test(text)
        ? 'central'
        : /north/.test(text)
          ? 'north'
          : null;
    const candidates = community
      ? [`fairness_${community}`]
      : ['fairness_north', 'fairness_central', 'fairness_south'];
    const binding = candidates
      .map((key) => ({ key, constraint: result.constraints[key] }))
      .filter(({ constraint }) => constraint && Math.abs(constraint.slack) < 1e-6);
    if (!binding.length) {
      return `At a ${formatNumber(floor)}% floor, none of the queried fairness constraints is binding. Try a higher floor or ask about a specific community.`;
    }
    return binding.map(({ key, constraint }) => {
      const name = key.replace('fairness_', '');
      const range = constraint.rhs_range;
      const lower = range.lower === null ? '−∞' : formatNumber(range.lower);
      const upper = range.upper === null ? '+∞' : formatNumber(range.upper);
      return `${name[0].toUpperCase()}${name.slice(1)}: ${formatNumber(constraint.shadow_price, 2)} cost units per additional guaranteed crate. RHS basis range: ${lower}–${upper} crates, changing this constraint alone.`;
    }).join(' ');
  }

  if (/south/.test(text)) {
    const baselineSouth = baselineSolution.allocations.south;
    if (floor === null) {
      return `The cost-minimizing plan sends ${formatNumber(south)} crates (${southShare.toFixed(1)}% of supply) to Southside. There is no minimum-share rule in this solution.`;
    }
    return `Southside receives ${formatNumber(south)} crates (${southShare.toFixed(1)}% of supply), up from ${formatNumber(baselineSouth)} in the original plan. The ${formatNumber(floor)}% floor guarantees ${formatNumber(result.total_supply * floor / 100)} crates.`;
  }

  if (/cost|trade.?off|expensive|price/.test(text)) {
    if (floor === null) {
      return `The baseline optimum costs ${formatNumber(result.objective_cost)} cost units. Route costs are illustrative inputs, not measured dollars.`;
    }
    return `The current optimum costs ${formatNumber(result.objective_cost)} units, ${formatNumber(addedCost)} more than the ${formatNumber(baselineCost)}-unit baseline. These route costs are illustrative, not dollars.`;
  }

  if (/fair|equity|minimum|guarantee|changed|different/.test(text)) {
    if (floor === null) {
      return 'The baseline only minimizes delivery cost. Add the fairness constraint to guarantee each community a minimum share of total supply.';
    }
    return `The model guarantees at least ${formatNumber(floor)}% of the 1,000-crate supply (${formatNumber(result.total_supply * floor / 100)} crates) to every community. Gurobi re-optimizes the same routes and cost objective.`;
  }

  if (/demand|need|short|enough/.test(text)) {
    const unmet = Object.entries(result.demand)
      .map(([community, demand]) => `${community}: ${formatNumber(demand - result.allocations[community])} unmet`)
      .join('; ');
    return `All community demand limits are respected. Unmet demand: ${unmet} crates. Total demand exceeds the available 1,000 crates.`;
  }

  if (/north hub|south hub|route|ship|flow/.test(text)) {
    const flows = Object.entries(result.flows)
      .flatMap(([hub, destinations]) => Object.entries(destinations)
        .filter(([, crates]) => crates > 1e-6)
        .map(([community, crates]) => `${hub.replace('_', ' ')} → ${community}: ${formatNumber(crates)}`));
    return `Positive delivery routes: ${flows.join('; ')} crates. The model uses all available supply.`;
  }

  if (/why|allocation|share/.test(text)) {
    const summary = Object.entries(result.allocations)
      .map(([community, crates]) =>
        `${community}: ${formatNumber(crates)} crates (${((crates / result.total_supply) * 100).toFixed(1)}%)`)
      .join('; ');
    const objective = floor === null
      ? 'This is the lowest-cost plan subject to supply and demand.'
      : `This is the lowest-cost plan subject to the ${formatNumber(floor)}% minimum-share rule.`;
    return `${objective} Current allocation: ${summary}.`;
  }

  return 'I can answer about the current allocation, Southside, demand, route cost, fairness, or Gurobi sensitivity results.';
}

function askModel(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  addChatMessage(trimmed, 'user');
  addChatMessage(answerModelQuestion(trimmed), 'assistant');
}

const chatWindow = document.getElementById('chatWindow');
const chatToggle = document.getElementById('chatToggle');

function toggleChat(open) {
  chatWindow.hidden = !open;
  chatToggle.setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('chatInput').focus();
  else chatToggle.focus();
}

chatToggle.addEventListener('click', () => toggleChat(chatWindow.hidden));
document.getElementById('chatClose').addEventListener('click', () => toggleChat(false));
document.getElementById('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  askModel(input.value);
  input.value = '';
  input.focus();
});
document.querySelectorAll('.chat-suggestions [data-question]').forEach((button) => {
  button.addEventListener('click', () => askModel(button.dataset.question));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !chatWindow.hidden) toggleChat(false);
});

renderStage(0);
