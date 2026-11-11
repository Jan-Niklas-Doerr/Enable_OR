const stages = [
  {
    kicker: 'THE CHALLENGE',
    title: 'Three communities. One limited supply.',
    description: 'Two food hubs can deliver 1,000 crates to three communities requesting 1,900. Which routes should carry the food?',
    status: 'PROBLEM',
    next: 'Take this problem to the model',
    suggestions: ['How do you model this problem?'],
  },
  {
    kicker: 'THE FIRST SOLVE',
    title: 'Maximize deliveries within the budget.',
    description: 'We have defined a variable for every route. The model is ready; solve only when you are ready to reveal the first allocation.',
    status: 'MODEL READY',
    next: 'Introduce fairness',
    suggestions: ['Why did Southside get nothing?', 'Show me the route flows'],
  },
  {
    kicker: 'ONE NEW REQUIREMENT',
    title: 'What changes when every community gets a share?',
    description: 'Keep the network, available supply, demands, and budget. Add a minimum share of actual deliveries, then re-solve.',
    status: 'FAIRNESS ADDED',
    next: '',
    suggestions: ['Why did total deliveries fall?', 'Would more supply help?', 'Which route-cost cut helps most?'],
  },
];

const stageLinks = [...document.querySelectorAll('.stage-link')];
const fairnessRow = document.getElementById('fairnessRow');
const resultsPanel = document.getElementById('resultsPanel');
const fairnessControl = document.getElementById('fairnessControl');
const slider = document.getElementById('fairnessSlider');
const chatMessages = document.getElementById('chatMessages');
const chatSuggestions = document.getElementById('chatSuggestions');
const network = document.querySelector('.network');
const metricFrames = new WeakMap();
const baselineCache = new Map();
const fairnessCache = new Map();
const whatIfCache = new Map();

let currentStage = 0;
let displayedSolution = null;
let baselineSolution = null;
let solveRequest = 0;
let conversationQueue = Promise.resolve();

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function formatNumber(value, decimals = 0) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function animateMetric(element, target, format) {
  const previousFrame = metricFrames.get(element);
  if (previousFrame) cancelAnimationFrame(previousFrame);

  const initial = Number(element.textContent.replace(/[^\d.-]/g, ''));
  const startingValue = Number.isFinite(initial) ? initial : target;
  const startedAt = performance.now();
  const duration = 500;
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

function renderSolution(solution) {
  displayedSolution = solution;
  const delivered = solution.total_deliveries;
  const shares = Object.fromEntries(
    Object.entries(solution.allocations).map(([community, crates]) => [
      community,
      delivered > 0 ? crates / delivered * 100 : 0,
    ]),
  );

  document.querySelectorAll('[data-bar]').forEach((bar) => {
    bar.style.width = `${shares[bar.dataset.bar]}%`;
  });
  document.querySelectorAll('[data-value]').forEach((value) => {
    const community = value.dataset.value;
    value.textContent = `${shares[community].toFixed(1)}% · ${formatNumber(solution.allocations[community], 1)} crates`;
  });
  document.querySelectorAll('[data-allocation]').forEach((label) => {
    const community = label.dataset.allocation;
    label.textContent = `${formatNumber(solution.allocations[community], 1)} delivered`;
  });
  document.querySelectorAll('[data-supply]').forEach((label) => {
    label.textContent = `Supply ${formatNumber(solution.supply[label.dataset.supply])}`;
  });
  document.querySelectorAll('.route-label').forEach((label) => {
    const [hub, community] = label.dataset.route.split('-');
    const key = `${hub}-${community}`;
    const crates = solution.flows[hub][community];
    label.querySelector('text').textContent =
      `x_${routeNotation[key]} = ${formatNumber(crates, 1)}`;
    label.classList.toggle('has-flow', crates > 1e-6);
    document.querySelector(`[data-route-line="${key}"]`).classList.toggle('has-flow', crates > 1e-6);
  });

  animateMetric(
    document.getElementById('deliveryMetric'),
    delivered,
    (value) => formatNumber(value, 1),
  );
  animateMetric(
    document.getElementById('costMetric'),
    solution.budget_used,
    (value) => formatNumber(value, 1),
  );
  document.getElementById('resultsTitle').textContent = solution.fairness_percent === null
    ? 'Baseline: maximum deliveries'
    : `${formatNumber(solution.fairness_percent)}% fairness-constrained allocation`;
  document.getElementById('networkStatus').textContent = solution.fairness_percent === null
    ? 'BASELINE SOLVED'
    : `${formatNumber(solution.fairness_percent)}% FAIRNESS`;
  document.getElementById('networkStatus').classList.add('is-live');
  document.getElementById('networkStatus').classList.remove('is-error');
  network.classList.add('is-allocated', 'has-solution');
  document.getElementById('solverError').hidden = true;
  resultsPanel.hidden = false;

  const comparisonNote = document.getElementById('comparisonNote');
  if (solution.fairness_percent === null || !baselineSolution) {
    comparisonNote.hidden = true;
  } else {
    const change = solution.total_deliveries - baselineSolution.total_deliveries;
    comparisonNote.hidden = false;
    document.getElementById('comparisonText').textContent =
      `Same 1,400-unit budget. The ${formatNumber(solution.fairness_percent)}% minimum-share rule changes deliveries by ${formatNumber(change, 1)} crates.`;
  }
}

const routeNotation = {
  'north_hub-north': 'NN',
  'north_hub-central': 'NC',
  'north_hub-south': 'NS',
  'south_hub-north': 'SN',
  'south_hub-central': 'SC',
  'south_hub-south': 'SS',
};

function renderSuggestions(questions) {
  chatSuggestions.replaceChildren();
  questions.forEach((question) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.question = question;
    button.textContent = question;
    button.addEventListener('click', () => askModel(question));
    chatSuggestions.append(button);
  });
}

