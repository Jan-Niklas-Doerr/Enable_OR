const stages = [
  {
    kicker: 'THE CHALLENGE',
    chatTitle: 'Ask me to build the model',
    modelHeading: 'Problem statement',
    next: null,
    suggestions: ['Formulate this as a Python optimization model using Gurobi'],
  },
  {
    kicker: 'BASELINE SOLUTION',
    chatTitle: 'Explore the baseline allocation',
    modelHeading: 'The optimization model',
    next: 'Set a minimum share',
    suggestions: ['Why did Southside get nothing?', 'Introduce fairness by setting a minimum share'],
  },
  {
    kicker: 'INTRODUCE FAIRNESS',
    chatTitle: 'Set a minimum share you control',
    modelHeading: 'Add a controllable minimum share',
    next: 'Explore route-cost sensitivity',
    suggestions: [
      'Why did total deliveries change?',
      'What if a route cost 25% less?',
      'Would 200 more crates at a hub help?',
    ],
  },
  {
    kicker: 'SENSITIVITY · ROUTE COST',
    chatTitle: 'Explore a route-cost change',
    modelHeading: 'Route-cost sensitivity',
    next: 'Explore extra supply',
    suggestions: ['What changes if this route costs 25% less?'],
  },
  {
    kicker: 'SENSITIVITY · EXTRA SUPPLY',
    chatTitle: 'Explore an extra-supply change',
    modelHeading: 'Additional-supply sensitivity',
    next: null,
    suggestions: ['Would 200 more crates at a hub increase deliveries?'],
  },
];

const stageLinks = [...document.querySelectorAll('.stage-link')];
const fairnessRow = document.getElementById('fairnessRow');
const fairnessBlock = document.getElementById('fairnessBlock');
const resultsPanel = document.getElementById('resultsPanel');
const fairnessControl = document.getElementById('fairnessControl');
const modelContent = document.getElementById('modelPanel');
const problemPanel = document.getElementById('problemPanel');
const routeScenarioPanel = document.getElementById('routeScenarioPanel');
const supplyScenarioPanel = document.getElementById('supplyScenarioPanel');
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
const stageIntroductions = new Set();

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
    label.querySelector('[data-route-flow-value]').textContent = formatNumber(crates, 1);
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

function renderSuggestions(questions) {
  chatSuggestions.replaceChildren();
  questions.forEach((question) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.question = question;
    button.textContent = question;
    button.addEventListener('click', () => {
      button.remove();
      askModel(question);
    });
    chatSuggestions.append(button);
  });
}

function updateNextButton() {
  const content = stages[currentStage];
  const nextButton = document.getElementById('nextButton');
  const canAdvance = content.next !== null
    && (currentStage !== 1 || baselineSolution !== null)
    && (currentStage !== 2 || fairnessCache.has(Number(slider.value)))
    && (currentStage !== 3 || (
      !document.getElementById('routeScenarioResult').hidden
      && Number(document.getElementById('routeScenarioResult').dataset.floor) === Number(slider.value)
    ));
  nextButton.hidden = !canAdvance;
  document.getElementById('nextLabel').textContent = content.next || '';
}

function renderNetworkAllocation(flows, supply) {
  const allocations = { north: 0, central: 0, south: 0 };
  Object.entries(flows).forEach(([hub, destinations]) => {
    Object.entries(destinations).forEach(([community, crates]) => {
      allocations[community] += crates;
      const key = `${hub}-${community}`;
      const label = document.querySelector(`.route-label[data-route="${key}"]`);
      label.querySelector('[data-route-flow-value]').textContent = formatNumber(crates, 1);
      label.classList.toggle('has-flow', crates > 1e-6);
      document.querySelector(`[data-route-line="${key}"]`).classList.toggle('has-flow', crates > 1e-6);
    });
  });
  Object.entries(allocations).forEach(([community, crates]) => {
    document.querySelector(`[data-allocation="${community}"]`).textContent =
      `${formatNumber(crates, 1)} delivered`;
  });
  if (supply) {
    Object.entries(supply).forEach(([hub, crates]) => {
      document.querySelector(`[data-supply="${hub}"]`).textContent =
        `Supply ${formatNumber(crates)}`;
    });
  }
  network.classList.add('is-allocated', 'has-solution', 'model-visible');
}

