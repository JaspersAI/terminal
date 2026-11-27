export interface ArtifactHash {
  name: string
  sha512: string
  size: number
}

export interface RollbackArgs {
  targetVersion: string
  upTo: string | null
  dryRun: boolean
  force: boolean
}

export function parseFeedVersion(yamlText: string): string | null
export function stripRollbackFields(yamlText: string): string
export function compareVersions(a: string, b: string): number
export function withRollbackMarkers(yamlText: string, rollbackUpTo: string | null): string
export function buildWindowsFeedYaml(version: string, exe: ArtifactHash, releaseDate: string): string
export function buildMacFeedYaml(version: string, zip: ArtifactHash, dmg: ArtifactHash, releaseDate: string): string
export function parseRollbackArgs(argv: readonly string[]): RollbackArgs
