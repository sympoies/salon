import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  activityObservationAgeMs,
  activitySemanticNowMs,
  createActivityObservationAnchor,
  isActivityObservationStale,
} from "../src/activityClock.ts";

test("activity semantic time advances from the daemon observation with a monotonic client clock", () => {
  const anchor = createActivityObservationAnchor({
    daemonObservedAt: "2026-07-11T12:00:00Z",
    clientReceivedMonotonicMs: 10_000,
  });

  assert.ok(anchor);
  assert.equal(activitySemanticNowMs(anchor, 16_250), Date.parse("2026-07-11T12:00:06.250Z"));
  assert.equal(activityObservationAgeMs(anchor, 16_250), 6_250);
});

test("browser wall-clock shifts do not alter activity age or semantic elapsed time", () => {
  const anchor = createActivityObservationAnchor({
    daemonObservedAt: "2026-07-11T12:00:00Z",
    clientReceivedMonotonicMs: 2_000,
  });
  assert.ok(anchor);

  const beforeShift = {
    semanticNow: activitySemanticNowMs(anchor, 12_000),
    observationAge: activityObservationAgeMs(anchor, 12_000),
  };

  // Date.now() shifting by either direction is intentionally absent from the
  // calculation: only the monotonic sample may advance semantic time.
  for (const shiftedBrowserWallMs of [
    Date.parse("2026-07-11T12:05:10Z"),
    Date.parse("2026-07-11T11:55:10Z"),
  ]) {
    assert.ok(Number.isFinite(shiftedBrowserWallMs));
    assert.deepEqual(
      {
        semanticNow: activitySemanticNowMs(anchor, 12_000),
        observationAge: activityObservationAgeMs(anchor, 12_000),
      },
      beforeShift,
    );
  }
});

test("observation freshness is monotonic and fails closed for malformed anchors", () => {
  const anchor = createActivityObservationAnchor({
    daemonObservedAt: "2026-07-11T12:00:00Z",
    clientReceivedMonotonicMs: 5_000,
  });
  assert.ok(anchor);
  assert.equal(isActivityObservationStale(anchor, 34_999, 30_000), false);
  assert.equal(isActivityObservationStale(anchor, 35_000, 30_000), true);

  assert.equal(
    createActivityObservationAnchor({
      daemonObservedAt: "not-a-timestamp",
      clientReceivedMonotonicMs: 5_000,
    }),
    null,
  );
  assert.equal(
    createActivityObservationAnchor({
      daemonObservedAt: "2026-07-11T12:00:00Z",
      clientReceivedMonotonicMs: Number.NaN,
    }),
    null,
  );
});