function addChatMessage(text, role) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}-message`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

async function addAssistantResponse(text) {
  const message = addChatMessage('', 'assistant');
  message.classList.add('is-typing');
  message.setAttribute('aria-live', 'off');
  const words = text.match(/\S+\s*/g) || [];
  for (const word of words) {
    message.textContent += word;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    await wait(70);
  }
  message.classList.remove('is-typing');
  message.setAttribute('aria-live', 'polite');
}

function addConversationTurn(question, answer) {
  conversationQueue = conversationQueue.then(async () => {
    await wait(180);
    addChatMessage(question, 'user');
    await wait(1800);
    await addAssistantResponse(answer);
  });
  return conversationQueue;
}

function setStageStatus(text) {
  document.getElementById('solveStatus').textContent = text;
  document.getElementById('fairnessStatus').textContent = text;
}

function updateFairnessLabels() {
  const floor = Number(slider.value);
  document.getElementById('fairnessOutput').value = `${floor}%`;
  document.getElementById('constraintThreshold').textContent = `${floor}%`;
  document.querySelectorAll('[data-current-floor]').forEach((label) => {
    label.textContent = `${floor}%`;
  });
}

function renderStage(stage, includeStageDialogue = true) {
  currentStage = Math.max(0, Math.min(stages.length - 1, stage));
  solveRequest += 1;
  const content = stages[currentStage];
  document.querySelector('.story-shell').dataset.stage = currentStage;
  document.getElementById('stageKicker').innerHTML =
    `${content.kicker} · 0${currentStage + 1} / 05`;
  document.getElementById('chatTitle').textContent = content.chatTitle;
  document.getElementById('modelHeading').textContent = content.modelHeading;
  document.getElementById('modelStageNote').textContent =
    currentStage === 2
      ? 'Only change from baseline: the minimum-share constraint.'
      : currentStage >= 3
        ? `Compare a new solve using the selected ${slider.value}% fairness floor.`
        : '';
  document.getElementById('progressFill').style.width = `${currentStage * 25}%`;
  document.getElementById('backButton').disabled = currentStage === 0;
  document.getElementById('presenterHint').textContent = currentStage === 2
    ? 'Set the minimum share, then solve when ready'
    : currentStage >= 3
      ? `What-if scenarios use the selected ${slider.value}% fairness floor`
      : 'Presenter controlled · advance when ready';
  stageLinks.forEach((link, index) => {
    link.classList.toggle('is-active', index === currentStage);
    link.classList.toggle('is-complete', index < currentStage);
    if (index === currentStage) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });

  problemPanel.hidden = currentStage !== 0;
  modelContent.hidden = currentStage === 0 || currentStage >= 3;
  routeScenarioPanel.hidden = currentStage !== 3;
  supplyScenarioPanel.hidden = currentStage !== 4;
  fairnessBlock.hidden = currentStage !== 2;
  fairnessRow.hidden = currentStage !== 2;
  fairnessControl.hidden = currentStage < 2;
  network.classList.toggle('model-visible', currentStage > 0);
  document.getElementById('solverError').hidden = true;
  document.getElementById('solveButton').hidden = currentStage !== 1;
  document.getElementById('fairnessSolveButton').hidden = currentStage !== 2;
  document.getElementById('solveButton').disabled = false;
  document.getElementById('fairnessSolveButton').disabled = false;
  updateFairnessLabels();
  updateNextButton();

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
  } else if (currentStage === 2) {
    const floor = Number(slider.value);
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
  } else {
    resultsPanel.hidden = true;
    const floor = Number(slider.value);
    const scenarios = whatIfCache.get(floor);
    const solution = fairnessCache.get(floor) || scenarios?.baseline || baselineSolution;
    if (solution) renderNetworkAllocation(solution.flows, solution.supply);
    document.getElementById('networkStatus').textContent =
      scenarios ? 'SCENARIO READY' : `${floor}% FAIRNESS`;
    document.getElementById('networkStatus').classList.add('is-live');
    document.getElementById('networkStatus').classList.remove('is-error');
    if (currentStage === 3 && scenarios) {
      renderRouteScenario(scenarios, true);
    } else if (currentStage === 4 && scenarios) {
      renderSupplyScenario(scenarios, true);
    } else {
      document.getElementById(currentStage === 3 ? 'routeScenarioResult' : 'supplyScenarioResult').hidden = true;
      setStageStatus(`Scenario will use the selected ${floor}% minimum-share rule.`);
    }
  }
  const questions = currentStage === 1 && !baselineSolution
    ? ['Why has the model not been solved yet?']
    : content.suggestions;
  renderSuggestions(questions);

  if (currentStage === 2 && !stageIntroductions.has(currentStage)) {
    stageIntroductions.add(currentStage);
    if (!includeStageDialogue) return;
    addConversationTurn(
      `Introduce fairness by setting a ${slider.value}% minimum share for every community.`,
      `I’ve added a controllable minimum-share constraint. Use the slider to choose the floor, then solve to see how the allocation changes.`,
    );
  } else if (currentStage === 3 && !stageIntroductions.has(currentStage)) {
    stageIntroductions.add(currentStage);
    addConversationTurn(
      'What if we reduce the cost of one delivery route?',
      `Choose a route for a 25% cost cut. I’ll compare new deliveries and route flows at the selected ${slider.value}% fairness floor.`,
    );
  } else if (currentStage === 4 && !stageIntroductions.has(currentStage)) {
    stageIntroductions.add(currentStage);
    addConversationTurn(
      'Would more supply help if the budget stays the same?',
      `I’ll add 200 crates at each hub in turn and compare the results at the selected ${slider.value}% fairness floor.`,
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
    renderSuggestions(stages[currentStage].suggestions);
    updateNextButton();
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
    body: JSON.stringify({
      fairness_percent: fairnessPercent,
      budget: baselineSolution?.budget ?? 1400,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Scenario request failed (${response.status})`);
  whatIfCache.set(fairnessPercent, result);
  return result;
}

