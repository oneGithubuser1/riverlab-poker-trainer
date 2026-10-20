import { ACTION_LABELS, buildReviewSnapshot } from "./engine";
import { estimateEquity } from "./evaluator";
import { analyzeVisibleDecision } from "./strategy";
import type {
  CoachAdvice,
  DecisionRating,
  DecisionRecord,
  FullGameState,
  HandReview,
  PlayerActionInput,
  PlayerActionType,
  PlayerViewState,
} from "./types";

export const GLOSSARY: Record<string, { zh: string; detail: string }> = {
  open: { zh: "率先加注", detail: "翻前无人入池时第一次加注进入底池。" },
  limp: { zh: "跛入", detail: "翻前只跟大盲而不加注，通常会让范围过于透明。" },
  "3-bet": { zh: "再加注", detail: "面对一次加注后的第二次加注。" },
  "4-bet": { zh: "四次下注", detail: "面对 3-bet 后再次加注。" },
  "c-bet": { zh: "持续下注", detail: "翻前主动者在翻牌后继续下注。" },
  barrel: { zh: "连续开火", detail: "在多个街道连续下注。" },
  "check-raise": { zh: "过牌加注", detail: "先过牌，面对下注后再加注。" },
  donk: { zh: "领先下注", detail: "前一街跟注者在下一街抢先向主动者下注。" },
  jam: { zh: "推全下", detail: "把剩余筹码全部下注。" },
  nuts: { zh: "坚果牌", detail: "当前公共牌下理论上最强的组合。" },
  range: { zh: "范围", detail: "某个玩家在当前线路下可能持有的全部手牌集合。" },
  equity: { zh: "权益", detail: "若后续牌正常发完，这手牌平均能分得底池的比例。" },
  EV: { zh: "期望值", detail: "长期重复同类决策时的平均收益。" },
  blocker: { zh: "阻断牌", detail: "自己持有的牌降低对手拥有某些强牌组合的概率。" },
  SPR: { zh: "筹码底池比", detail: "有效剩余筹码除以当前底池，用来衡量后续下注空间。" },
  outs: { zh: "补牌", detail: "下一张公共牌能把牌型提升到顺子及以上的未知牌张数（补中顺子/同花，或两对、三条升葫芦，葫芦升四条）；仍停留在顺子以下的改善（提升踢脚、高牌配成一对、一对变两对/三条）都不计入。" },
  "pot odds": { zh: "底池赔率", detail: "跟注成本占跟注后总底池的比例。" },
  "thin value": { zh: "薄价值", detail: "用中等强度牌向更弱但可能跟注的牌下注。" },
  cooler: { zh: "冤家牌", detail: "双方都极强、通常很难合理逃脱的牌局。" },
  bluff: { zh: "诈唬", detail: "用较弱牌下注，目标是让更好的牌弃牌。" },
  "semi-bluff": { zh: "半诈唬", detail: "当前可能落后，但仍有较多补牌的诈唬。" },
  "near-nuts": { zh: "近坚果牌", detail: "非常接近当前理论最强，但仍存在少量更强组合。" },
  overpair: { zh: "超对", detail: "自己的口袋对子高于公共牌最大的点数，例如 KK 面对 Q-7-2。" },
  TPTK: { zh: "顶对顶踢脚", detail: "用公共牌最高点数配成一对，同时持有可用的最大踢脚。" },
  "top pair": { zh: "顶对", detail: "用一张底牌与公共牌最高点数配成一对。" },
  "middle pair": { zh: "中对", detail: "与公共牌中间点数配成的一对，通常有摊牌价值但不宜打大底池。" },
  "bluff-catcher": { zh: "抓诈唬牌", detail: "通常打不过对手的价值下注，只能击败其诈唬部分。" },
  "nut draw": { zh: "坚果听牌", detail: "补中后通常能形成当时最大的顺子或同花。" },
  "non-nut draw": { zh: "非坚果听牌", detail: "即使补中也可能输给更大的同类成牌。" },
  "showdown value": { zh: "摊牌价值", detail: "不需要继续下注，直接摊牌时仍可能击败对手部分范围。" },
  "reverse implied odds": { zh: "反向隐含赔率", detail: "补中看似变强后仍可能输给更大牌，导致后续额外损失。" },
  "value target": { zh: "价值目标", detail: "下注时希望被哪些更弱的牌跟注；找不到目标时不应机械价值下注。" },
  "range advantage": { zh: "范围优势", detail: "一方的整体可能持牌在当前牌面上拥有更多强牌和权益。" },
};

