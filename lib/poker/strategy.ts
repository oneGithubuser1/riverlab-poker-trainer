import { createDeck } from "./cards";
import { countImprovementOuts, evaluateSeven, compareScores, preflopStrength } from "./evaluator";
import { buildBayesianRange } from "./range-model";
import type { BayesianRangeCombo } from "./range-model";
import { SeededRng } from "./rng";
import { classifyRelativeHand } from "./hand-profile";
import type {
  ActionComparison,
  BoardTexture,
  BotViewState,
  Card,
  InferredRange,
  PlayerViewState,
  PublicSeatState,
  RangeResponseAnalysis,
  RelativeHandProfile,
  StrategyAnalysis,
} from "./types";

type VisibleView = PlayerViewState | BotViewState;
type WeightedCombo = BayesianRangeCombo;
type WeightedOpponentRange = { seat: PublicSeatState; range: InferredRange; combos: WeightedCombo[] };

const POSITION_WIDTH: Record<string, number> = {
  UTG: 0.14,
  "UTG+1": 0.16,
  LJ: 0.19,
  HJ: 0.23,
  CO: 0.30,
  BTN: 0.46,
  SB: 0.38,
  BB: 0.52,
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function potFromView(view: VisibleView): number {
  return view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
}

function observedRate(numerator: number, denominator: number, fallback: number): number {
  return denominator >= 8 ? numerator / denominator : fallback;
}

function inferRange(view: VisibleView, seat: PublicSeatState): InferredRange {
  const preflop = view.actionLog.filter((action) => action.playerId === seat.id && action.street === "preflop" && !action.type.includes("blind"));
  const postflop = view.actionLog.filter((action) => action.playerId === seat.id && action.street !== "preflop");
  const base = POSITION_WIDTH[seat.position] ?? 0.32;
  let width = base;
  const evidence: string[] = [];

  const raiseAction = [...preflop].reverse().find((action) => action.type === "raise" || action.type === "all-in");
  const callAction = [...preflop].reverse().find((action) => action.type === "call");
  const checked = preflop.some((action) => action.type === "check");
  if (raiseAction) {
    const raisesBefore = view.actionLog.filter((action) => action.street === "preflop" && action.index < raiseAction.index && (action.type === "raise" || action.type === "all-in")).length;
    if (raisesBefore >= 2) {
      width = 0.045;
      evidence.push("4-bet+");
    } else if (raisesBefore >= 1) {
      width = 0.095;
      evidence.push("3-bet");
    } else {
      width = base;
      evidence.push("open");
    }
  } else if (callAction) {
    const facedRaise = view.actionLog.some((action) => action.street === "preflop" && action.index < callAction.index && (action.type === "raise" || action.type === "all-in"));
    width = facedRaise ? Math.min(0.34, base * 1.12) : Math.max(0.34, base);
    evidence.push(facedRaise ? "cold-call" : "limp");
  } else if (checked) {
    width = 0.72;
    evidence.push("checked-option");
  } else {
    width = Math.max(base, 0.58);
    evidence.push("not-yet-defined");
  }

  const vpip = observedRate(seat.stats.vpipHands, seat.stats.hands, width);
  width = width * 0.72 + vpip * 0.28;
  const aggression = postflop.filter((action) => ["bet", "raise", "all-in"].includes(action.type)).length;
  const calls = postflop.filter((action) => action.type === "call").length;
  if (aggression > 0) {
    width *= Math.pow(0.78, aggression);
    evidence.push("postflop-aggression");
  }
  if (calls > 0) {
    width *= Math.pow(0.9, calls);
    evidence.push("postflop-call");
  }
  width = clamp(width, 0.035, 0.78);
  const label = width <= 0.1 ? "very-tight" : width <= 0.2 ? "tight" : width <= 0.38 ? "medium" : "wide";
  return { playerId: seat.id, playerName: seat.name, position: seat.position, width, label, evidence };
}

function buildWeightedRange(view: VisibleView, range: InferredRange, seat: PublicSeatState): WeightedCombo[] {
  return buildBayesianRange(view, seat, range.width);
}
function preflopComboLabel(strength: number): string {
  if (strength >= 0.8) return "顶级起手牌";
  if (strength >= 0.62) return "强起手牌";
  if (strength >= 0.4) return "可玩起手牌";
  return "边缘起手牌";
}

function continueProbability(
  view: VisibleView,
  combo: WeightedCombo,
  heroProfile: RelativeHandProfile,
  sizeFraction: number,
): { probability: number; raiseProbability: number; comparison: number; label: string } {
  if (view.community.length < 3) {
    const opponentStrength = combo.strength;
    const heroStrength = preflopStrength(view.holeCards);
    const comparison = opponentStrength > heroStrength + 0.025 ? 1 : opponentStrength < heroStrength - 0.025 ? -1 : 0;
    let probability = 0.08 + opponentStrength * 0.82 - Math.max(0, sizeFraction - 0.5) * 0.16;
    if (comparison > 0) probability = Math.max(probability, 0.72);
    probability = clamp(probability, 0.03, 0.98);
    const raiseProbability = Math.min(probability * 0.72, clamp((opponentStrength - 0.58) * 1.35 + 0.05, 0.02, 0.68));
    return { probability, raiseProbability, comparison, label: preflopComboLabel(opponentStrength) };
  }

  const comparison = combo.showdownComparison;
  const categoryContinue = [0.08, 0.38, 0.70, 0.83, 0.90, 0.93, 0.96, 0.98, 0.99][combo.madeCategory];
  const drawBoost = combo.drawScore * 0.46;
  let probability = categoryContinue + drawBoost;
  if (comparison > 0) probability = Math.max(probability, 0.84);
  if (comparison === 0) probability = Math.max(probability, 0.60);
  if (comparison < 0 && heroProfile.relativeTier === "nuts") probability -= 0.08;
  probability -= Math.max(0, sizeFraction - 0.33) * 0.28;
  probability = clamp(probability, 0.02, 0.99);

  const valueRaise = clamp((combo.tierScore - 0.64) * 1.35, 0, 0.64);
  const drawRaise = combo.drawScore * (view.street === "river" ? 0 : 0.16);
  const blockerBluffRaise = (1 - combo.tierScore) * combo.blockerScore * (view.street === "river" ? 0.12 : 0.06);
  const sizePenalty = Math.max(0, sizeFraction - 0.75) * 0.08;
  const raiseProbability = Math.min(probability * 0.78, clamp(0.015 + valueRaise + drawRaise + blockerBluffRaise - sizePenalty, 0.01, 0.72));
  return { probability, raiseProbability, comparison, label: combo.madeLabel };
}
function analyzeRangeResponse(
  view: VisibleView,
  ranges: WeightedOpponentRange[],
  heroProfile: RelativeHandProfile,
  sizeFraction: number,
): RangeResponseAnalysis {
  if (ranges.length === 0) {
    return {
      referenceSize: sizeFraction,
      worseHandsContinue: 0,
      betterHandsFold: 0,
      strongerHandsContinue: 0,
      overallContinue: 0,
      foldShare: 1,
      callShare: 0,
      raiseBack: 0,
      weakerRangeShare: 0,
      betterRangeShare: 0,
      valueTargets: [],
      foldTargets: [],
      summary: "没有仍在牌局中的对手范围。",
    };
  }

  let weaker = 0;
  let better = 0;
  let weakerContinue = 0;
  let betterContinue = 0;
  let overallContinue = 0;
  let raiseBack = 0;
  const valueLabels = new Map<string, number>();
  const foldLabels = new Map<string, number>();

  for (const item of ranges) {
    const rangeWeight = item.combos.reduce((sum, combo) => sum + combo.weight, 0) || 1;
    for (const combo of item.combos) {
      const weight = combo.weight / rangeWeight / ranges.length;
      const response = continueProbability(view, combo, heroProfile, sizeFraction);
      overallContinue += weight * response.probability;
      raiseBack += weight * response.raiseProbability;
      if (response.comparison < 0) {
        weaker += weight;
        weakerContinue += weight * response.probability;
        valueLabels.set(response.label, (valueLabels.get(response.label) ?? 0) + weight * response.probability);
      } else if (response.comparison > 0) {
        better += weight;
        betterContinue += weight * response.probability;
        foldLabels.set(response.label, (foldLabels.get(response.label) ?? 0) + weight * (1 - response.probability));
      }
    }
  }

  const topLabels = (source: Map<string, number>) => [...source.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([label]) => label);
  const worseHandsContinue = weaker > 0 ? weakerContinue / weaker : 0;
  const betterHandsFold = better > 0 ? (better - betterContinue) / better : 0;
  const strongerHandsContinue = better > 0 ? betterContinue / better : 0;
  const normalizedContinue = clamp(overallContinue);
  const normalizedRaise = clamp(Math.min(normalizedContinue, raiseBack));
  const foldShare = clamp(1 - normalizedContinue);
  const callShare = clamp(normalizedContinue - normalizedRaise);
  const referencePercent = Math.round(sizeFraction * 100);
  return {
    referenceSize: sizeFraction,
    worseHandsContinue,
    betterHandsFold,
    strongerHandsContinue,
    overallContinue: normalizedContinue,
    foldShare,
    callShare,
    raiseBack: normalizedRaise,
    weakerRangeShare: clamp(weaker),
    betterRangeShare: clamp(better),
    valueTargets: topLabels(valueLabels),
    foldTargets: topLabels(foldLabels),
    summary: `以约 ${referencePercent}% 底池为参考：弃牌约 ${Math.round(foldShare * 100)}%，跟注约 ${Math.round(callShare * 100)}%，反加约 ${Math.round(normalizedRaise * 100)}%。`,
  };
}
function sampleCombo(range: WeightedCombo[], unavailable: Set<string>, rng: SeededRng): [Card, Card] | undefined {
  const valid = range.filter((combo) => !unavailable.has(combo.cards[0].id) && !unavailable.has(combo.cards[1].id));
  if (valid.length === 0) return undefined;
  const index = rng.weightedIndex(valid.map((combo) => combo.weight));
  return valid[index].cards;
}

function estimateRangeEquity(view: VisibleView, ranges: WeightedOpponentRange[], iterations: number): number {
  if (view.holeCards.length !== 2 || ranges.length === 0) return 0;
  const rng = new SeededRng(`${view.handId}-${view.viewerId}-range-${view.actionLog.length}`);
  const known = [...view.holeCards, ...view.community];
  let equity = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const unavailable = new Set(known.map((card) => card.id));
    const opponents: Card[][] = [];
    let valid = true;
    for (const item of ranges) {
      const combo = sampleCombo(item.combos, unavailable, rng);
      if (!combo) {
        valid = false;
        break;
      }
      opponents.push(combo);
      unavailable.add(combo[0].id);
      unavailable.add(combo[1].id);
    }
    if (!valid) continue;
    const remaining = createDeck().filter((card) => !unavailable.has(card.id));
    const runout = rng.shuffle(remaining);
    const board = [...view.community];
    let cursor = 0;
    while (board.length < 5) board.push(runout[cursor++]);
    const heroScore = evaluateSeven([...view.holeCards, ...board]);
    const opponentScores = opponents.map((cards) => evaluateSeven([...cards, ...board]));
    if (opponentScores.some((score) => compareScores(score, heroScore) > 0)) continue;
    const ties = opponentScores.filter((score) => compareScores(score, heroScore) === 0).length;
    equity += 1 / (ties + 1);
  }
  return equity / Math.max(1, iterations);
}