function formatChange(value) {
  const formatted = formatNumber(Math.abs(value), 1);
  return value > 1e-6 ? `+${formatted}` : value < -1e-6 ? `−${formatted}` : '0.0';
}

function communityTotals(flows) {
  const totals = { north: 0, central: 0, south: 0 };
  Object.values(flows).forEach((routes) => {
    Object.entries(routes).forEach(([community, crates]) => {
      totals[community] += crates;
    });
  });
  return totals;
}

function describeCommunityChanges(baselineFlows, scenarioFlows) {
  const baseline = communityTotals(baselineFlows);
  const scenario = communityTotals(scenarioFlows);
  const names = { north: 'Northside', central: 'Central', south: 'Southside' };
  return Object.keys(names)
    .map((community) =>
      `${names[community]} ${formatNumber(baseline[community], 1)} → ${formatNumber(scenario[community], 1)} (${formatChange(scenario[community] - baseline[community])})`,
    )
    .join('; ');
}

function renderScenarioAllocation(container, baseline, scenario) {
  const baseAllocations = communityTotals(baseline.flows);
  const nextAllocations = communityTotals(scenario.flows);

  container.replaceChildren();
  Object.entries(baseAllocations).forEach(([community, before]) => {
    const after = nextAllocations[community];
    const row = document.createElement('div');
    row.className = 'scenario-allocation-row';
    const label = document.createElement('div');
    label.className = 'scenario-allocation-label';
    label.textContent = `${community[0].toUpperCase()}${community.slice(1)}`;
    const bars = document.createElement('div');
    bars.className = 'scenario-bar-pair';
    const baselineBar = document.createElement('div');
    baselineBar.className = 'scenario-base-fill';
    baselineBar.style.width = `${Math.min(100, before / DEMAND_LIMITS[community] * 100)}%`;
    const scenarioBar = document.createElement('div');
    scenarioBar.className = `scenario-new-fill ${community}-fill`;
    const scenarioWidth = `${Math.min(100, after / DEMAND_LIMITS[community] * 100)}%`;
    scenarioBar.style.width = '0%';
    requestAnimationFrame(() => { scenarioBar.style.width = scenarioWidth; });
    bars.append(baselineBar, scenarioBar);
    const values = document.createElement('span');
    values.className = 'scenario-allocation-value';
    values.textContent = `${formatNumber(before, 1)} → ${formatNumber(after, 1)} (${formatChange(after - before)})`;
    row.append(label, bars, values);
    container.append(row);
  });
}

