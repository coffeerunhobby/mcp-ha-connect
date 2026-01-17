# Test Coverage Report

**Generated:** 2026-01-17
**Tests:** 692 passed
**Overall:** 61.14% statements, 54.14% branches, 56.47% functions, 62.52% lines

## Summary by Directory

| Directory | Statements | Branches | Functions | Lines |
|-----------|------------|----------|-----------|-------|
| src | 85.00% | 93.61% | 78.57% | 86.11% |
| src/haClient | 76.38% | 76.29% | 68.29% | 76.17% |
| src/localAI | 100.00% | 100.00% | 100.00% | 100.00% |
| src/localAI/providers | 100.00% | 83.33% | 100.00% | 100.00% |
| src/permissions | 100.00% | 86.36% | 100.00% | 100.00% |
| src/resources | 0.00% | 0.00% | 0.00% | 0.00% |
| src/server | 93.22% | 82.75% | 100.00% | 93.10% |
| src/tools | 95.16% | 76.19% | 100.00% | 95.16% |
| src/tools/ai | 53.84% | 0.00% | 66.66% | 53.84% |
| src/tools/homeassistant | 27.93% | 0.00% | 43.37% | 31.39% |
| src/tools/omada | 9.47% | 0.00% | 0.00% | 9.47% |
| src/tools/utils | 100.00% | 100.00% | 100.00% | 100.00% |
| src/types | 0.00% | 0.00% | 0.00% | 0.00% |
| src/types/homeassistant | 83.33% | 100.00% | 75.00% | 83.33% |
| src/utils | 98.64% | 100.00% | 100.00% | 98.52% |

## Detailed Coverage

### src/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| config.ts | 84.61% | 93.61% | 78.57% | 85.71% | 106-107,116,323 |
| version.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

### src/haClient/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| automations.ts | 69.64% | 63.15% | 85.71% | 69.64% | 197,206,220-227 |
| calendars.ts | 90.47% | 83.33% | 100.00% | 90.00% | 86-87 |
| config.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| devices.ts | 41.66% | 21.42% | 41.46% | 41.66% | 337-439,478-643 |
| entities.ts | 100.00% | 95.23% | 100.00% | 100.00% | 116 |
| history.ts | 100.00% | 90.00% | 100.00% | 100.00% | 34 |
| index.ts | 68.29% | 100.00% | 56.66% | 68.29% | 167-230,294-315 |
| request.ts | 100.00% | 95.65% | 100.00% | 100.00% | 107 |
| services.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| states.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| updates.ts | 100.00% | 78.57% | 100.00% | 100.00% | 36,42 |

### src/localAI/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| prompts.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

### src/localAI/providers/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| base.ts | 100.00% | 87.50% | 100.00% | 100.00% | 90 |
| ollama.ts | 100.00% | 75.00% | 100.00% | 100.00% | 61 |
| openai.ts | 100.00% | 83.33% | 100.00% | 100.00% | 69 |

### src/permissions/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 100.00% | 86.36% | 100.00% | 100.00% | 46,51,61 |

### src/resources/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 0.00% | 0.00% | 0.00% | 0.00% | 16-213 |

### src/server/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| auth.ts | 91.11% | 81.48% | 100.00% | 90.90% | 126-129 |
| common.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| stdio.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

### src/tools/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| common.ts | 98.00% | 76.47% | 100.00% | 98.00% | 39 |
| index.ts | 83.33% | 75.00% | 100.00% | 83.33% | 40-41 |

### src/tools/ai/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| analyzeSensors.ts | 14.28% | 0.00% | 50.00% | 14.28% | 20-30 |
| index.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

