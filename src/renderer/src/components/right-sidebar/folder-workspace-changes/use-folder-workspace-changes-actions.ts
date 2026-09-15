import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import {
  bulkDiscardRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  discardRuntimeGitPath,
  stageRuntimeGitPath,
  unstageRuntimeGitPath,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../shared/git-status-types'
import { runDiscardAllForArea } from '../source-control/commit/discard-all-sequence'
import { discardDeletesEntryFile } from '../source-control/commit/discard-confirmation'
import {
  dismissSourceControlEntryFailureToast,
  showSourceControlEntryFailureToast,
  type SourceControlEntryOperation
} from '../source-control/commit/source-control-entry-failure-toast'
import {
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from '../source-control/listing/split-open'
import { getRepoDiscardPathsByArea, type FolderWorkspaceChangedRepo } from './changed-repo-model'

export type PendingFolderWorkspaceDiscard =
  | { kind: 'entry'; repo: FolderWorkspaceChangedRepo; entry: GitStatusEntry }
  | { kind: 'repo'; repo: FolderWorkspaceChangedRepo }

export type FolderWorkspaceChangesActions = {
  openEntry: (
    repo: FolderWorkspaceChangedRepo,
    entry: GitStatusEntry,
    event?: SourceControlRowOpenEvent
  ) => void
  openEntryFile: (repo: FolderWorkspaceChangedRepo, entry: GitStatusEntry) => void
  stageEntry: (repo: FolderWorkspaceChangedRepo, filePath: string) => Promise<void>
  unstageEntry: (repo: FolderWorkspaceChangedRepo, filePath: string) => Promise<void>
  requestDiscardEntry: (repo: FolderWorkspaceChangedRepo, entry: GitStatusEntry) => void
  requestDiscardRepo: (repo: FolderWorkspaceChangedRepo) => void
  pendingDiscard: PendingFolderWorkspaceDiscard | null
  cancelPendingDiscard: () => void
  confirmPendingDiscard: () => Promise<void>
  isExecutingDiscard: boolean
}

type UseFolderWorkspaceChangesActionsArgs = {
  worktreeId: string | null
  connectionId: string | null | undefined
  onMutated: () => void
}

export function useFolderWorkspaceChangesActions({
  worktreeId,
  connectionId,
  onMutated
}: UseFolderWorkspaceChangesActionsArgs): FolderWorkspaceChangesActions {
  const settings = useAppStore((s) => s.settings)
  const openDiff = useAppStore((s) => s.openDiff)
  const openFile = useAppStore((s) => s.openFile)
  const [pendingDiscard, setPendingDiscard] = useState<PendingFolderWorkspaceDiscard | null>(null)
  const [isExecutingDiscard, setIsExecutingDiscard] = useState(false)

  // Why: reset during render so a workspace switch never paints the previous confirmation.
  const [pendingDiscardWorktreeId, setPendingDiscardWorktreeId] = useState(worktreeId)
  if (pendingDiscardWorktreeId !== worktreeId) {
    setPendingDiscardWorktreeId(worktreeId)
    setPendingDiscard(null)
  }

  const gitContextFor = useCallback(
    (repo: FolderWorkspaceChangedRepo): RuntimeGitContext => ({
      settings,
      // Why: a sibling repo has no worktree id of its own; the path-addressed IPC handles local and SSH.
      worktreeId: null,
      worktreePath: repo.path,
      connectionId: connectionId ?? undefined
    }),
    [connectionId, settings]
  )

  const openEntry = useCallback<FolderWorkspaceChangesActions['openEntry']>(
    (repo, entry, event) => {
      if (!worktreeId) {
        return
      }
      const language = detectLanguage(entry.path)
      const filePath = joinPath(repo.path, entry.path)
      const preview = shouldOpenSourceControlRowAsPreview(event, undefined)
      if (entry.conflictStatus === 'unresolved') {
        openFile(
          {
            filePath,
            relativePath: entry.path,
            worktreeId,
            language,
            mode: 'edit'
          },
          { preview }
        )
        return
      }
      // Why: the diff loader derives the repo root from filePath minus relativePath, so the folder
      // workspace key can own tabs for any of its sibling repos.
      openDiff(worktreeId, filePath, entry.path, language, entry.area === 'staged', { preview })
    },
    [openDiff, openFile, worktreeId]
  )

  const openEntryFile = useCallback<FolderWorkspaceChangesActions['openEntryFile']>(
    (repo, entry) => {
      if (!worktreeId) {
        return
      }
      openFile(
        {
          filePath: joinPath(repo.path, entry.path),
          relativePath: entry.path,
          worktreeId,
          language: detectLanguage(entry.path),
          mode: 'edit'
        },
        { preview: false }
      )
    },
    [openFile, worktreeId]
  )

  const runEntryMutation = useCallback(
    async (
      operation: SourceControlEntryOperation,
      repo: FolderWorkspaceChangedRepo,
      filePath: string,
      deletesFile: boolean,
      mutate: () => Promise<void>
    ): Promise<void> => {
      try {
        await mutate()
      } catch (error) {
        console.error(`[FolderWorkspaceChanges] ${operation} failed`, error)
        showSourceControlEntryFailureToast({
          operation,
          filePath,
          deletesFile,
          error,
          worktreeId,
          worktreeName: repo.name
        })
        return
      }
      dismissSourceControlEntryFailureToast(worktreeId)
      onMutated()
    },
    [onMutated, worktreeId]
  )

  const stageEntry = useCallback<FolderWorkspaceChangesActions['stageEntry']>(
    (repo, filePath) =>
      runEntryMutation('stage', repo, filePath, false, () =>
        stageRuntimeGitPath(gitContextFor(repo), filePath)
      ),
    [gitContextFor, runEntryMutation]
  )

  const unstageEntry = useCallback<FolderWorkspaceChangesActions['unstageEntry']>(
    (repo, filePath) =>
      runEntryMutation('unstage', repo, filePath, false, () =>
        unstageRuntimeGitPath(gitContextFor(repo), filePath)
      ),
    [gitContextFor, runEntryMutation]
  )

  const discardRepo = useCallback(
    async (repo: FolderWorkspaceChangedRepo): Promise<void> => {
      const context = gitContextFor(repo)
      let failureCount = 0
      for (const { area, paths } of getRepoDiscardPathsByArea(repo.entries)) {
        const result = await runDiscardAllForArea(area, paths, {
          bulkUnstage: (targets) => bulkUnstageRuntimeGitPaths(context, targets),
          discardMany: (targets) => bulkDiscardRuntimeGitPaths(context, targets),
          discardOne: (target) => discardRuntimeGitPath(context, target),
          onError: (error) => {
            failureCount += 1
            console.error('[FolderWorkspaceChanges] discard all failed', error)
          }
        })
        if (result.aborted) {
          break
        }
      }
      if (failureCount > 0) {
        toast.error(
          translate(
            'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoFailed',
            'Failed to discard some changes in {{value0}}',
            { value0: repo.name }
          )
        )
      }
      onMutated()
    },
    [gitContextFor, onMutated]
  )

  const confirmPendingDiscard = useCallback(async (): Promise<void> => {
    const pending = pendingDiscard
    if (!pending || isExecutingDiscard) {
      return
    }
    setPendingDiscard(null)
    setIsExecutingDiscard(true)
    try {
      await (pending.kind === 'entry'
        ? runEntryMutation(
            'discard',
            pending.repo,
            pending.entry.path,
            discardDeletesEntryFile(pending.entry),
            () => discardRuntimeGitPath(gitContextFor(pending.repo), pending.entry.path)
          )
        : discardRepo(pending.repo))
    } finally {
      setIsExecutingDiscard(false)
    }
  }, [discardRepo, gitContextFor, isExecutingDiscard, pendingDiscard, runEntryMutation])

  return {
    openEntry,
    openEntryFile,
    stageEntry,
    unstageEntry,
    requestDiscardEntry: useCallback(
      (repo, entry) => setPendingDiscard({ kind: 'entry', repo, entry }),
      []
    ),
    requestDiscardRepo: useCallback((repo) => setPendingDiscard({ kind: 'repo', repo }), []),
    pendingDiscard,
    cancelPendingDiscard: useCallback(() => setPendingDiscard(null), []),
    confirmPendingDiscard,
    isExecutingDiscard
  }
}