function revealScenarioResult(result) {
  const panel = document.querySelector('.model-panel');
  const panelTop = panel.getBoundingClientRect().top;
  const resultTop = result.getBoundingClientRect().top;
  panel.scrollTo({
    top: panel.scrollTop + resultTop - panelTop,
    behavior: 'smooth',
  });
}

const DEMAND_LIMITS = { north: 800, central: 600, south: 500 };

function renderRouteScenario(scenarios, updateNetwork = true) {
  const routeSelect = document.getElementById('routeSelect');
  if (!routeSelect.dataset.userSelected) {
    routeSelect.value = `${scenarios.best_route.hub}|${scenarios.best_route.community}`;
  }
  const [hub, community] = routeSelect.value.split('|');
  const scenario = scenarios.route_scenarios.find(
    (item) => item.hub === hub && item.community === community,
  );
  const baseline = scenarios.baseline;
  document.getElementById('routeScenarioResult').hidden = false;
  document.getElementById('routeScenarioResult').dataset.floor = scenarios.baseline.fairness_percent;
  document.getElementById('routeScenarioStatus').textContent =
    `A 25% cost cut on this route; all routes are re-optimized at ${formatNumber(scenarios.baseline.fairness_percent)}%.`;
  document.getElementById('routeBefore').textContent = formatNumber(baseline.total_deliveries, 1);
  document.getElementById('routeAfter').textContent = formatNumber(scenario.deliveries, 1);
  document.getElementById('routeChange').textContent = formatChange(scenario.delivery_change);
  document.getElementById('routeChange').classList.toggle('is-positive', scenario.delivery_change > 1e-6);
  document.getElementById('routeChange').classList.toggle('is-negative', scenario.delivery_change < -1e-6);
  renderScenarioAllocation(
    document.getElementById('routeAllocation'),
    baseline,
    scenario,
  );
  const routeName = `${hub === 'north_hub' ? 'North Hub' : 'South Hub'} → ${community[0].toUpperCase()}${community.slice(1)}`;
  document.getElementById('routeFootnote').textContent =
    `${routeName}: unit cost ${formatNumber(scenario.original_unit_cost, 2)} → ${formatNumber(scenario.reduced_unit_cost, 2)}. Bar pairs show baseline → new crates; the network shows the new route flows.`;
  if (updateNetwork) {
    renderNetworkAllocation(scenario.flows, baseline.supply);
    document.getElementById('networkStatus').textContent = 'ROUTE SCENARIO';
    revealScenarioResult(document.getElementById('routeScenarioResult'));
  }
  updateNextButton();
}