function estimateOneStreetPotential(
  view: VisibleView,
  ranges: WeightedOpponentRange[],
  currentEquity: number,
  rangeAdvantage: number,
): { checkValue: number; aggressionValue: number } {
  if (view.community.length < 3 || view.community.length >= 5 || ranges.length === 0) {
    return { checkValue: 0, aggressionValue: 0 };
  }
  const known = new Set([...view.holeCards, ...view.community].map((card) => card.id));
  const rng = new SeededRng(`${view.handId}-${view.viewerId}-one-street-${view.actionLog.length}`);
  const futureCards = rng.shuffle(createDeck().filter((card) => !known.has(card.id))).slice(0, view.street === "flop" ? 14 : 18);
  let positiveShift = 0;
  let volatility = 0;

  for (const future of futureCards) {
    const nextBoard = [...view.community, future];
    const heroScore = evaluateSeven([...view.holeCards, ...nextBoard]);
    let nextEquity = 0;
    for (const item of ranges) {
      let itemEquity = 0;
      let itemWeight = 0;
      for (const combo of item.combos.slice(0, 42)) {
        if (combo.cards.some((card) => card.id === future.id)) continue;
        const opponentScore = evaluateSeven([...combo.cards, ...nextBoard]);
        const comparison = compareScores(heroScore, opponentScore);
        const outcome = comparison > 0 ? 1 : comparison === 0 ? 0.5 : 0;
        itemEquity += outcome * combo.weight;
        itemWeight += combo.weight;
      }
      nextEquity += itemWeight > 0 ? itemEquity / itemWeight : currentEquity;
    }
    nextEquity /= ranges.length;
    positiveShift += Math.max(0, nextEquity - currentEquity);
    volatility += Math.abs(nextEquity - currentEquity);
  }

  const samples = Math.max(1, futureCards.length);
  const averagePositive = positiveShift / samples;
  const averageVolatility = volatility / samples;
  const pot = potFromView(view);
  const checkValue = pot * (averagePositive * 0.16 + averageVolatility * 0.035);
  const aggressionValue = pot * (averagePositive * 0.26 + averageVolatility * 0.085 + Math.max(0, rangeAdvantage) * 0.035);
  return { checkValue, aggressionValue };
}
function analyzeBoard(view: VisibleView): { texture: BoardTexture; wetness: number; summary: string } {
  if (view.community.length === 0) return { texture: "preflop", wetness: 0.25, summary: "preflop" };
  const ranks = view.community.map((card) => card.rank).sort((a, b) => b - a);
  const uniqueRanks = new Set(ranks);
  const paired = uniqueRanks.size < ranks.length;
  const suitCounts = new Map<string, number>();
  for (const card of view.community) suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const monotone = maxSuit >= 3;
  let closeGaps = 0;
  const unique = [...uniqueRanks].sort((a, b) => b - a);
  for (let index = 0; index < unique.length - 1; index += 1) if (unique[index] - unique[index + 1] <= 2) closeGaps += 1;
  const wetness = clamp(0.16 + closeGaps * 0.18 + (maxSuit >= 2 ? 0.18 : 0) + (monotone ? 0.22 : 0) - (paired ? 0.08 : 0));
  if (monotone) return { texture: "monotone", wetness, summary: "monotone" };
  if (paired) return { texture: "paired", wetness, summary: wetness > 0.48 ? "paired-dynamic" : "paired-dry" };
  if (wetness >= 0.68) return { texture: "wet", wetness, summary: "wet" };
  if (wetness >= 0.42) return { texture: "dynamic", wetness, summary: "dynamic" };
  return { texture: "dry", wetness, summary: "dry" };
}

