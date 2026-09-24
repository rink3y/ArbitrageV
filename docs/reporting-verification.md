# Reporting verification

Tested on Windows x64 with Bun 1.4.3-canary.1, September 23, 2026. No live transactions, RPC lookups or Telegram messages were sent during this work.

## What the benchmark measures

Run `bun run bench:reporting`. Each child process explicitly clears Telegram credentials, starts the real reporting worker and sends stdout to the null sink. It runs 5,000 warm-up iterations, then measures 50,000 iterations, repeated three times per mode and workload.

Each iteration does the same small bigint calculation. Info emits one summary per 100 iterations; debug also emits one detailed record per iteration. Caller-side gating, record construction and sanitization are included. Worker formatting and output run concurrently. Queue draining occurs between batches in the steady workload, outside the measured call; the saturated workload only yields between batches. Neither workload models the whole bot or a slow production terminal.

Steady workload, ranges across three runs:

| Mode | p50 | p99 | p99.9 | Records dropped during measurement |
| --- | --- | --- | --- | --- |
| off | 0.2 µs | 0.5–0.6 µs | 4.0–4.3 µs | 0 |
| info | 0.3–0.4 µs | 19.9–24.5 µs | 54.9–61.6 µs | 0 |
| debug | 3.2–3.3 µs | 21.9–23.0 µs | 53.5–63.9 µs | 0 |

The saturated debug workload dropped 44,642–46,754 records during its 50,000 measured iterations. Its queue stayed at or below 256 waiting log records plus one batch of 16 in flight. Its lower p99, 5.7–7.2 µs, reflects discarded work, not faster complete logging. Warm-up drops are reported separately through cumulative channel statistics. All runs flushed successfully and produced the same calculation checksum.

Observed maximum call times reached milliseconds even with logging off. These runs do not establish hard latency bounds or prove that GC pauses are absent. Forced GC outside the measured loop took about 2.3–5.0 ms across these runs. Retained heap growth was roughly 0.5–0.6 MB, including benchmark sample arrays and runtime bookkeeping. This is a pressure check, not a measurement of automatic GC pause attribution or a production memory-leak proof.

## Checks

The reporting tests cover mode gating, independent critical alerts, bounded queues and worker messages, deduplication, transport failure, redaction, percentile sample thresholds, Telegram API errors/timeouts, real worker acknowledgments, and fatal/normal shutdown. Execution tests check that signing/submission never calls Telegram directly. A separate quote-equivalence test exercises all three modes with valid synthetic transfer profiles.

The TypeScript check passes. The full suite reports 213 passes and 29 pre-existing failures in older V2 and split fixtures. The committed baseline reproduced those same 29 failures, with 196 passes, in a temporary checkout with a dummy query address for mocked calls. Those fixtures omit transfer profiles while `V2_LIVE_POLICY.transferFees` is enabled. Production tax checks were not disabled or changed to hide those failures.

## Limits that matter

- Debug records and stack excerpts are bounded and may be truncated or dropped. Full debug is not a lossless audit trail.
- Telegram delivery is best effort. An HTTP timeout can leave delivery uncertain; retrying may duplicate a message.
- Reporting-worker failure disables reporting without interrupting trading. Its status is available through `reportingStatus()`; the failed worker cannot print its own failure or send an alert.
- Shutdown waits at most the configured deadline. Process termination, OOM, power loss and host failure need an external supervisor for reliable detection.
- Worker serialization, record copying and shared CPU/memory contention still cost time. Use info for routine operation and measure on the deployment machine before choosing debug for live trading.