### src/tools/homeassistant/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| automationControls.ts | 33.33% | 100.00% | 50.00% | 33.33% | 35,48-49,62-63 |
| calendar.ts | 10.00% | 0.00% | 25.00% | 10.52% | 20-21,45-85 |
| callService.ts | 20.00% | 0.00% | 50.00% | 20.00% | 18-22 |
| controlClimate.ts | 6.66% | 0.00% | 50.00% | 6.66% | 20-62 |
| controlCover.ts | 11.11% | 0.00% | 50.00% | 11.11% | 20-42 |
| controlFan.ts | 6.66% | 0.00% | 50.00% | 8.33% | 20-38 |
| controlLight.ts | 8.33% | 0.00% | 50.00% | 12.50% | 20-32 |
| controlMediaPlayer.ts | 11.11% | 0.00% | 50.00% | 11.11% | 20-44 |
| createAutomation.ts | 20.00% | 0.00% | 50.00% | 20.00% | 21-32 |
| deleteAutomation.ts | 33.33% | 100.00% | 50.00% | 33.33% | 20-21 |
| entityAction.ts | 16.66% | 0.00% | 50.00% | 16.66% | 20-29 |
| getAllSensors.ts | 33.33% | 100.00% | 50.00% | 33.33% | 17-18 |
| getAutomationTrace.ts | 33.33% | 0.00% | 50.00% | 33.33% | 20-21 |
| getDomainSummary.ts | 33.33% | 100.00% | 50.00% | 33.33% | 17-18 |
| getEntitiesByDomain.ts | 33.33% | 100.00% | 50.00% | 33.33% | 17-18 |
| getHistory.ts | 33.33% | 0.00% | 50.00% | 33.33% | 20-21 |
| getState.ts | 20.00% | 0.00% | 50.00% | 20.00% | 17-21 |
| getStates.ts | 33.33% | 100.00% | 50.00% | 33.33% | 17-18 |
| getVersion.ts | 33.33% | 100.00% | 50.00% | 33.33% | 17-18 |
| index.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| listAutomations.ts | 16.66% | 0.00% | 33.33% | 20.00% | 20-24 |
| listEntities.ts | 33.33% | 100.00% | 50.00% | 33.33% | 20-21 |
| listPersons.ts | 11.11% | 0.00% | 20.00% | 16.66% | 26-38 |
| sceneAndScript.ts | 33.33% | 100.00% | 50.00% | 33.33% | 21-26,39-45 |
| searchEntities.ts | 33.33% | 100.00% | 50.00% | 33.33% | 19-20 |
| sendNotification.ts | 2.94% | 0.00% | 25.00% | 4.16% | 89-106,128-172 |
| systemTools.ts | 33.33% | 0.00% | 50.00% | 33.33% | 20-21,34-35,48-49 |
| triggerAutomation.ts | 33.33% | 100.00% | 50.00% | 33.33% | 20-21 |

### src/tools/omada/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| disableClientRateLimit.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-18 |
| getClient.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getDevice.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getFirewallSetting.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getInternetInfo.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getLanNetworkList.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getLanProfileList.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getPortForwardingStatus.ts | 33.33% | 0.00% | 0.00% | 33.33% | 15-21 |
| getRateLimitProfiles.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getSsidDetail.ts | 33.33% | 100.00% | 0.00% | 33.33% | 14-20 |
| getSsidList.ts | 33.33% | 100.00% | 0.00% | 33.33% | 13-19 |
| getSwitchStackDetail.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| getThreatList.ts | 25.00% | 100.00% | 0.00% | 25.00% | 20-39 |
| getWlanGroupList.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| index.ts | 0.00% | 100.00% | 0.00% | 0.00% | 35-81 |
| listClients.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| listClientsActivity.ts | 33.33% | 100.00% | 0.00% | 33.33% | 14-20 |
| listClientsPastConnections.ts | 33.33% | 100.00% | 0.00% | 33.33% | 22-28 |
| listDevices.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| listDevicesStats.ts | 33.33% | 100.00% | 0.00% | 33.33% | 19-25 |
| listMostActiveClients.ts | 0.00% | 100.00% | 0.00% | 0.00% | 7-13 |
| listSites.ts | 33.33% | 100.00% | 0.00% | 33.33% | 10-16 |
| searchDevices.ts | 33.33% | 100.00% | 0.00% | 33.33% | 12-18 |
| setClientRateLimit.ts | 0.00% | 100.00% | 0.00% | 0.00% | 8-21 |
| setClientRateLimitProfile.ts | 0.00% | 100.00% | 0.00% | 0.00% | 8-20 |

### src/tools/utils/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| pagination-schema.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

### src/types/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 0.00% | 0.00% | 0.00% | 0.00% | |

### src/types/ai/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 0.00% | 0.00% | 0.00% | 0.00% | |

### src/types/homeassistant/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| errors.ts | 83.33% | 100.00% | 75.00% | 83.33% | 30-31 |
| index.ts | 0.00% | 0.00% | 0.00% | 0.00% | |

### src/types/omada/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| index.ts | 0.00% | 0.00% | 0.00% | 0.00% | |

### src/utils/

| File | Statements | Branches | Functions | Lines | Uncovered |
|------|------------|----------|-----------|-------|-----------|
| validations.ts | 100.00% | 100.00% | 100.00% | 100.00% | |
| jwt.ts | 95.45% | 100.00% | 100.00% | 95.45% | 52 |
| logger.ts | 100.00% | 100.00% | 100.00% | 100.00% | |

## Coverage Gaps

### High Priority (0% coverage)
- `src/resources/index.ts` - MCP resources
- `src/tools/omada/` - Most Omada tools (unit tests needed)
- `src/types/` - Type re-exports (low priority)

### Medium Priority (<50% coverage)
- `src/haClient/devices.ts` - 41.66%
- `src/tools/homeassistant/` - Most tools 6-33%
- `src/tools/ai/analyzeSensors.ts` - 14.28%

### Integration Tests
- HomeAssistant: 21 tests
- Omada: 19 tests
- AI: 4 tests
- **Total integration: 44 tests**
