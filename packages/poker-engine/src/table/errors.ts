export class TableDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TableDomainError";
  }
}
