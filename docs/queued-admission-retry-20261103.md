# Queue admission when retrying an Inbox receipt

## Problem and change

An explicit retry of a retained failed BullMQ job cannot safely reserve capacity
and call `Job.retry()` as two separate operations. A reconciler could release the
reservation while Redis still reports the old failed attempt. A suspended
producer could also resume after another retry had already finished.

This change keeps the existing global and team capacity sorted sets. Each
reservation additionally owns an opaque generation in a Redis hash. Terminal
observers capture that generation **before** checking state. Worker capture also
checks its current BullMQ lock token. Release is a compare-and-set: an old
generation cannot remove a new reservation.
Worker release also verifies its current lock token atomically. An automatic
stalled takeover may keep the generation but changes the lock; its previous
worker cannot release the takeover's slot.

`retryInboxJobWithAdmission()` atomically checks the exact retained job name,
payload and failed-attempt snapshot, reserves capacity, assigns a new generation,
marks the retry pending, executes the installed native retry, and marks it
dispatched. Concurrent requests for the same failed snapshot make one transition.
A delayed request cannot retry a newer failed attempt.

The native operation is imported from BullMQ **5.81.5**, `reprocessJob-8`, with
content SHA-256
`33f68fa67b8418597ed1b941a48b3079ccf8fbda229cfb6ec9f2509501f069be`.
Different versions, keys or script bytes refuse execution. This wrapper covers
only Inbox `process-attachment` jobs without parent flows. It does not claim a
general flow retry or Redis Cluster protocol.

## Failure behavior

Redis Lua errors do **not** undo previous writes. Type, argument, native metadata,
identity and state checks therefore precede mutation. Capacity and the pending
marker are written before any potentially runnable native queue write. An
unexpected native error retains that slot. Pending, malformed or mismatched
markers cannot be released automatically. Operator inventory reports their state;
there is no timeout-based deletion of uncertain reservations.

A lost successful retry response leaves the native job and dispatched generation
in Redis. The caller checks the retained job's exact identity and state. A current
worker may release its captured generation at completion; an old worker,
terminal producer or reconciler cannot release the replacement generation.

Existing reserved members without generation metadata are read as `legacy`.
Missing members do not acquire a fabricated generation. The four historical
direct `Queue.add` producers are handled in a separate packet; this change does
not silently claim they were already admitted.

## Rollout contract

All API producers, workers and queue reconcilers using admission must run the new
capture/CAS release code before enabling explicit Inbox retry. Old deployed code
can still issue an unconditional V1 release and is not protected by a V2 token.
No live Redis keys, daemon, units or workers are changed by this source packet.
Do not clear existing sorted sets or metadata to migrate them.

## Review and verification

The offline test checks malformed/pending generation handling and required
failed-attempt snapshot fields. The isolated Redis suites cover concurrent
capacity admission, non-resurrecting reconciliation, native retry, simultaneous
retries, stale release, stale worker lock, suspended producer, lost response,
capacity refusal and malformed/native drift. All keys and the native queue belong
to a fresh random fixture namespace; no global Redis flush is used.

Run only through the host's shared queue against an approved temporary local Redis
instance with a non-default database. `TEST_REDIS_URL` must never refer to a shared
or production instance. The acceptance receipt must contain **12 pass, 0 fail,
0 skip** for `resource-admission.test.ts` and `retry-inbox-job.test.ts`, plus cleanup
and child-join evidence from the isolated Redis runner. Include the stalled
takeover case with the same generation and different worker lock. A source review or skipped
test run does not establish runtime acceptance.