function addChatMessage(text, role) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}-message`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

function addConversationTurn(question, answer) {
  conversationQueue = conversationQueue.then(async () => {
    await wait(180);
    addChatMessage(question, 'user');
    await wait(220);
    addChatMessage(answer, 'assistant');
  });
  return conversationQueue;
}

function setStageStatus(text) {
  document.getElementById('solveStatus').textContent = text;
}

function renderStage(stage) {
  currentStage = Math.max(0, Math.min(stages.length - 1, stage));
  solveRequest += 1;
  const content = stages[currentStage];
  document.getElementById('stageKicker').innerHTML =
    `${content.kicker} <span>0${currentStage + 1} / 03</span>`;
  document.getElementById('stageTitle').textContent = content.title;
  document.getElementById('stageDescription').textContent = content.description;
  document.getElementById('modelHeading').textContent =
    currentStage === 0 ? 'Problem statement' : 'The optimization model';
  document.getElementById('progressFill').style.width = `${currentStage * 50}%`;
  document.getElementById('backButton').disabled = currentStage === 0;
  document.getElementById('nextButton').hidden = currentStage === stages.length - 1;
  document.getElementById('nextLabel').textContent = content.next;
  document.getElementById('presenterHint').textContent = currentStage === 2
    ? 'Presenter controlled · change the rule, then re-solve'
    : 'Presenter controlled · advance when ready';
  stageLinks.forEach((link, index) => {
    link.classList.toggle('is-active', index === currentStage);
    link.classList.toggle('is-complete', index < currentStage);
    if (index === currentStage) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });

  document.getElementById('problemPanel').hidden = currentStage !== 0;
  document.getElementById('modelPanel').hidden = currentStage === 0;
  fairnessRow.hidden = currentStage !== 2;
  fairnessControl.hidden = currentStage !== 2;
  network.classList.toggle('model-visible', currentStage > 0);
  document.getElementById('solverError').hidden = true;
  document.getElementById('solveButton').hidden = currentStage !== 1;
  document.getElementById('fairnessSolveButton').hidden = currentStage !== 2;
  document.getElementById('solveButton').disabled = false;
  document.getElementById('fairnessSolveButton').disabled = false;

  if (currentStage === 0) {
    document.getElementById('networkStatus').textContent = 'PROBLEM';
    document.getElementById('networkStatus').classList.remove('is-live', 'is-error');
    network.classList.remove('is-allocated', 'has-solution');
    resultsPanel.hidden = true;
    displayedSolution = null;
  } else if (currentStage === 1) {
    const cached = baselineCache.get('baseline');
    if (cached) renderSolution(cached);
    else {
      resultsPanel.hidden = true;
      displayedSolution = null;
      document.getElementById('networkStatus').textContent = 'MODEL READY';
      document.getElementById('networkStatus').classList.remove('is-live', 'is-error');
      setStageStatus('Ready when you are. Review each route variable above.');
    }
  } else {
    const floor = Number(slider.value);
    document.getElementById('constraintThreshold').textContent = `${floor}%`;
    const cached = fairnessCache.get(floor);
    if (cached) renderSolution(cached);
    else {
      resultsPanel.hidden = true;
      displayedSolution = baselineSolution;
      document.getElementById('networkStatus').textContent = 'FAIRNESS ADDED';
      document.getElementById('networkStatus').classList.remove('is-error');
      network.classList.add('is-live');
      setStageStatus(`New ${floor}% rule inserted. Press Re-solve to see its effect.`);
    }
  }
  renderSuggestions(content.suggestions);

  if (currentStage === 1 && !baselineCache.has('baseline')) {
    addConversationTurn(
      'Can you translate this story into a decision model?',
      'Yes. I’ll choose a flow xᵢⱼ on each route, maximize total crates delivered, and respect supply, demand, and the 1,400-unit budget.',
    );
  }
  if (currentStage === 2) {
    addConversationTurn(
      `What if every community must receive at least ${slider.value}% of deliveries?`,
      'I’ve inserted that as one new constraint. The routes, budget, and objective stay the same; re-solve when you are ready to compare.',
    );
  }
}

async function requestSolution(fairnessPercent) {
  const cache = fairnessPercent === null ? baselineCache : fairnessCache;
  const key = fairnessPercent === null ? 'baseline' : fairnessPercent;
  if (cache.has(key)) return cache.get(key);

  const response = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fairnessPercent === null ? {} : { fairness_percent: fairnessPercent }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Solver request failed (${response.status})`);
  cache.set(key, result);
  return result;
}