function potFromView(view: PlayerViewState): number {
  return view.seats.reduce((sum, seat) => sum + seat.committedHand, 0);
}

function actionText(action: PlayerActionType, target?: number, bigBlind = 1): string {
  const base = ACTION_LABELS[action];
  if ((action === "bet" || action === "raise") && target) return `${base}到 ${target}（${(target / bigBlind).toFixed(1)}BB）`;
  return base;
}

function betTarget(view: PlayerViewState, fraction: number): number {
  const legal = view.legalActions;
  const pot = potFromView(view);
  if (view.street === "preflop") {
    const target = view.currentBet <= view.bigBlind ? view.bigBlind * 2.4 : view.currentBet * 3;
    return Math.max(legal.minRaiseTo, Math.min(legal.maxTo, Math.round(target)));
  }
  const chips = Math.max(view.bigBlind, Math.round(pot * fraction));
  const target = view.currentBet === 0 ? chips : view.currentBet + Math.max(view.minRaise, chips);
  return Math.max(view.currentBet === 0 ? legal.minBetTo : legal.minRaiseTo, Math.min(legal.maxTo, target));
}

export function buildCoachAdvice(view: PlayerViewState): CoachAdvice {
  const hero = view.seats.find((seat) => seat.id === view.viewerId)!;
  const legal = view.legalActions;
  const pot = potFromView(view);
  const analysis = analyzeVisibleDecision(view, 420);
  const potOdds = analysis.potOdds;
  const equity = analysis.equity;
  const outs = analysis.outs;
  const spr = analysis.spr;
  const profile = analysis.handProfile;
  const rangeResponse = analysis.rangeResponse;
  const made = profile.madeLabel;
  // 河牌之后没有公共牌可发，任何"下一张牌／听牌／补牌／改善机会"的说法在河牌都不成立。
  const river = view.street === "river";
  const valueReach = rangeResponse.weakerRangeShare * rangeResponse.worseHandsContinue;
  const betterFoldReach = rangeResponse.betterRangeShare * rangeResponse.betterHandsFold;
  const strongDraw = ["combo-draw", "nut-flush-draw", "open-ended"].includes(profile.drawClass);
  const activeOpponentCount = view.seats.filter((seat) => seat.id !== view.viewerId && !seat.folded).length;
  const neutralEquity = estimateEquity(
    view.holeCards,
    view.community,
    Math.max(1, activeOpponentCount),
    1200,
    `${view.handId}-${view.viewerId}-neutral-${view.community.map((card) => card.id).join("-")}-${activeOpponentCount}`,
  );
  const reasons: string[] = [];
  const alternatives: string[] = [];
  const concepts = new Set<string>(["range", "equity"]);
  let action: PlayerActionType = legal.canCheck ? "check" : "fold";
  let target: number | undefined;
  let confidence: CoachAdvice["confidence"] = "中";

  if (view.street !== "preflop") {
    reasons.push(`先定性：你现在是${profile.madeLabel}，相对定位为${profile.relativeLabel}。`);
    reasons.push(profile.explanation);
    if (profile.drawClass !== "none") reasons.push(`听牌质量：${profile.drawLabel}。`);
    if (profile.blockers.length > 0) reasons.push(...profile.blockers.map((item) => `阻断牌：${item}。`));
    if (profile.bluffCatcher) concepts.add("bluff-catcher");
    if (profile.madeClass === "overpair") concepts.add("overpair");
    if (profile.madeClass === "top-pair-top-kicker") concepts.add("TPTK");
    if (profile.madeClass === "top-pair" || profile.madeClass === "weak-top-pair") concepts.add("top pair");
    if (profile.madeClass === "middle-pair") concepts.add("middle pair");
    if (profile.relativeTier === "near-nuts") concepts.add("near-nuts");
    if (profile.drawClass === "nut-flush-draw" || (profile.drawClass === "combo-draw" && profile.nutPotential)) concepts.add("nut draw");
    if (profile.drawClass === "non-nut-flush-draw") {
      concepts.add("non-nut draw");
      concepts.add("reverse implied odds");
    }
    concepts.add("showdown value");
    concepts.add("value target");
    concepts.add("range advantage");
  }

  if (view.street === "preflop") {
    const unopened = view.currentBet <= view.bigBlind;
    if (legal.toCall === 0 && !legal.canRaise) {
      action = "check";
      reasons.push("大盲位可以免费看翻牌，不需要主动扩大弱范围的底池。");
      alternatives.push("若对手都很被动，翻后再根据牌面决定是否领先下注。 ");
    } else if (unopened && equity >= 0.42 && legal.canRaise) {
      action = "raise";
      target = betTarget(view, 0.5);
      confidence = equity > 0.58 ? "高" : "中";
      concepts.add("open");
      reasons.push(`${hero.position} 的手牌强度足以进入率先加注范围，主动拿下盲注并保留进攻权。`);
      reasons.push("2.2–2.5BB 的 open 尺度能让强牌和可玩牌使用同一套大小。");
      alternatives.push("若桌上后位玩家频繁 3-bet，可收紧范围而不是临时改变尺度。 ");
    } else if (!unopened && equity >= 0.69 && legal.canRaise) {
      action = "raise";
      target = betTarget(view, 0.66);
      concepts.add("3-bet");
      reasons.push("面对 open 仍有明显牌力优势，3-bet 可以获取价值并压缩多人底池。");
      alternatives.push("对极紧范围可以保留少量跟注，隐藏自己的强牌。 ");
    } else if (unopened && legal.toCall > 0) {
      action = "fold";
      concepts.add("limp");
      reasons.push("\u65e0\u4eba\u7387\u5148\u52a0\u6ce8\u65f6\u91c7\u7528 raise-or-fold\uff1b\u8fd9\u624b\u724c\u4e0d\u503c\u5f97\u4e3a\u4e86 limp \u6295\u5165\u7b79\u7801\u3002");
      alternatives.push("\u540e\u4f4d\u53ef\u6269\u5927 open \u8303\u56f4\uff0c\u4f46\u4ecd\u5e94\u4e3b\u52a8\u52a0\u6ce8\u800c\u4e0d\u662f\u5e73\u8ddf\u5927\u76f2\u3002");
    } else if (legal.toCall > 0 && equity >= potOdds && equity >= 0.30) {
      action = "call";
      concepts.add("pot odds");
      reasons.push(`预计权益约 ${(equity * 100).toFixed(0)}%，高于 ${(potOdds * 100).toFixed(0)}% 的即时底池赔率。`);
      alternatives.push("位置不利或后面容易遭到再加注时，边缘跟注应更谨慎。 ");
    } else {
      action = legal.canCheck ? "check" : "fold";
      confidence = "高";
      reasons.push("当前组合对对手范围实现权益困难，继续投入容易被支配。");
      alternatives.push("弃掉边缘牌能把筹码留给位置和范围都更有利的机会。 ");
    }
  } else if (legal.toCall > 0) {
    concepts.add("pot odds");
    concepts.add("SPR");
    const raiseReady = ["nuts", "near-nuts"].includes(profile.relativeTier)
      || (["set", "trips", "two-pair", "straight", "flush", "full-house", "quads", "straight-flush"].includes(profile.madeClass) && equity >= 0.60);
    const modelPrefersRaise = analysis.candidates[0]?.action === "raise";

    if (raiseReady && legal.canRaise) {
      if (spr <= 0.85 && legal.canAllIn) {
        action = "all-in";
        concepts.add("jam");
        reasons.push("SPR 已很低，继续采用小尺度会让后续筹码不足；强价值范围可以自然 jam（推全下）。");
      } else {
        action = "raise";
        target = betTarget(view, profile.vulnerability >= 0.55 ? 0.72 : 0.55);
        reasons.push(river
          ? `${profile.madeLabel}位于强价值区，加注目标是让较弱的成牌愿意继续投入，而不是单纯因为权益超过某个阈值。`
          : `${profile.madeLabel}位于强价值区，加注目标是让较弱成牌和高质量听牌付费，而不是单纯因为权益超过某个阈值。`);
        reasons.push(rangeResponse.summary);
      }
      confidence = profile.relativeTier === "nuts" || profile.relativeTier === "near-nuts" ? "高" : "中";
      alternatives.push("若牌面非常干燥且对手诈唬频率高，可保留部分跟注来保护自己的跟注范围。 ");
    } else if (strongDraw && legal.canRaise && modelPrefersRaise) {
      action = "raise";
      target = betTarget(view, 0.55);
      concepts.add("semi-bluff");
      concepts.add("outs");
      reasons.push(`${profile.drawLabel}让这次加注成为半诈唬：对手现在弃牌可以立即获利，被跟注后仍有改善机会。`);
      reasons.push(`粗略模型认为更好牌可弃掉的覆盖量约 ${Math.round(betterFoldReach * 100)}%，因此允许加入主动线路。`);
      alternatives.push("面对几乎不弃牌的跟注站，应减少听牌加注，改用跟注实现权益。 ");
    } else if (profile.bluffCatcher) {
      concepts.add("bluff-catcher");
      if (equity >= potOdds + 0.035) {
        action = "call";
        reasons.push(`这手牌已经降级为抓诈唬牌：通常打不过价值下注，只能击败对手的 bluff。当前约 ${(equity * 100).toFixed(0)}% 范围权益覆盖了 ${(potOdds * 100).toFixed(0)}% 的跟注门槛。`);
        alternatives.push("若对手长期极少诈唬，即使赔率刚刚够也可以偏向弃牌。 ");
      } else {
        action = "fold";
        confidence = "高";
        reasons.push(`作为抓诈唬牌，你需要对手拥有足够 bluff；当前权益没有覆盖 ${(potOdds * 100).toFixed(0)}% 的价格，因此弃牌。`);
        alternatives.push("只有观察到对手明显过度诈唬时，才扩大 bluff-catch 范围。 ");
      }
    } else if (equity >= potOdds + 0.035 || (outs >= 8 && equity >= potOdds - 0.025)) {
      action = "call";
      reasons.push(`跟注需要 ${(potOdds * 100).toFixed(0)}% 权益，当前对公开行动推断范围的近似权益为 ${(equity * 100).toFixed(0)}%。`);
      if (outs >= 8) {
        concepts.add("semi-bluff");
        concepts.add("outs");
        reasons.push(`${outs} 张补牌能把牌型提升到顺子及以上，为继续游戏提供缓冲；但补牌不等于干净且必胜的牌，仍要考虑对手的反向隐含赔率。`);
      }
      if (profile.drawClass === "non-nut-flush-draw") reasons.push("这是非坚果同花听牌：即使补中也可能输给更大同花，因此要为反向隐含赔率留出安全边际。 ");
      alternatives.push("位置不利、多人底池或对手范围极紧时，应把近似权益向下修正。 ");
    } else {
      action = "fold";
      confidence = "高";
      reasons.push(river
        ? `当前相对牌力不足以覆盖 ${(potOdds * 100).toFixed(0)}% 的跟注门槛，弃牌能阻止负 EV 累积。`
        : `当前相对牌力与听牌质量不足以覆盖 ${(potOdds * 100).toFixed(0)}% 的跟注门槛，弃牌能阻止负 EV 累积。`);
      alternatives.push("不要因为已经投入筹码而继续；此前投入属于沉没成本。 ");
    }
  } else {
    concepts.add("SPR");
    const clearValue = ["nuts", "near-nuts"].includes(profile.relativeTier)
      || (profile.relativeTier === "strong" && valueReach >= 0.10)
      || (profile.madeClass === "top-pair-top-kicker" && valueReach >= 0.16);

    if (clearValue && legal.canBet) {
      action = "bet";
      target = betTarget(view, profile.vulnerability >= 0.56 ? 0.67 : 0.50);
      reasons.push(`${profile.madeLabel}具备价值下注条件；关键不是“牌型够大”，而是模型仍找到约 ${Math.round(valueReach * 100)}% 的整体范围覆盖量由较差牌继续。`);
      if (rangeResponse.valueTargets.length > 0) reasons.push(`主要价值目标（希望跟注的较差牌）包括：${rangeResponse.valueTargets.join("、")}。`);
      reasons.push(profile.vulnerability >= 0.56
        ? river
          ? "当前牌力较脆弱，尺度可以偏大，让较弱的成牌为摊牌付出更高价格。"
          : "牌面或当前牌力较脆弱，尺度可以偏大，向听牌和高张收取价格。"
        : "牌面较稳定，使用中小尺度可让更多较差牌继续。 ");
      alternatives.push("若找不到任何更差跟注范围，应选择过牌，而不是机械价值下注。 ");
    } else if (strongDraw && legal.canBet && betterFoldReach >= 0.02) {
      action = "bet";
      target = betTarget(view, 0.45);
      concepts.add("semi-bluff");
      concepts.add("outs");
      reasons.push(`${profile.drawLabel}适合作为半诈唬候选：一部分更好牌会立即弃掉，被跟注后仍有补牌。`);
      reasons.push(`粗略估计“更好牌且愿意弃牌”的整体覆盖量约 ${Math.round(betterFoldReach * 100)}%。`);
      alternatives.push("当对手几乎不弃牌时，过牌实现权益通常更好。 ");
    } else {
      action = "check";
      if (profile.bluffCatcher || profile.relativeTier === "medium") {
        reasons.push(`${profile.madeLabel}具有摊牌价值，但较差跟注目标不足；过牌是控池，不等于放弃。`);
      } else {
        reasons.push("当前既缺少可靠的较差跟注范围，也缺少足够的更好弃牌范围，因此没有明确下注目的。 ");
      }
      alternatives.push("只有对手对小注弃牌过多，或你持有关键 blocker 时，才增加小尺度 bluff。 ");
    }
  }

  if (action === "bet" || action === "raise") {
    const matchingSize = analysis.candidates.find((line) => line.action === action && line.target !== undefined);
    if (matchingSize?.target !== undefined) target = matchingSize.target;
  }  if ((action === "raise" || action === "bet") && target === legal.maxTo && spr <= 1) action = "all-in";
  const modelBest = analysis.candidates[0];
  if (modelBest && modelBest.action !== action) {
    confidence = "低";
    alternatives.unshift(
      `候选线路的粗略 EV 模型把“${actionText(modelBest.action, modelBest.target, view.bigBlind)}”排在前面；规则建议仍选择“${actionText(action, target, view.bigBlind)}”，说明这里接近边界，需结合对手倾向调整。`,
    );
  }
  const actionLabel = actionText(action, target, view.bigBlind);
  const selectedCandidate = analysis.candidates.find((line) => {
    if (line.action !== action) return false;
    if (target === undefined || line.target === undefined) return true;
    return Math.abs(line.target - target) <= Math.max(1, target * 0.2);
  });
  const purpose = selectedCandidate?.purpose;
  // 坚果／近坚果档不存在（或几乎不存在）"比它更好的牌"，因此该档位绝不能用
  // "让更好的牌弃掉"这类诈唬口径描述下注目的（见下方 actionReason 分支）。
  const nutTier = profile.relativeTier === "nuts" || profile.relativeTier === "near-nuts";
  // 板面本身即坚果等情形下，对手范围里根本没有愿意继续的更差牌，不能断言"从更差的牌取值"。
  const noValueTarget = valueReach < 0.02;
  const neutralPercent = Math.round(neutralEquity * 100);
  const rangePercent = Math.round(equity * 100);
  const pricePercent = Math.round(potOdds * 100);
  const rangeShift = Math.abs(neutralEquity - equity) >= 0.08
    ? `不考虑对手打法时牌面胜率约 ${neutralPercent}%；结合对手公开行动后，范围胜率约 ${rangePercent}%。`
    : `牌面胜率约 ${neutralPercent}%，结合公开行动后的范围胜率约 ${rangePercent}%。`;

  let actionReason: string;
  if (action === "fold") {
    actionReason = legal.toCall > 0
      ? `${rangeShift} 跟注需要约 ${pricePercent}%，继续投入不划算，所以弃牌。`
      : "这手牌在当前位置缺少足够牌力和可玩性，主动放弃能避免进入长期亏损的底池。";
  } else if (action === "call") {
    actionReason = `${rangeShift} 当前跟注门槛约 ${pricePercent}%，价格可以接受；跟注能继续游戏，又不会把底池立刻做大。`;
  } else if (action === "check") {
    actionReason = profile.bluffCatcher || profile.relativeTier === "medium"
      ? `${profile.madeLabel}有一定摊牌价值，但暂时找不到足够多会跟注的更差牌，过牌控池更清楚。`
      : river
        ? "当前没有明确的价值目标或高质量诈唬目标，河牌过牌保留摊牌价值比勉强下注更好。"
        : "当前没有明确的价值目标或高质量诈唬目标，免费看下一张牌比勉强下注更好。";
  } else if (action === "all-in") {
    actionReason = "你的牌力与低 SPR 都支持投入剩余筹码；继续采用小尺度已经没有足够的后续下注空间。";
  } else if (nutTier) {
    const strengthText = profile.relativeTier === "nuts"
      ? "是坚果牌：当前不存在比它更好的牌"
      : "已经接近坚果：能赢它的组合极少";
    if (noValueTarget) {
      actionReason = `${profile.madeLabel}${strengthText}，但对手范围里愿意继续的更差牌也不多，这手下注主要是薄价值，不必期待很多跟注。`;
    } else if (river) {
      actionReason = `${profile.madeLabel}${strengthText}，河牌下注的目标就是从对手的跟注里拿到最大价值。`;
    } else {
      actionReason = `${profile.madeLabel}${strengthText}，下注的目标就是从更差的牌拿到最大价值，同时不让对手免费看下一张牌。`;
    }
  } else if (purpose === "value" || purpose === "thin-value") {
    actionReason = `${profile.madeLabel}可以做价值下注：模型仍能找到愿意继续的更差牌，推荐${actionLabel}来收费。`;
  } else if (purpose === "semi-bluff") {
    actionReason = `${profile.drawLabel}适合半诈唬：对手现在弃牌可以直接获利，被跟注后你仍有补牌机会。`;
  } else if (purpose === "fold-equity") {
    actionReason = river
      ? `${profile.madeLabel}这次下注主要靠弃牌权益：让一部分当前更强的牌弃掉。`
      : `${profile.madeLabel}这次下注主要靠弃牌权益：让一部分当前更强的牌弃掉，同时避免对手免费实现权益。`;
  } else {
    // range-protection：描述为保护性下注，兜底时也不套用"让更好的牌弃掉"的诈唬口径。
    actionReason = river
      ? `${profile.madeLabel}适合做薄价值下注：向愿意继续的更差牌取值，让对手用更弱的牌做决定。`
      : `${profile.madeLabel}适合做保护性下注：既向可能继续的更差牌取值，也不给对手免费实现权益的机会。`;
  }

  let lesson: string;
  if (view.street === "preflop") {
    lesson = action === "raise"
      ? "翻前先看位置和前方行动：率先入池通常采用加注，而不是只跟大盲。"
      : action === "call"
        ? "翻前跟注不能只看牌面胜率，还要考虑位置和身后被再次加注的风险。"
        : "弃牌不是损失；翻前少进入劣势底池，是新手最容易获得的长期优势。";
  } else if (profile.bluffCatcher) {
    lesson = "抓诈唬牌通常打不过价值牌，只能赢诈唬；决定是否跟注时，先比较价格和对手可能的诈唬量。";
  } else if (profile.drawClass === "non-nut-flush-draw") {
    lesson = "非坚果听牌补中后仍可能输给更大同花，所以不能把所有 outs 都当成绝对安全牌。";
  } else if (purpose === "value" || purpose === "thin-value") {
    lesson = "价值下注前先问：有哪些更差的牌会跟我？如果答不出来，通常应该考虑过牌。";
  } else if (purpose === "semi-bluff") {
    lesson = "半诈唬需要两条获胜路径：现在让对手弃牌，或者被跟注后靠补牌反超。";
  } else if (action === "check") {
    lesson = "过牌不等于软弱；没有明确下注目的时，控池和实现权益就是正确计划。";
  } else if (action === "fold") {
    lesson = "已经投入的筹码是沉没成本，只比较现在继续投入是否值得。";
  } else {
    lesson = "每次下注都要先说清目的：取价值、诈唬、半诈唬或保护，不能只因为自己可能领先。";
  }

  const nextStreet = view.street === "flop" ? "转牌" : "河牌";
  let nextPlan: string;
  if (action === "fold") {
    nextPlan = "这手到此结束。下一手重新从位置、前方行动和起手牌范围开始判断。";
  } else if (view.street === "river") {
    nextPlan = action === "bet" || action === "raise" || action === "all-in"
      ? "河牌已经没有后续公共牌；如果遭到大幅再加注，要重新判断对手是否几乎只剩强价值牌。"
      : "河牌没有下一张牌；当前目标是用合适价格进入摊牌，不再为不存在的补牌付费。";
  } else if (view.street === "preflop") {
    nextPlan = action === "raise"
      ? "被跟注后，根据翻牌是否击中强对、强听牌以及牌面干湿决定是否持续下注；面对再加注要收紧。"
      : action === "call"
        ? "翻牌击中强对或强听牌可以继续；完全错过且面对大注时及时减速。"
        : "免费看翻牌后再判断是否击中对子或强听牌，不要因为免费入池就强行打大底池。";
  } else if (strongDraw) {
    nextPlan = `到${nextStreet}后：补中时继续价值或半诈唬；没有补中时，只在对手会弃牌且你有合适阻断牌时继续开火。`;
  } else if (action === "bet" || action === "raise" || action === "all-in") {
    nextPlan = `被跟注后：安全的${nextStreet}可以继续按价值计划；完成明显听牌、出现高张或公共牌成对时要重新评估。`;
  } else if (action === "call") {
    nextPlan = `到${nextStreet}若对手继续大注，不要自动再跟；重新比较范围胜率、价格以及你的牌是否已降级为抓诈唬牌。`;
  } else {
    nextPlan = "若对手随后下注：小注可以结合价格继续，中大注则先判断你的牌是否只有抓诈唬价值。";
  }

  const beginner = {
    handSummary: view.street === "preflop"
      ? `${profile.madeLabel} · ${hero.position} 位置`
      : `${profile.madeLabel} · ${profile.relativeLabel}${profile.drawClass !== "none" ? ` · ${profile.drawLabel}` : ""}`,
    actionReason,
    lesson,
    nextPlan,
  };

  return {
    action,
    target,
    actionLabel,
    summary: `推荐 ${actionLabel} · ${made} · ${hero.position}`,
    reasons,
    alternatives,
    concepts: [...concepts],
    metrics: {
      equity,
      neutralEquity,
      potOdds,
      outs,
      spr,
      equityLabel: "对公开行动推断范围的近似权益",
    },
    confidence,
    beginner,
    analysis,
  };
}