function legalTarget(view: VisibleView, desired: number): number {
  const legal = view.legalActions;
  const minimum = view.currentBet === 0 ? legal.minBetTo : legal.minRaiseTo;
  return Math.max(minimum, Math.min(legal.maxTo, Math.round(desired)));
}

function actionPurpose(
  action: ActionComparison["action"],
  equity: number,
  outs: number,
  profile: RelativeHandProfile,
  response?: RangeResponseAnalysis,
): string {
  if (action === "fold") return "cut-loss";
  if (action === "check") return profile.bluffCatcher ? "showdown-value" : equity >= 0.58 ? "pot-control" : "realize-equity";
  // 补牌数只统计"能把牌型提升到顺子及以上"的牌；但若牌手自己没有任何听牌
  // （drawClass === "none"，例如四张公共牌同花、靠公共牌完成），把目的标成
  // "semi-bluff" 会和"没有主要听牌"的文案自相矛盾，因此要求确有听牌结构。
  const hasOwnDraw = profile.drawClass !== "none";
  if (action === "call") return profile.bluffCatcher ? "bluff-catch" : hasOwnDraw && outs >= 8 ? "draw-realization" : "showdown-value";
  const valueReach = response ? response.weakerRangeShare * response.worseHandsContinue : 0;
  const foldReach = response ? response.betterRangeShare * response.betterHandsFold : 0;
  if (valueReach >= 0.12 && profile.relativeTier !== "weak") return valueReach < 0.22 ? "thin-value" : "value";
  if (profile.drawClass === "combo-draw" || profile.drawClass === "nut-flush-draw" || (hasOwnDraw && outs >= 8)) return "semi-bluff";
  if (foldReach >= 0.035) return "fold-equity";
  return "range-protection";
}

