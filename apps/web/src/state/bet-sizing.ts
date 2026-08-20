import type { ViewerLegalActions } from "@friend-poker/shared";

export type PotQuickSize = "HALF_POT" | "TWO_THIRDS_POT" | "POT";

const POT_MULTIPLIERS: Record<PotQuickSize, number> = {
  HALF_POT: 0.5,
  TWO_THIRDS_POT: 2 / 3,
  POT: 1,
};

export function calculatePotQuickTarget(input: {
  readonly actions: ViewerLegalActions;
  readonly potSize: number;
  readonly currentBet: number;
  readonly size: PotQuickSize;
}): number | null {
  const { actions } = input;
  const multiplier = POT_MULTIPLIERS[input.size];
  const facingBet = actions.callAmount > 0;
  const minimum = actions.canBet
    ? actions.minimumBet
    : actions.canRaise
      ? actions.minimumRaiseTo
      : null;
  const maximum = actions.canBet
    ? actions.maximumBet
    : actions.canRaise
      ? actions.maximumRaiseTo
      : null;
  if (minimum === null || maximum === null) return null;

  const potAfterCall = input.potSize + (facingBet ? actions.callAmount : 0);
  const rawTarget = facingBet
    ? input.currentBet + Math.floor(potAfterCall * multiplier)
    : Math.floor(input.potSize * multiplier);
  return Math.max(minimum, Math.min(maximum, rawTarget));
}
