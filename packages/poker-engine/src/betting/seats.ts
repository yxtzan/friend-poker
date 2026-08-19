import type { BlindPositions, Seat } from "./types.js";

function validateSeat(seat: Seat, label: string): void {
  if (!Number.isInteger(seat) || seat < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function orderedUniqueSeats(seats: readonly Seat[], minimumCount: number): readonly Seat[] {
  if (seats.length < minimumCount) {
    throw new RangeError(`At least ${minimumCount} eligible seat(s) are required`);
  }

  for (const seat of seats) {
    validateSeat(seat, "Seat");
  }

  const unique = [...new Set(seats)].sort((left, right) => left - right);
  if (unique.length !== seats.length) {
    throw new RangeError("Participant seats must be unique");
  }
  return unique;
}

export function nextEligibleSeat(fromSeat: Seat, participantSeats: readonly Seat[]): Seat {
  validateSeat(fromSeat, "Starting seat");
  const seats = orderedUniqueSeats(participantSeats, 1);
  return seats.find((seat) => seat > fromSeat) ?? seats[0]!;
}

export function moveButton(previousButtonSeat: Seat, nextHandSeats: readonly Seat[]): Seat {
  orderedUniqueSeats(nextHandSeats, 2);
  return nextEligibleSeat(previousButtonSeat, nextHandSeats);
}

export function determineBlindPositions(
  buttonSeat: Seat,
  participantSeats: readonly Seat[],
): BlindPositions {
  const seats = orderedUniqueSeats(participantSeats, 2);
  if (!seats.includes(buttonSeat)) {
    throw new RangeError("Button seat must belong to a hand participant");
  }

  if (seats.length === 2) {
    const bigBlindSeat = nextEligibleSeat(buttonSeat, seats);
    return Object.freeze({
      buttonSeat,
      smallBlindSeat: buttonSeat,
      bigBlindSeat,
      firstPreflopSeat: buttonSeat,
      firstPostflopSeat: bigBlindSeat,
    });
  }

  const smallBlindSeat = nextEligibleSeat(buttonSeat, seats);
  const bigBlindSeat = nextEligibleSeat(smallBlindSeat, seats);
  return Object.freeze({
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    firstPreflopSeat: nextEligibleSeat(bigBlindSeat, seats),
    firstPostflopSeat: nextEligibleSeat(buttonSeat, seats),
  });
}