export function rateDecision(chosen: PlayerActionInput, advice: CoachAdvice): { rating: DecisionRating; note: string } {
  if (chosen.type === advice.action) {
    if ((chosen.type === "bet" || chosen.type === "raise") && chosen.amount && advice.target) {
      const deviation = Math.abs(chosen.amount - advice.target) / Math.max(1, advice.target);
      if (deviation > 0.55) return { rating: "边缘", note: "线路合理，但尺度偏离推荐较多。" };
      if (deviation > 0.25) return { rating: "合理", note: "方向正确，尺度仍有优化空间。" };
    }
    return { rating: "优秀", note: "与当时可见信息下的首选线路一致。" };
  }
  const passivePair = new Set([`${chosen.type}-${advice.action}`, `${advice.action}-${chosen.type}`]);
  if (passivePair.has("check-call") || passivePair.has("call-check")) return { rating: "合理", note: "两条线路接近，区别主要在是否面对下注。" };
  if ((advice.action === "raise" || advice.action === "bet") && chosen.type === "call") {
    return { rating: "合理", note: "跟注保留权益，但放弃了一部分价值或弃牌率。" };
  }
  if (advice.action === "fold" && chosen.type !== "fold") return { rating: "失误", note: "投入筹码但当前权益没有覆盖价格。" };
  if ((chosen.type === "all-in") && advice.action !== "all-in") return { rating: "失误", note: "全下让风险超过了当前范围优势。" };
  return { rating: "边缘", note: "不是首选线路；需要特定对手倾向才能支持。" };
}

export function createHandReview(state: FullGameState, decisions: DecisionRecord[]): HandReview {
  if (!state.lastResult) throw new Error("Cannot review an unfinished hand");
  const keyDecisionIndexes = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.rating === "失误" || decision.rating === "边缘" || decision.pot >= state.bigBlind * 20)
    .map(({ index }) => index);
  if (keyDecisionIndexes.length === 0 && decisions.length > 0) keyDecisionIndexes.push(decisions.length - 1);
  const mistakes = decisions.filter((decision) => decision.rating === "失误").length;
  const edges = decisions.filter((decision) => decision.rating === "边缘").length;
  const takeaway = mistakes > 0
    ? `本手有 ${mistakes} 个明显失误；优先检查赔率门槛和全下前的 SPR。`
    : edges > 0
      ? `整体线路可行，${edges} 个边缘节点可通过位置和下注尺度进一步优化。`
      : "本手决策与可见信息下的推荐线路高度一致，不要因最终输赢改变评价。";
  return {
    handId: state.handId,
    seed: state.seed,
    result: structuredClone(state.lastResult),
    snapshot: buildReviewSnapshot(state),
    decisions: structuredClone(decisions),
    keyDecisionIndexes,
    takeaway,
  };
}