function renderSupplyScenario(scenarios, updateNetwork = true, selectedHub = null) {
  const baseline = scenarios.baseline;
  const entries = scenarios.hub_supply_scenarios;
  const best = scenarios.best_hub;
  const selected = entries.find((item) => item.hub === selectedHub) || best;
  const comparisons = document.getElementById('supplyComparisons');
  comparisons.replaceChildren();

  entries.forEach((item) => {
    const hubName = item.hub === 'north_hub' ? 'North Hub' : 'South Hub';
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'supply-choice';
    choice.classList.toggle('is-selected', item.hub === selected.hub);
    choice.setAttribute('aria-pressed', String(item.hub === selected.hub));
    const title = document.createElement('strong');
    title.textContent = `${hubName} + ${formatNumber(item.supply_increase)} crates`;
    const impact = document.createElement('span');
    impact.textContent =
      `${formatNumber(item.deliveries, 1)} delivered · ${formatChange(item.delivery_change)} crates`;
    choice.append(title, impact);
    choice.addEventListener('click', () => renderSupplyScenario(scenarios, true, item.hub));
    comparisons.append(choice);
  });

  document.getElementById('supplyScenarioResult').hidden = false;
  document.getElementById('supplyScenarioResult').dataset.floor = baseline.fairness_percent;
  document.getElementById('supplyScenarioStatus').textContent =
    `${selected.hub === best.hub ? (best.delivery_change > 1e-6 ? 'Best result' : 'Neither hub increases deliveries') : 'Selected comparison'} at ${formatNumber(baseline.fairness_percent)}% fairness.`;
  renderScenarioAllocation(
    document.getElementById('supplyAllocation'),
    baseline,
    selected,
  );
  document.getElementById('supplyFootnote').textContent =
    `Bars show baseline → new crates. The network shows the ${selected.hub === 'north_hub' ? 'North Hub' : 'South Hub'} scenario; budget remains ${formatNumber(baseline.budget)} cost units.`;
  if (updateNetwork) {
    const scenarioSupply = {
      ...baseline.supply,
      [selected.hub]: baseline.supply[selected.hub] + selected.supply_increase,
    };
    renderNetworkAllocation(selected.flows, scenarioSupply);
    document.getElementById('networkStatus').textContent = 'SUPPLY SCENARIO';
    revealScenarioResult(document.getElementById('supplyScenarioResult'));
  }
  updateNextButton();
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
    if (!/(model|formulat|translat|optim|decision variable|linear program)/i.test(question)) {
      return 'I can help with that. First, ask me to build the optimization model from the supply, demand, route costs, and budget shown here.';
    }
    return 'I’ve prepared the Python optimization model for Gurobi using the data shown: choose six route flows, maximize total deliveries, and keep each hub’s shipments, each community’s deliveries, and total route cost within their limits. The route costs are 1, 3, 4 from North Hub and 3, 2, 3 from South Hub. I’ll show the exact equations next; press Solve when you’re ready for Gurobi to calculate the allocation.';
  }
  if (currentStage === 1 && !baselineSolution) {
    return 'The full model is ready, but it has not been solved yet. Press “Solve baseline” and I can explain the resulting allocation.';
  }
  if (currentStage === 1 && /fair|minimum share|guarantee|equity/.test(text)) {
    return `We can add a minimum-share rule for every community. I’ll open the fairness tab, where you can control the percentage with a slider before solving again.`;
  }
  if (currentStage === 2 && (
    !displayedSolution || displayedSolution.fairness_percent !== Number(slider.value)
  )) {
    return 'The fairness rule has changed, but this allocation is from the previous solve. Press “Re-solve” first so I can compare the current results.';
  }

  const selectedFloor = Number(slider.value);
  const result = currentStage === 1
    ? baselineSolution
    : whatIfCache.get(selectedFloor)?.baseline
      || fairnessCache.get(selectedFloor)
      || displayedSolution
      || baselineSolution;
  if ([2, 4].includes(currentStage) && /more (?:supply|crates)|additional supply|which hub|supply help|extra supply/.test(text)) {
    const scenarios = await requestWhatIf(selectedFloor);
    if (currentStage === 4) renderSupplyScenario(scenarios);
    const best = scenarios.best_hub;
    const other = scenarios.hub_supply_scenarios.find((item) => item.hub !== best.hub);
    const baselineDeliveries = scenarios.baseline.total_deliveries;
    const bestDeliveries = baselineDeliveries + best.delivery_change;
    const otherDeliveries = baselineDeliveries + other.delivery_change;
    const bestName = best.hub === 'north_hub' ? 'North Hub' : 'South Hub';
    const otherName = other.hub === 'north_hub' ? 'North Hub' : 'South Hub';
    if (best.delivery_change < 1e-6 && other.delivery_change < 1e-6) {
      return `At the ${formatNumber(selectedFloor)}% floor, the baseline delivers ${formatNumber(baselineDeliveries, 1)} crates. Adding ${formatNumber(best.supply_increase)} crates at ${bestName} or ${otherName} leaves deliveries unchanged at ${formatNumber(bestDeliveries, 1)} and ${formatNumber(otherDeliveries, 1)}. With the budget fixed at 1,400 units, extra supply does not increase deliveries in these scenarios.`;
    }
    return `At the ${formatNumber(selectedFloor)}% floor, the baseline delivers ${formatNumber(baselineDeliveries, 1)} crates. With ${formatNumber(best.supply_increase)} extra crates and the same 1,400-unit budget, deliveries become ${formatNumber(bestDeliveries, 1)} at ${bestName} (${formatChange(best.delivery_change)}) or ${formatNumber(otherDeliveries, 1)} at ${otherName} (${formatChange(other.delivery_change)}). At ${bestName}, community allocations change: ${describeCommunityChanges(scenarios.baseline.flows, best.flows)}.`;
  }

  if ([2, 3].includes(currentStage) && /cost|route|arc|cheaper|reduce|sensitivity/.test(text)) {
    const scenarios = await requestWhatIf(selectedFloor);
    const requested = matchRequestedRoute(text, scenarios.route_scenarios);
    const best = requested || scenarios.best_route;
    if (currentStage === 2 || currentStage === 3) {
      document.getElementById('routeSelect').value = `${best.hub}|${best.community}`;
      document.getElementById('routeSelect').dataset.userSelected = 'true';
    }
    if (currentStage === 3) renderRouteScenario(scenarios);
    const routeName = `${best.hub === 'north_hub' ? 'North Hub' : 'South Hub'} to ${best.community[0].toUpperCase()}${best.community.slice(1)}`;
    const routeLabel = requested ? routeName : `the ${routeName} route`;
    const baselineDeliveries = scenarios.baseline.total_deliveries;
    const scenarioDeliveries = baselineDeliveries + best.delivery_change;
    const communityChanges = describeCommunityChanges(scenarios.baseline.flows, best.flows);
    if (best.delivery_change > 1e-6) {
      return `At the ${formatNumber(selectedFloor)}% floor, cutting ${routeLabel} from ${formatNumber(best.original_unit_cost, 2)} to ${formatNumber(best.reduced_unit_cost, 2)} cost units raises total deliveries from ${formatNumber(baselineDeliveries, 1)} to ${formatNumber(scenarioDeliveries, 1)} (${formatChange(best.delivery_change)}). Community allocations change: ${communityChanges}. The budget stays at 1,400 units.`;
    }
    return `At the ${formatNumber(selectedFloor)}% floor, cutting ${routeLabel} from ${formatNumber(best.original_unit_cost, 2)} to ${formatNumber(best.reduced_unit_cost, 2)} cost units leaves total deliveries at ${formatNumber(baselineDeliveries, 1)}. Community allocations change: ${communityChanges}. Gurobi re-optimizes the full network under the same 1,400-unit budget.`;
  }

  if (currentStage <= 2 && /why.*south|south.*nothing|southside/.test(text)) {
    const south = result.allocations.south;
    if (result.fairness_percent === null) {
      return `The budget is fully used on Northside and Central, where the selected routes deliver more crates per cost unit. Without a fairness rule, the solver has no reason to spend the budget reaching Southside.`;
    }
    return `Southside receives ${formatNumber(south, 1)} crates, or ${(south / result.total_deliveries * 100).toFixed(1)}% of deliveries. The ${formatNumber(result.fairness_percent)}% rule guarantees at least ${formatNumber(result.total_deliveries * result.fairness_percent / 100, 1)} crates.`;
  }

  if (currentStage <= 2 && /why.*deliver|deliveries fall|less food|less.*crate|decrease|change/.test(text)) {
    if (result.fairness_percent === null) {
      return `The baseline delivers ${formatNumber(result.total_deliveries)} crates within the 1,400-unit budget. The budget is fully spent.`;
    }
    const change = result.total_deliveries - baselineSolution.total_deliveries;
    return `Deliveries move from ${formatNumber(baselineSolution.total_deliveries)} to ${formatNumber(result.total_deliveries, 1)} (${formatNumber(change, 1)} crates). The same budget now has to cover routes that protect every community’s minimum share, including more expensive routes.`;
  }

  if (currentStage <= 2 && /fair|minimum share|guarantee|constraint/.test(text)) {
    const floor = result.fairness_percent;
    if (floor === null) {
      return 'The baseline has supply, demand, and budget limits. The next step adds a fairness floor while keeping the same objective and network.';
    }
    const minimum = result.total_deliveries * floor / 100;
    return `Each community must receive at least ${formatNumber(floor)}% of actual deliveries—${formatNumber(minimum, 1)} crates at this solution. The floor is linked to total flow, not to the 1,000 crates available.`;
  }

  if (currentStage <= 2 && /route|flow|ship|allocation|share|why/.test(text)) {
    const routes = Object.entries(result.flows)
      .flatMap(([hub, destinations]) => Object.entries(destinations)
        .filter(([, crates]) => crates > 1e-6)
        .map(([community, crates]) =>
          `${hub === 'north_hub' ? 'North Hub' : 'South Hub'} → ${community}: ${formatNumber(crates, 1)}`));
    return `Gurobi delivers ${formatNumber(result.total_deliveries, 1)} crates for ${formatNumber(result.budget_used, 1)} cost units. Active routes: ${routes.join('; ')}.`;
  }

  if (currentStage <= 2 && /cost|budget/.test(text)) {
    return `The model spends ${formatNumber(result.budget_used, 1)} of the 1,400 illustrative cost units. These route costs are not measured dollars.`;
  }
  return 'I can explain the allocation, route flows, budget, fairness rule, or a solver-based what-if scenario.';
}

