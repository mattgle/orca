import type { GitStatusEntry, GitStatusResult } from '../../../../../shared/git-status-types'
import type { NestedRepoScanResult } from '../../../../../shared/project-group-types'
import { basename } from '@/lib/path'
import {
  getDiscardAllPaths,
  type DiscardAllArea
} from '../source-control/commit/discard-all-sequence'

export type FolderWorkspaceRepoCandidate = {
  path: string
  name: string
}

export type FolderWorkspaceChangedRepo = FolderWorkspaceRepoCandidate & {
  branch: string | null
  entries: GitStatusEntry[]
}

export type FolderWorkspaceRepoStatusOutcome =
  | { kind: 'loading' }
  | { kind: 'ready'; status: GitStatusResult }
  | { kind: 'error'; error: unknown }

export type FolderWorkspaceFailedRepo = FolderWorkspaceRepoCandidate & {
  error: unknown
}

/**
 * Meta-repo layouts keep sibling checkouts one level below the folder. A folder that is itself a
 * git repo is a single-repo workspace; deeper repos are left to Project Group import.
 */
export function selectImmediateChildRepos(
  scan: Pick<NestedRepoScanResult, 'selectedPathKind' | 'repos'>,
  folderPath: string
): FolderWorkspaceRepoCandidate[] {
  if (scan.selectedPathKind === 'git_repo') {
    return [{ path: folderPath, name: basename(folderPath) }]
  }
  return scan.repos
    .filter((repo) => repo.depth === 1)
    .map((repo) => ({ path: repo.path, name: repo.displayName }))
    .sort(compareRepoName)
}

export function selectChangedRepos(
  candidates: readonly FolderWorkspaceRepoCandidate[],
  outcomes: ReadonlyMap<string, FolderWorkspaceRepoStatusOutcome>
): {
  changed: FolderWorkspaceChangedRepo[]
  failed: FolderWorkspaceFailedRepo[]
} {
  const changed: FolderWorkspaceChangedRepo[] = []
  const failed: FolderWorkspaceFailedRepo[] = []
  for (const candidate of candidates) {
    const outcome = outcomes.get(candidate.path)
    if (!outcome || outcome.kind === 'loading') {
      continue
    }
    if (outcome.kind === 'error') {
      failed.push({ ...candidate, error: outcome.error })
      continue
    }
    if (outcome.status.entries.length === 0) {
      continue
    }
    changed.push({
      ...candidate,
      branch: outcome.status.branch ?? null,
      entries: outcome.status.entries
    })
  }
  return {
    changed: changed.sort(compareRepoName),
    failed: failed.sort(compareRepoName)
  }
}

export function countChangedFiles(repos: readonly FolderWorkspaceChangedRepo[]): number {
  return repos.reduce((total, repo) => total + repo.entries.length, 0)
}

export const REPO_DISCARD_AREA_ORDER: readonly DiscardAllArea[] = [
  'staged',
  'unstaged',
  'untracked'
]

/** Paths per area in the order a whole-repo discard must run them (staged first, see runDiscardAllForArea). */
export function getRepoDiscardPathsByArea(
  entries: readonly GitStatusEntry[]
): { area: DiscardAllArea; paths: string[] }[] {
  return REPO_DISCARD_AREA_ORDER.map((area) => ({
    area,
    paths: getDiscardAllPaths(entries, area)
  }))
}

export function buildRepoEntryKey(repoPath: string, entry: GitStatusEntry): string {
  return `${repoPath}::${entry.area}::${entry.path}`
}

function compareRepoName(
  left: FolderWorkspaceRepoCandidate,
  right: FolderWorkspaceRepoCandidate
): number {
  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
}
