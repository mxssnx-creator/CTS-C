# Recover retained own model closes after restart

Target reviewed: `5cb4f257b09874ec179747c3ae48017e7a681026` on `main`.

An engine checkpoint can retain a Live paper close while its exact owned venue
episode has no `execution_simulation` row. Runtime hydration previously installed
only the observer for future closes. A restart therefore left the retained close
unpaired indefinitely even though the model evidence was still available.

After acquiring the exclusive writer lease and verifying the hydrated checkpoint
generation, runtime now repairs missing comparison rows from retained Live model
closes. The executor accepts only position IDs already tracked by its own durable
journal. For owned lots, lane, symbol, direction and configuration must match.
The repair reads the owned-lot map once and does not clone the full engine state.
An existing comparison row remains authoritative and is never replaced by a
different checkpoint outcome. Failed repair fences further use of that runtime
and releases its own lease before any execution can start.

This operation records comparisons only. It submits no order or execution intent,
does not import unowned episodes, and does not change model or venue outcomes,
fees, qualification gates, SL/trailing geometry, or retained-history limits.
Retired configurations remain eligible for matching their exact owned episode;
current configuration membership is not substituted for historical identity.

## Verification

The final four-test regression fixture fails three cases on the unchanged target
and passes all four after the fix. It exercises a disk-backed restart, a competing
writer, an absent model close, an unowned model episode, an authoritative prior
comparison, and a conflicting retained identity. Synthetic losing model/venue
values stay negative; they are functional fixtures, not trading observations.

Local validation: 266 tests passed, zero failed/skipped; TypeScript typecheck and
production build passed. Required hosted checks additionally cover runtime,
browser, report, Python integration and Docker smoke paths before publication.

## Remaining acceptance

The historical x02 AIN episode's missing model exit is not reconstructed. Its
actual loss remains `-0.06651669999999962 VST`; a complete model/venue pair requires
an authentic retained model close. This fix cannot recover data that never
closed or is no longer retained. The original missing `result.json`, 2/12 minute
readiness, incomplete Active coverage, full twelve-symbol warmup/load assessment,
and sufficient separate forward samples remain open. No current financed run,
positive execution PF, native fee calibration, or fresh venue clearance is
established by these offline tests.
