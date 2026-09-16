export interface DiffVersion {
  sha: string;
}

export function initialDiffRange(versions: readonly DiffVersion[], selectedSha: string) {
  const to = selectedSha || versions[0]?.sha || '';
  const currentIndex = versions.findIndex(version => version.sha === to);
  return {
    from: currentIndex === -1 ? '' : versions[currentIndex + 1]?.sha || '',
    to,
  };
}
