export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class TestClock implements Clock {
  #current: Date;

  constructor(initial = "2026-01-01T00:00:00.000Z") {
    this.#current = new Date(initial);
    if (Number.isNaN(this.#current.valueOf())) throw new TypeError("initial must be an ISO date");
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) throw new TypeError("milliseconds must be finite");
    this.#current = new Date(this.#current.valueOf() + milliseconds);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(instant: string | Date): void {
    const next = new Date(instant);
    if (Number.isNaN(next.valueOf())) throw new TypeError("instant must be a valid date");
    this.#current = next;
  }
}