async function solveCurrentModel(fairnessPercent) {
  const requestId = ++solveRequest;
  const button = fairnessPercent === null
    ? document.getElementById('solveButton')
    : document.getElementById('fairnessSolveButton');
  const status = document.getElementById('networkStatus');
  const statusText = fairnessPercent === null ? 'SOLVING BASELINE…' : 'RE-SOLVING…';
  button.disabled = true;
  status.textContent = statusText;
  status.classList.add('is-live');
  status.classList.remove('is-error');
  setStageStatus('Gurobi is solving the allocation…');
  document.getElementById('solverError').hidden = true;
  if (fairnessPercent === null) baselineCache.delete('baseline');
  else fairnessCache.delete(fairnessPercent);

  try {
    await wait(450);
    const solution = await requestSolution(fairnessPercent);
    if (requestId !== solveRequest) return;
    if (fairnessPercent === null) baselineSolution = solution;
    else baselineSolution = await requestSolution(null);
    if (requestId !== solveRequest) return;
    renderSolution(solution);
    setStageStatus('Optimal solution found. Explore the routes or ask a question.');
  } catch (error) {
    if (requestId !== solveRequest) return;
    status.textContent = 'SOLVER ERROR';
    status.classList.add('is-error');
    document.getElementById('solverError').textContent =
      `Could not solve the model: ${error.message}. Check that the local server uses the configured Gurobi environment.`;
    document.getElementById('solverError').hidden = false;
    setStageStatus('The solve failed. Correct the issue and try again.');
  } finally {
    if (requestId === solveRequest) button.disabled = false;
  }
}

