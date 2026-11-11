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
    detail: 'Southside receives 150 crates, while Northside gets 550. Both are within demand, but the shares are far apart.',
  },
  {
    kicker: 'THE MODEL CHANGES',
    title: 'Add one constraint. See the decision change.',
    description: 'Keep the same routes, supply, and objective. Now guarantee every community a minimum share.',
    insight: 'Only one line changed. The original objective and supply limits stay in place; the new floor redistributes the same crates.',
    detail: 'Any crates above the floor still follow the original cost preference, so the minimum is protected without forcing equal shares.',
  },
];

const originalShares = { north: 55, central: 30, south: 15 };
const stageLinks = [...document.querySelectorAll('.stage-link')];
const fairnessRow = document.getElementById('fairnessRow');
const resultsPanel = document.getElementById('resultsPanel');
const fairnessControl = document.getElementById('fairnessControl');
const slider = document.getElementById('fairnessSlider');
const insightText = document.getElementById('insightText');
let currentStage = 0;
let insightExpanded = false;
const metricFrames = new WeakMap();

function allocationForFloor(floor) {
  const remaining = 100 - floor * 3;
  const totalWeight = Object.values(originalShares).reduce((sum, share) => sum + share, 0);
  return Object.fromEntries(
    Object.entries(originalShares).map(([community, share]) => [
      community,
      floor + (remaining * share) / totalWeight,
    ]),
  );
}

function renderAllocations(shares, fair) {
  const rawCrates = Object.entries(shares).map(([community, share]) => ({
    community,
    crates: (share * 10),
  }));
  const crateAllocations = Object.fromEntries(
    rawCrates.map(({ community, crates }) => [community, Math.floor(crates)]),
  );
  const unallocated = 1000 - Object.values(crateAllocations).reduce((sum, crates) => sum + crates, 0);
  rawCrates
    .sort((a, b) => (b.crates % 1) - (a.crates % 1))
    .slice(0, unallocated)
    .forEach(({ community }) => { crateAllocations[community] += 1; });

  document.querySelectorAll('[data-bar]').forEach((bar) => {
    const share = shares[bar.dataset.bar];
    bar.style.width = `${share}%`;
  });
  document.querySelectorAll('[data-value]').forEach((value) => {
    const community = value.dataset.value;
    value.textContent = `${shares[community].toFixed(1)}% · ${crateAllocations[community]} crates`;
  });
  document.querySelectorAll('[data-allocation]').forEach((label) => {
    label.textContent = `${crateAllocations[label.dataset.allocation]} crates`;
  });

  const leastServed = Math.min(...Object.values(shares));
  const cost = fair ? 1840 + (Number(slider.value) - 15) * 12 : 1840;
  animateMetric(document.getElementById('costMetric'), cost, (value) => `$${value.toLocaleString('en-US')}`);
  animateMetric(document.getElementById('serviceMetric'), Math.round(leastServed), (value) => `${value}%`);
  document.getElementById('resultsTitle').textContent = fair
    ? 'Fairness-constrained allocation'
    : 'Original cost-optimal allocation';
  document.getElementById('networkStatus').textContent = fair ? 'FAIRNESS FLOOR' : 'COST-OPTIMAL';
  document.getElementById('networkStatus').classList.add('is-live');
  document.querySelector('.network').classList.add('is-allocated');
  document.getElementById('comparisonNote').hidden = !fair;
}

function animateMetric(element, target, format) {
  const previousFrame = metricFrames.get(element);
  if (previousFrame) cancelAnimationFrame(previousFrame);

  const initial = Number(element.textContent.replace(/\D/g, '')) || 0;
  const startedAt = performance.now();
  const duration = 450;
  element.classList.remove('metric-changed');
  void element.offsetWidth;
  element.classList.add('metric-changed');
  element.addEventListener('animationend', () => element.classList.remove('metric-changed'), { once: true });

  function update(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(Math.round(initial + (target - initial) * eased));
    if (progress < 1) metricFrames.set(element, requestAnimationFrame(update));
    else metricFrames.delete(element);
  }

  metricFrames.set(element, requestAnimationFrame(update));
}

function renderStage(stage) {
  currentStage = Math.max(0, Math.min(stages.length - 1, stage));
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
  document.getElementById('modelInsight').classList.remove('is-expanded');
  insightExpanded = false;
  document.getElementById('insightButton').innerHTML = 'A model note <span aria-hidden="true">+</span>';

  if (currentStage === 0) {
    document.querySelector('.network').classList.remove('is-allocated');
    document.getElementById('networkStatus').textContent = 'DEMAND';
    document.getElementById('networkStatus').classList.remove('is-live');
  } else if (currentStage === 1) {
    renderAllocations(originalShares, false);
  } else {
    updateFairAllocation();
  }
}

function updateFairAllocation() {
  const floor = Number(slider.value);
  const fairShares = allocationForFloor(floor);
  document.getElementById('fairnessOutput').value = `${floor}%`;
  document.getElementById('constraintThreshold').textContent = `${floor}%`;
  renderAllocations(fairShares, true);
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
slider.addEventListener('input', updateFairAllocation);
document.getElementById('insightButton').addEventListener('click', (event) => {
  insightExpanded = !insightExpanded;
  document.getElementById('modelInsight').classList.toggle('is-expanded', insightExpanded);
  const stage = stages[currentStage];
  const detail = currentStage === 2
    ? `At a ${slider.value}% floor, any crates above the minimum still follow the original cost preference.`
    : stage.detail;
  insightText.textContent = insightExpanded
    ? `${stage.insight} ${detail}`
    : stage.insight;
  event.currentTarget.innerHTML = insightExpanded
    ? 'Less context <span aria-hidden="true">−</span>'
    : 'A model note <span aria-hidden="true">+</span>';
});

renderStage(0);