async function askModel(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  const asksForModel = currentStage === 0
    && /(model|formulat|translat|optim|decision variable|linear program)/i.test(trimmed);
  const asksForFairness = currentStage === 1
    && /(fair|minimum share|guarantee|equity)/i.test(trimmed);
  const shouldAdvanceToFairness = asksForFairness && baselineSolution !== null;
  const currentFairnessSolved = fairnessCache.has(Number(slider.value))
    && displayedSolution?.fairness_percent === Number(slider.value);
  const asksForRouteScenario = currentStage === 2 && currentFairnessSolved
    && /cost|route|arc|cheaper|reduce|sensitivity/i.test(trimmed);
  const asksForSupplyScenario = currentStage === 2 && currentFairnessSolved
    && /more (?:supply|crates)|additional supply|which hub|supply help|extra supply/i.test(trimmed);
  const nextScenarioStage = asksForRouteScenario ? 3 : asksForSupplyScenario ? 4 : null;
  conversationQueue = conversationQueue.then(async () => {
    addChatMessage(trimmed, 'user');
    const thinking = addChatMessage(
      asksForModel
        ? 'Translating the stated data into an LP…'
        : nextScenarioStage !== null
          ? 'Re-solving the requested scenario…'
          : 'Let me check the current model…',
      'thinking',
    );
    try {
      await wait(2000);
      const answer = await answerModelQuestion(trimmed);
      thinking.remove();
      await addAssistantResponse(answer);
      if (asksForModel && currentStage === 0) {
        await wait(1800);
        renderStage(1, false);
      } else if (shouldAdvanceToFairness && currentStage === 1) {
        await wait(1800);
        renderStage(2, false);
      } else if (nextScenarioStage !== null && currentStage === 2) {
        await wait(1800);
        renderStage(nextScenarioStage, false);
      }
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
document.getElementById('routeScenarioButton').addEventListener('click', async () => {
  const floor = Number(slider.value);
  const button = document.getElementById('routeScenarioButton');
  button.disabled = true;
  document.getElementById('routeScenarioStatus').textContent =
    `Re-solving the network with the selected ${floor}% fairness floor…`;
  try {
    const scenarios = await requestWhatIf(floor);
    if (currentStage === 3 && Number(slider.value) === floor) renderRouteScenario(scenarios);
  } catch (error) {
    document.getElementById('routeScenarioStatus').textContent =
      `Could not compare route costs: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('supplyScenarioButton').addEventListener('click', async () => {
  const floor = Number(slider.value);
  const button = document.getElementById('supplyScenarioButton');
  button.disabled = true;
  document.getElementById('supplyScenarioStatus').textContent =
    `Re-solving both hub scenarios with the selected ${floor}% fairness floor…`;
  try {
    const scenarios = await requestWhatIf(floor);
    if (currentStage === 4 && Number(slider.value) === floor) renderSupplyScenario(scenarios);
  } catch (error) {
    document.getElementById('supplyScenarioStatus').textContent =
      `Could not compare additional supply: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
document.getElementById('routeSelect').addEventListener('change', (event) => {
  event.currentTarget.dataset.userSelected = 'true';
  const scenarios = whatIfCache.get(Number(slider.value));
  if (currentStage === 3 && scenarios) renderRouteScenario(scenarios);
  else {
    document.getElementById('routeScenarioResult').hidden = true;
    document.getElementById('routeScenarioStatus').textContent =
      'Route changed. Re-optimize to see its impact on deliveries and flows.';
    updateNextButton();
  }
});
slider.addEventListener('input', () => {
  solveRequest += 1;
  const floor = Number(slider.value);
  updateFairnessLabels();
  updateNextButton();
  document.getElementById('fairnessSolveButton').disabled = false;
  document.getElementById('modelStageNote').textContent = currentStage === 2
    ? 'The objective, network, supply, demand, and budget stay the same.'
    : `Compare a new solve using the selected ${floor}% fairness floor.`;
  if (currentStage === 2) {
    const cached = fairnessCache.get(floor);
    if (cached) renderSolution(cached);
    else {
      resultsPanel.hidden = true;
      if (baselineSolution) renderNetworkAllocation(baselineSolution.flows, baselineSolution.supply);
    }
    setStageStatus(`Rule changed to ${floor}%. Press Re-solve to update the allocation.`);
    document.getElementById('networkStatus').textContent = 'RE-SOLVE READY';
    document.getElementById('networkStatus').classList.remove('is-error');
  } else if (currentStage === 3 || currentStage === 4) {
    const scenarios = whatIfCache.get(floor);
    if (scenarios && currentStage === 3) renderRouteScenario(scenarios);
    else if (scenarios && currentStage === 4) renderSupplyScenario(scenarios);
    else {
      const current = fairnessCache.get(floor) || baselineSolution;
      if (current) renderNetworkAllocation(current.flows, current.supply);
      document.getElementById('routeScenarioResult').hidden = true;
      document.getElementById('supplyScenarioResult').hidden = true;
      document.getElementById('networkStatus').textContent = `${floor}% FAIRNESS`;
      setStageStatus(`Scenario will use the selected ${floor}% minimum-share rule.`);
      document.getElementById(currentStage === 3 ? 'routeScenarioStatus' : 'supplyScenarioStatus').textContent =
        `The fairness floor changed to ${floor}%. Run this scenario to update the result.`;
      updateNextButton();
    }
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
