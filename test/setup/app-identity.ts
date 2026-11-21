/**
 * TODO 1263: main fixes the data name once per launch (`initAppIdentity`) before any path is computed, and `appIdentity()` throws until then.
 * The tests run under the legacy name (`aios`), the name the existing tests were written against (`~/aios/scratch`, `~/.local/share/aios`).
 * Tests of the new name pass the name explicitly (`test/app-identity.test.ts`).
 */
import { LEGACY_IDENTITY, initAppIdentity } from '../../src/common/app-identity.js'

initAppIdentity(LEGACY_IDENTITY)