function compareActions(
  view: VisibleView,
  equity: number,
  potOdds: number,
  wetness: number,
  rangeAdvantage: number,
  averageWidth: number,
  ranges: WeightedOpponentRange[],
  profile: RelativeHandProfile,
): ActionComparison[] {
  const legal = view.legalActions;
  const pot = potFromView(view);
  const actor = view.seats.find((seat) => seat.id === view.viewerId)!;
  const opponents = Math.max(1, view.seats.filter((seat) => seat.id !== actor.id && !seat.folded).length);
  const outs = countImprovementOuts(view.holeCards, view.community);
  const rollout = estimateOneStreetPotential(view, ranges, equity, rangeAdvantage);
  const lines: ActionComparison[] = [];
  const add = (
    action: ActionComparison["action"],
    score: number,
    target: number | undefined,
    explanation: string,
    response?: RangeResponseAnalysis,
    rolloutValue = 0,
  ) => {
    lines.push({
      action,
      target,
      score,
      verdict: "inferior",
      purpose: actionPurpose(action, equity, outs, profile, response),
      explanation,
      worseContinue: response?.worseHandsContinue,
      betterFold: response?.betterHandsFold,
      overallFold: response?.foldShare,
      raiseBack: response?.raiseBack,
      rolloutValue,
    });
  };

  if (legal.canFold) add("fold", 0, undefined, "preserve-stack");
  if (legal.canCheck) {
    const positionBonus = actor.position === "BTN" || actor.position === "CO" ? 0.1 : 0;
    const realization = clamp(0.72 + positionBonus - wetness * 0.08 + (profile.bluffCatcher ? 0.05 : 0));
    const protectionCost = profile.vulnerability * pot * 0.035;
    add("check", equity * pot * realization - protectionCost + rollout.checkValue, undefined, profile.bluffCatcher ? "protect-showdown-value" : "realize-equity-without-investment", undefined, rollout.checkValue);
  }
  if (legal.canCall) {
    const reverseImpliedPenalty = profile.drawClass === "non-nut-flush-draw" ? legal.callAmount * 0.08 : 0;
    add("call", equity * (pot + legal.callAmount) - legal.callAmount - reverseImpliedPenalty + rollout.checkValue * 0.35, undefined, equity >= potOdds ? "price-covered" : "price-not-covered", undefined, rollout.checkValue * 0.35);
  }

  const sizingFractions = view.street === "preflop" ? [2.4, 3, 3.6] : view.street === "flop" ? [0.33, 0.55, 0.75] : view.street === "turn" ? [0.33, 0.67, 1, 1.25] : [0.33, 0.67, 1, 1.25, 1.5];
  if (legal.canBet || legal.canRaise) {
    for (const fraction of sizingFractions) {
      const desired = view.street === "preflop"
        ? view.currentBet <= view.bigBlind ? view.bigBlind * fraction : view.currentBet * fraction
        : view.currentBet === 0 ? pot * fraction : view.currentBet + Math.max(view.minRaise, pot * fraction);
      const target = legalTarget(view, desired);
      const cost = Math.max(0, target - actor.committedStreet);
      if (cost <= 0) continue;
      const sizeFraction = cost / Math.max(1, pot);
      const response = analyzeRangeResponse(view, ranges, profile, sizeFraction);
      const singleFold = clamp(response.foldShare + (1 - averageWidth) * 0.025 + rangeAdvantage * 0.04, 0.02, 0.82);
      const foldAll = Math.pow(singleFold, opponents);
      const calledEquity = clamp(
        equity - 0.04 - response.betterRangeShare * 0.15 + response.weakerRangeShare * response.worseHandsContinue * 0.06,
        0.02,
        0.97,
      );
      const valueCredit = cost * response.weakerRangeShare * response.worseHandsContinue * 0.12;
      const bluffCredit = pot * response.betterRangeShare * response.betterHandsFold * 0.10;
      const canContinueVsRaise = ["nuts", "near-nuts", "strong"].includes(profile.relativeTier) || profile.drawClass === "combo-draw";
      const raiseBackPenalty = response.raiseBack * cost * (canContinueVsRaise ? 0.12 : 0.56);
      const rolloutCredit = rollout.aggressionValue * (1 - foldAll) * (0.68 + Math.min(1.5, sizeFraction) * 0.16);
      let score = foldAll * pot + (1 - foldAll) * (calledEquity * (pot + cost * 2) - cost) + valueCredit + bluffCredit + rolloutCredit - raiseBackPenalty;
      if (opponents > 1) score *= 1 - (opponents - 1) * 0.06;
      const explanation = response.weakerRangeShare * response.worseHandsContinue >= 0.12
        ? "value-targets-continue"
        : response.betterRangeShare * response.betterHandsFold >= 0.035
          ? "better-hands-may-fold"
          : profile.drawClass !== "none" ? "semi-bluff-with-outs" : "fold-equity-dependent";
      add(legal.canBet ? "bet" : "raise", score, target, explanation, response, rolloutCredit);
    }
  }

  if (legal.canAllIn && legal.maxTo > actor.committedStreet) {
    const cost = legal.maxTo - actor.committedStreet;
    const sizeFraction = cost / Math.max(1, pot);
    const response = analyzeRangeResponse(view, ranges, profile, sizeFraction);
    const foldAll = Math.pow(clamp(response.foldShare + rangeAdvantage * 0.04, 0.02, 0.85), opponents);
    const calledEquity = clamp(equity - 0.08 - response.betterRangeShare * 0.12, 0.01, 0.96);
    let score = foldAll * pot + (1 - foldAll) * (calledEquity * (pot + cost * 2) - cost);
    const spr = actor.stack / Math.max(view.bigBlind, pot);
    if (spr > 2.2 && profile.relativeTier !== "nuts" && profile.relativeTier !== "near-nuts") score -= cost * 0.18;
    add("all-in", score, undefined, spr <= 1 ? "low-spr-commitment" : "high-variance-commitment", response);
  }

  const unique = new Map<string, ActionComparison>();
  for (const line of lines) {
    const key = `${line.action}-${line.target ?? 0}`;
    const previous = unique.get(key);
    if (!previous || line.score > previous.score) unique.set(key, line);
  }
  const sorted = [...unique.values()].sort((left, right) => right.score - left.score);
  const best = sorted[0]?.score ?? 0;
  const closeBand = Math.max(view.bigBlind * 0.7, pot * 0.045);
  for (const [index, line] of sorted.entries()) line.verdict = index === 0 ? "best" : best - line.score <= closeBand ? "close" : "inferior";
  return sorted.slice(0, 8);
}
export function analyzeVisibleDecision(view: VisibleView, iterations = 320): StrategyAnalysis {
  const actor = view.seats.find((seat) => seat.id === view.viewerId)!;
  const activeOpponents = view.seats.filter((seat) => seat.id !== actor.id && !seat.folded);
  const inferred = activeOpponents.map((seat) => ({ seat, range: inferRange(view, seat) }));
  const weighted: WeightedOpponentRange[] = inferred.map((item) => ({ ...item, combos: buildWeightedRange(view, item.range, item.seat) }));
  const handProfile = classifyRelativeHand(view.holeCards, view.community);
  const equity = estimateRangeEquity(view, weighted, iterations);
  const pot = potFromView(view);
  const potOdds = view.legalActions.toCall > 0 ? view.legalActions.callAmount / Math.max(1, pot + view.legalActions.callAmount) : 0;
  const spr = actor.stack / Math.max(view.bigBlind, pot);
  const outs = countImprovementOuts(view.holeCards, view.community);
  const board = analyzeBoard(view);
  const baseline = 1 / Math.max(2, activeOpponents.length + 1);
  const rangeAdvantage = equity - baseline;
  const averageWidth = inferred.reduce((sum, item) => sum + item.range.width, 0) / Math.max(1, inferred.length);
  const rangeResponse = analyzeRangeResponse(view, weighted, handProfile, view.street === "preflop" ? 0.75 : 0.55);
  const candidates = compareActions(view, equity, potOdds, board.wetness, rangeAdvantage, averageWidth, weighted, handProfile);
  const tightest = [...inferred].sort((left, right) => left.range.width - right.range.width)[0];
  return {
    equity,
    potOdds,
    spr,
    outs,
    boardTexture: board.texture,
    boardSummary: board.summary,
    rangeAdvantage,
    positionSummary: actor.position,
    rangeSummary: tightest ? `${tightest.seat.name}:${tightest.range.label}:${Math.round(tightest.range.width * 100)}` : "no-active-range",
    opponentRanges: inferred.map((item) => item.range),
    handProfile,
    rangeResponse,
    candidates,
    mathSummary: `equity=${(equity * 100).toFixed(0)};price=${(potOdds * 100).toFixed(0)};spr=${spr.toFixed(1)};outs=${outs}`,
    uncertainty: iterations < 250 ? "coarse" : activeOpponents.length > 2 ? "multiway" : "modelled-range",
  };
}
