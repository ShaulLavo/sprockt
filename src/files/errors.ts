// Refusals the file service makes on its own, so callers can tell them from filesystem failures.

/** Something already exists where a create or a move was going to put an entry. */
export class DestinationExistsError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" already exists`);
    this.name = "DestinationExistsError";
  }
}

/** A folder cannot be moved into itself or into anything inside it. */
export class MoveIntoItselfError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`"${from}" cannot be moved to "${to}", which is inside it`);
    this.name = "MoveIntoItselfError";
  }
}