async function requestWhatIf(fairnessPercent) {
  if (whatIfCache.has(fairnessPercent)) return whatIfCache.get(fairnessPercent);
  const response = await fetch('/api/what-if', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fairness_percent: fairnessPercent, budget: displayedSolution.budget }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Scenario request failed (${response.status})`);
  whatIfCache.set(fairnessPercent, result);
  return result;
}

function matchRequestedRoute(question, scenarios) {
  const text = question.toLowerCase();
  const destination = text.match(/\b(?:to|toward|into)\s+(northside|north|central|southside|south)\b/);
  const namedCommunity = text.match(/\b(northside|central|southside)\b/);
  let community = destination?.[1] || namedCommunity?.[1] || null;
  if (community === 'northside') community = 'north';
  if (community === 'southside') community = 'south';
  if (!community && /\bnorth\b/.test(text) && !/\bnorth hub\b/.test(text)) community = 'north';
  if (!community && /\bsouth\b/.test(text) && !/\bsouth hub\b/.test(text)) community = 'south';
  if (!community && /\bcentral\b/.test(text)) community = 'central';
  const hub = /north hub/.test(text)
    ? 'north_hub'
    : /south hub/.test(text)
      ? 'south_hub'
      : null;
  if (!community) return null;
  if (hub) return scenarios.find((item) => item.hub === hub && item.community === community) || null;
  if (/route|arc|from|to|cost/.test(text)) {
    return scenarios.find((item) => item.community === community) || null;
  }
  return null;
}

async function answerModelQuestion(question) {
  const text = question.toLowerCase();
  if (currentStage === 0) {
    return 'There are 6 possible routes. I’ll create one decision variable per route, then choose flows that respect each hub’s supply, each community’s demand, and the shared budget.';
  }
  if (currentStage === 1 && !baselineSolution) {
    return 'The full model is ready, but it has not been solved yet. Press “Solve baseline” and I can explain the resulting allocation.';
  }
  if (currentStage === 2 && (
    !displayedSolution || displayedSolution.fairness_percent !== Number(slider.value)
  )) {
    return 'The fairness rule has changed, but this allocation is from the previous solve. Press “Re-solve” first so I can compare the current results.';
  }

  const result = currentStage === 1 ? baselineSolution : displayedSolution;
  if (currentStage === 2 && /more supply|additional supply|which hub|supply help/.test(text)) {
    const scenarios = await requestWhatIf(result.fairness_percent);
    const best = scenarios.best_hub;
    const other = scenarios.hub_supply_scenarios.find((item) => item.hub !== best.hub);
    if (best.delivery_change < 1e-6 && other.delivery_change < 1e-6) {
      return `With the current ${formatNumber(result.fairness_percent)}% floor and 1,400-unit budget, adding ${formatNumber(best.supply_increase)} crates at either hub does not increase deliveries. The budget—not supply—is limiting this solution.`;
    }
    const otherName = other.hub === 'north_hub' ? 'North Hub' : 'South Hub';
    const bestName = best.hub === 'north_hub' ? 'North Hub' : 'South Hub';
    return `I re-solved both cases with ${formatNumber(best.supply_increase)} extra crates at one hub and the same budget. ${bestName} adds ${formatNumber(best.delivery_change, 1)} deliveries; ${otherName} adds ${formatNumber(other.delivery_change, 1)}. ${bestName} is the better supply investment here.`;
  }

  if (currentStage === 2 && /cost|route|arc|cheaper|reduce/.test(text)) {
    const scenarios = await requestWhatIf(result.fairness_percent);
    const requested = matchRequestedRoute(text, scenarios.route_scenarios);
    const best = requested || scenarios.best_route;
    const routeName = `${best.hub === 'north_hub' ? 'North Hub' : 'South Hub'} to ${best.community[0].toUpperCase()}${best.community.slice(1)}`;
    const routeLabel = requested ? routeName : `the ${routeName} route`;
    if (best.delivery_change > 1e-6) {
      return `A 25% cost cut on ${routeLabel} raises deliveries by ${formatNumber(best.delivery_change, 1)} crates under the same budget. This is a fresh Gurobi solve, not a shadow-price estimate.`;
    }
    return `A 25% cost cut on ${routeLabel} does not increase deliveries in this scenario. The model re-optimizes all route flows, so the effect depends on the full network.`;
  }

  if (/why.*south|south.*nothing|southside/.test(text)) {
    const south = result.allocations.south;
    if (result.fairness_percent === null) {
      return `The budget is fully used on Northside and Central, where the selected routes deliver more crates per cost unit. Without a fairness rule, the solver has no reason to spend the budget reaching Southside.`;
    }
    return `Southside receives ${formatNumber(south, 1)} crates, or ${(south / result.total_deliveries * 100).toFixed(1)}% of deliveries. The ${formatNumber(result.fairness_percent)}% rule guarantees at least ${formatNumber(result.total_deliveries * result.fairness_percent / 100, 1)} crates.`;
  }

  if (/why.*deliver|deliveries fall|less food|less.*crate|decrease/.test(text)) {
    if (result.fairness_percent === null) {
      return `The baseline delivers ${formatNumber(result.total_deliveries)} crates within the 1,400-unit budget. The budget is fully spent.`;
    }
    const change = result.total_deliveries - baselineSolution.total_deliveries;
    return `Deliveries move from ${formatNumber(baselineSolution.total_deliveries)} to ${formatNumber(result.total_deliveries, 1)} (${formatNumber(change, 1)} crates). The same budget now has to cover routes that protect every community’s minimum share, including more expensive routes.`;
  }

  if (/fair|minimum share|guarantee|constraint/.test(text)) {
    const floor = result.fairness_percent;
    if (floor === null) {
      return 'The baseline has supply, demand, and budget limits. The next step adds a fairness floor while keeping the same objective and network.';
    }
    const minimum = result.total_deliveries * floor / 100;
    return `Each community must receive at least ${formatNumber(floor)}% of actual deliveries—${formatNumber(minimum, 1)} crates at this solution. The floor is linked to total flow, not to the 1,000 crates available.`;
  }

  if (/route|flow|ship|allocation|share|why/.test(text)) {
    const routes = Object.entries(result.flows)
      .flatMap(([hub, destinations]) => Object.entries(destinations)
        .filter(([, crates]) => crates > 1e-6)
        .map(([community, crates]) =>
          `${hub === 'north_hub' ? 'North Hub' : 'South Hub'} → ${community}: ${formatNumber(crates, 1)}`));
    return `Gurobi delivers ${formatNumber(result.total_deliveries, 1)} crates for ${formatNumber(result.budget_used, 1)} cost units. Active routes: ${routes.join('; ')}.`;
  }

  if (/cost|budget/.test(text)) {
    return `The model spends ${formatNumber(result.budget_used, 1)} of the 1,400 illustrative cost units. These route costs are not measured dollars.`;
  }
  return 'I can explain the allocation, route flows, budget, fairness rule, or a solver-based what-if scenario.';
}

async function askModel(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  conversationQueue = conversationQueue.then(async () => {
    addChatMessage(trimmed, 'user');
    const thinking = addChatMessage('Let me check the current model…', 'thinking');
    try {
      const answer = await answerModelQuestion(trimmed);
      await wait(180);
      thinking.remove();
      addChatMessage(answer, 'assistant');
    } catch (error) {
      thinking.remove();
      addChatMessage(`I could not complete that comparison: ${error.message}`, 'assistant');
    }
  });
  return conversationQueue;
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
document.getElementById('solveButton').addEventListener('click', () => {
  if (currentStage === 1) solveCurrentModel(null);
});
document.getElementById('fairnessSolveButton').addEventListener('click', () => {
  if (currentStage === 2) solveCurrentModel(Number(slider.value));
});
slider.addEventListener('input', () => {
  solveRequest += 1;
  const floor = Number(slider.value);
  document.getElementById('fairnessOutput').value = `${floor}%`;
  document.getElementById('constraintThreshold').textContent = `${floor}%`;
  document.getElementById('fairnessSolveButton').disabled = false;
  if (currentStage === 2) {
    setStageStatus(`Rule changed to ${floor}%. Press Re-solve to update the allocation.`);
    document.getElementById('networkStatus').textContent = 'RE-SOLVE READY';
    document.getElementById('networkStatus').classList.remove('is-error');
  }
});
document.getElementById('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  askModel(input.value);
  input.value = '';
  input.focus();
});

renderSuggestions(stages[0].suggestions);
renderStage(0);
addConversationTurn(
  'We have more need than food. Where should we start?',
  'Let’s map the two hubs, the three communities, their supply and demand, and the cost of each possible route.',
);
