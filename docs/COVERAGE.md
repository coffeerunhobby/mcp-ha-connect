# Test Coverage Report

**Generated:** 2026-10-30 (v2.5.3, `npm run test:coverage`)
**Tests:** 1722 passed (91 files; integration tests excluded)
**Overall:** 87.54% statements, 80.98% branches, 86.77% functions, 87.64% lines

Regenerate with `npm run test:coverage` (per-file detail in `coverage/`). Line coverage is not the quality bar here:
new code is mutation-checked (each guard changed or removed must fail a test) before release.

## Summary by Directory

| Directory | Statements | Branches | Functions | Lines |
|-----------|------------|----------|-----------|-------|
| scripts/ci | 72.4% | 57.9% | 70.0% | 72.5% |
| src | 95.7% | 95.8% | 90.2% | 96.6% |
| src/haClient | 80.7% | 75.6% | 75.3% | 80.6% |
| src/localAI | 100.0% | 100.0% | 100.0% | 100.0% |
| src/localAI/providers | 100.0% | 83.3% | 100.0% | 100.0% |
| src/net | 86.2% | 87.7% | 100.0% | 95.6% |
| src/net/adapters | 95.3% | 88.8% | 96.8% | 96.9% |
| src/omadaClient | 79.3% | 72.6% | 75.7% | 77.4% |
| src/ownerQuestions | 94.7% | 83.3% | 100.0% | 96.7% |
| src/permissions | 100.0% | 95.5% | 100.0% | 100.0% |
| src/resources | 100.0% | 90.0% | 100.0% | 100.0% |
| src/ruijieClient | 100.0% | 93.3% | 100.0% | 100.0% |
| src/server | 70.3% | 62.3% | 69.4% | 70.5% |
| src/tools | 98.9% | 92.5% | 100.0% | 98.9% |
| src/tools/ai | 100.0% | 100.0% | 100.0% | 100.0% |
| src/tools/homeassistant | 89.2% | 72.1% | 97.9% | 93.9% |
| src/tools/infra | 100.0% | 97.6% | 100.0% | 100.0% |
| src/tools/net | 93.9% | 77.3% | 92.6% | 94.3% |
| src/tools/omada | 93.2% | 73.4% | 86.8% | 93.1% |
| src/tools/utils | 100.0% | 100.0% | 100.0% | 100.0% |
| src/types | — | — | — | — |
| src/types/ai | — | — | — | — |
| src/types/homeassistant | 84.6% | — | 80.0% | 84.6% |
| src/types/omada | — | — | — | — |
| src/utils | 96.8% | 96.2% | 100.0% | 98.2% |

## Files under 60% line coverage (20+ lines)

- `src/omadaClient/index.ts` - 19.7%
- `src/omadaClient/device.ts` - 25.0%
- `src/omadaClient/client.ts` - 37.2%
- `src/haClient/devices.ts` - 41.7%
- `src/server/eventSubscription.ts` - 43.1%
- `src/omadaClient/network.ts` - 56.6%
- `src/server/http.ts` - 56.7%

## Integration Tests

`tests/integration/` (needs a live `.env`; `npm run test:integration`) is not counted above.
