import { execa } from 'execa';

export function git(vaultDir: string, args: string[]) {
  return execa('git', args, { cwd: vaultDir });
}
