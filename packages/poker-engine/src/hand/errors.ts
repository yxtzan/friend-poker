export class HandOrchestrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HandOrchestrationError";
  }
}
