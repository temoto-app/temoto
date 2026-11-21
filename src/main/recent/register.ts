/**
 * The IPC for "recent files" (TODO 999). Kept apart instead of being mixed into `handlers.ts` (so a parallel bundle does not touch the same place -
 * the same practice as `paste/register.ts`). Every value from the renderer is re-checked here or in `RecentFilesService` / `ThumbnailCache`.
 */
import { ipcMain, nativeImage } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { asRecentListOptions, type RecentFile } from '@shared/recent-files.js'
import type { AppSettingsStore } from '../../common/settings.js'
import type { FsAccess } from '../fs/access.js'
import type { IndexClient } from '../index/client.js'
import { GitChangeIndex } from './git-changes.js'
import { ScreenshotOfferPreference } from './preference.js'
import { RecentFilesService } from './recent-files.js'
import { THUMBNAIL_SIZE, ThumbnailCache, pngDimensions, shrinkToFit } from './thumbnail.js'

export interface RecentFilesRegistration {
  readonly service: RecentFilesService
  readonly preference: ScreenshotOfferPreference
  dispose(): void
}

export function registerRecentFilesHandlers(deps: {
  readonly settings: AppSettingsStore
  readonly fs: FsAccess
  readonly index: IndexClient
  /** `SessionManager.recentAiWrittenPaths`. Empty in a launch without the conversation machinery (a verification fake). */
  readonly aiWrittenPaths: (sinceMs: number) => readonly string[]
  /** Called after "Suggest new screenshots" changed (TODO 1060 stage 3: the open settings screen follows). */
  readonly onScreenshotOfferChanged?: () => void
}): RecentFilesRegistration {
  const preference = new ScreenshotOfferPreference(deps.settings)
  const git = new GitChangeIndex()
  const service = new RecentFilesService({
    candidates: (params) => deps.index.recentFiles(params),
    aiWrittenPaths: deps.aiWrittenPaths,
    gitState: (path) => git.stateOf(path),
    screenshotOfferEnabled: () => preference.get()
  })
  const thumbnails = new ThumbnailCache(deps.fs, async (path) => {
    const image = await nativeImage.createThumbnailFromPath(path, { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE })
    if (image.isEmpty()) return null
    // TODO 1179: `toDataURL()` stretches to the square asked for. Build from the real pixels (`toPNG()`, keeping the aspect ratio) and shrink only when the long side exceeds 384.
    const png = image.toPNG()
    const dims = pngDimensions(png)
    // If the PNG header cannot be read (empty, or not a PNG), do not make a data URL that would become a broken <img>; return null (= do not show a badge).
    if (dims === null) return null
    const target = shrinkToFit(dims.width, dims.height, THUMBNAIL_SIZE)
    const out = target === null ? png : nativeImage.createFromBuffer(png).resize({ ...target, quality: 'best' }).toPNG()
    return `data:image/png;base64,${out.toString('base64')}`
  })

  ipcMain.handle(IpcChannel.recentList, (_event, options: unknown): Promise<readonly RecentFile[]> => {
    const { kinds, limit } = asRecentListOptions(options)
    return service.list(kinds, limit)
  })
  ipcMain.handle(IpcChannel.recentThumbnail, (_event, uri: unknown) => thumbnails.thumbnailFor(uri))
  ipcMain.handle(IpcChannel.recentOffers, () => service.offers())
  ipcMain.handle(IpcChannel.recentScreenshotOfferEnabledGet, () => preference.get())
  ipcMain.handle(IpcChannel.recentScreenshotOfferEnabledSet, (_event, enabled: unknown) => {
    const saved = preference.set(enabled === true)
    deps.onScreenshotOfferChanged?.()
    return saved
  })
  return {
    service,
    preference,
    dispose: () => git.dispose()
  }
}
