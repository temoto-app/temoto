/**
 * "Report a problem" in main (TODO 1308, ARCHITECTURE.md 12.9.2). Reads the recent log files, builds the masked text file
 * (`common/problem-report.ts`), writes it where the user can find it and shows it in Finder. **Nothing is sent over the network.**
 *
 * Where it is written: the Downloads folder for the real profile; `<userData>/reports/` for a `--user-data-dir` profile (verification build,
 * smoke), so such a run never writes into the owner's real folders. Which one is decided by the caller (`reportDirectory`).
 */
import { mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { errorFields, log } from '../common/logger.js'
import { isLogFileName } from '../common/log-file.js'
import { buildProblemReport, problemReportFileName, type ReportLogFile } from '../common/problem-report.js'
import { PRODUCT_NAME } from '../shared/product.js'
import { currentBuildInfo, currentRuntimeInfo } from './build-info.js'
import { currentLogDirectory } from './log-file.js'

/** Per file, only the end is read (a log file can be up to 64 MiB). */
const TAIL_BYTES = 2 * 1024 * 1024

async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    // A cut in the middle of a line is dropped.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/** The kept log files, oldest first (names sort by launch time). */
export async function readLogFiles(dir: string): Promise<ReportLogFile[]> {
  const names = (await readdir(dir)).filter(isLogFileName).sort()
  const files: ReportLogFile[] = []
  for (const name of names) {
    try {
      files.push({ name, text: await readTail(join(dir, name)) })
    } catch {
      // A file that vanished or cannot be read is skipped.
    }
  }
  return files
}

/** Where the report goes. The real profile: Downloads. Any other userData: its own `reports/` folder. */
export function reportDirectory(): string {
  const userData = app.getPath('userData')
  // Same test as `isDefaultUserData` in `index.ts`.
  const isDefault = userData === join(app.getPath('appData'), app.getName())
  return isDefault ? app.getPath('downloads') : join(userData, 'reports')
}

/** Builds, writes and reveals the report. Returns true on success. Never throws. */
export async function reportProblem(): Promise<boolean> {
  try {
    const logDir = currentLogDirectory()
    const logs = logDir === null ? [] : await readLogFiles(logDir)
    const now = new Date()
    const text = await buildProblemReport({
      productName: PRODUCT_NAME,
      build: currentBuildInfo(app.getVersion()),
      runtime: currentRuntimeInfo(),
      logs,
      homeDir: homedir(),
      userName: userInfo().username,
      now
    })
    const dir = reportDirectory()
    await mkdir(dir, { recursive: true })
    const path = join(dir, problemReportFileName(now))
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
    log.info('problem.report.created', { logs: logs.length, bytes: Buffer.byteLength(text) })
    shell.showItemInFolder(path)
    return true
  } catch (err) {
    log.warn('problem.report.failed', errorFields(err))
    return false
  }
}
