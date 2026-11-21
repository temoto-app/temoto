/**
 * Makes the temp folder for one `npm test` run, and removes all of it when done (TODO 262).
 *
 * globalSetup runs in vitest's parent process, before the workers start. Env vars set here are inherited by the workers (forks), and `testRunDir()` in `test/helpers/tmp.ts` uses them. Leftovers from a run that was killed are removed by `startRun` of the next run, which checks the pid.
 */
import { finishRun, RUN_DIR_ENV, startRun } from '../helpers/tmp.js'

export default function setup(): () => void {
  const dir = startRun()
  process.env[RUN_DIR_ENV] = dir
  return () => {
    finishRun(dir)
  }
}
