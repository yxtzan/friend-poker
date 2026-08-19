export class SettlementRuleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettlementRuleError";
  }
}
