import { dirname, resolve } from 'node:path'
import { isGitRepo } from '../git/repo-detection'
import type { Store } from '../persistence'
import { getLocalFolderScopeRoots } from './filesystem-allowed-roots'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * A git repo that sits directly inside a local folder-scope root (project group parent or folder
 * workspace). Folder workspaces already authorize filesystem access to the whole folder, so git
 * access to its immediate child repos widens nothing; deeper or non-git children stay denied.
 */
export function resolveFolderScopeGitRepoRoot(
  resolvedTarget: string,
  folderScopeRoots: readonly string[],
  isRepo: (path: string) => boolean = isGitRepo
): string | null {
  const parent = comparableLocalPath(dirname(resolvedTarget))
  if (parent === comparableLocalPath(resolvedTarget)) {
    return null
  }
  const isImmediateChildOfScope = folderScopeRoots.some(
    (root) => comparableLocalPath(root) === parent
  )
  if (!isImmediateChildOfScope || !isRepo(resolvedTarget)) {
    return null
  }
  return resolvedTarget
}

export function resolveFolderScopeGitRepoRootForStore(
  resolvedTarget: string,
  store: Store
): string | null {
  return resolveFolderScopeGitRepoRoot(
    resolvedTarget,
    getLocalFolderScopeRoots(store, store.getRepos())
  )
}
