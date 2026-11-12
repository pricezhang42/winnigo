// Start this process's clock at a fixed instant so date-dependent checks are repeatable.
// Import it before any other module. Elapsed time still advances, so timeouts and job
// timing behave normally; only the starting point is fixed. PostgreSQL's own now() is unchanged.
const RealDate = Date;
const offset = (instant) => RealDate.parse(instant) - RealDate.now();

export function startClockAt(instant) {
  if (Number.isNaN(RealDate.parse(instant))) throw Error('Invalid clock instant: ' + instant);
  const shift = offset(instant);
  class FixedStartDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + shift]));
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = FixedStartDate;
}
