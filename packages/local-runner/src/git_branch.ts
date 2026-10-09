import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {gitBranchEvidenceSchema, gitBranchParametersSchema} from '@raven-zero/contracts';
import type {CommandResult, JsonValue, Publication} from '@raven-zero/contracts';
import {DeliveryFailure} from './dependencies.js';
import type {DeliveryComponent, DeliveryContext, FileExecution, RunWorkspace} from './dependencies.js';

const GIT = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git';

/** Client-private Git refs retain commit identity across interrupted delivery.
 * Uses the caller-owned managed command entry; never follows a workspace .git.
 * File/process isolation is supplied by that entry, not by this component.
 */
export class GitBranchDelivery implements DeliveryComponent {
  readonly name = 'git-branch';
  constructor(private readonly files: FileExecution) {}

  async initialize(workspace: RunWorkspace, parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal): Promise<void> {
    const {remote, baseRef} = gitBranchParametersSchema.parse(parameters);
    const metadata = join(workspace.root, 'git');
    await this.git(workspace.root, ['init', '--bare', '--template=', metadata], signal);
    await this.git(workspace.root, ['--git-dir', metadata, 'fetch', '--no-tags', '--no-recurse-submodules',
      '--', remote, baseRef], signal, true);
    const base = await this.git(workspace.root, ['--git-dir', metadata, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], signal);
    await this.git(workspace.root, ['--git-dir', metadata, 'update-ref', 'refs/raven/base', base], signal);
    await this.git(workspace.root, ['--git-dir', metadata, '--work-tree', workspace.workspace, 'read-tree', base], signal);
    await this.git(workspace.root, ['--git-dir', metadata, '--work-tree', workspace.workspace,
      'checkout-index', '--all', `--prefix=${workspace.workspace}/`], signal);
  }

  async deliver(publication: Publication, parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal, context: DeliveryContext): Promise<unknown> {
    const {remote} = gitBranchParametersSchema.parse(parameters);
    const root = context.root;
    const metadata = join(root, 'git');
    const prefix = ['--git-dir', metadata, '--work-tree', publication.directory];
    const branch = `raven/${publication.runId}`;
    const ref = `refs/raven/versions/${publication.version}`;
    let parent = await this.git(root, [...prefix, 'rev-parse', '--verify', 'refs/raven/base'], signal);
    for (let version = publication.version - 1; version > 0; version--) {
      const previous = await this.optionalRef(root, prefix, `refs/raven/versions/${version}`, signal);
      if (previous) { parent = previous; break; }
    }
    await this.git(root, [...prefix, 'read-tree', '--empty'], signal);
    for (const entry of publication.entries) {
      if (entry.kind !== 'file') continue;
      const blob = await this.git(root, [...prefix, 'hash-object', '-w', '--no-filters', '--', join(publication.directory, entry.path)], signal);
      await this.git(root, [...prefix, 'update-index', '--add', '--cacheinfo', entry.executable ? '100755' : '100644', blob, entry.path], signal);
    }
    const tree = await this.git(root, [...prefix, 'write-tree'], signal);
    const parentTree = await this.git(root, [...prefix, 'rev-parse', `${parent}^{tree}`], signal);
    const noChanges = tree === parentTree;
    let commit = await this.optionalRef(root, prefix, ref, signal);
    if (context.evidence !== undefined) {
      const recorded = gitBranchEvidenceSchema.parse(context.evidence);
      if (recorded.commit !== commit || recorded.remote !== remote || recorded.branch !== branch ||
        recorded.version !== publication.version || recorded.noChanges !== noChanges) {
        throw new Error('Recorded commit identity could not be verified');
      }
    }
    if (commit && commit !== parent) {
      const savedTree = await this.git(root, [...prefix, 'rev-parse', `${commit}^{tree}`], signal);
      if (savedTree !== tree) throw new Error('Recorded commit does not match the published version');
    } else if (!noChanges) {
      // Read only the client's configured author; local Git work uses isolated config.
      const identity = await this.git(root, ['var', 'GIT_AUTHOR_IDENT'], signal, true);
      const author = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(identity);
      if (!author?.[1] || !author[2]) throw new Error('Client Git author identity is unavailable');
      await this.git(root, [...prefix, 'symbolic-ref', 'HEAD', ref], signal);
      await this.git(root, [...prefix, 'update-ref', ref, parent], signal);
      await this.git(root, ['-c', `user.name=${author[1]}`, '-c', `user.email=${author[2]}`,
        ...prefix, 'commit', '--no-verify', '-m', `Raven ${publication.runId} v${publication.version}`], signal);
      commit = await this.git(root, [...prefix, 'rev-parse', '--verify', ref], signal);
    } else {
      commit = parent;
      await this.git(root, [...prefix, 'update-ref', ref, commit], signal);
    }
    const evidence = {remote, branch, commit, version: publication.version, noChanges, status: 'committed'};
    await context.checkpoint(evidence);
    const remoteCommit = await this.remoteCommit(root, prefix, remote, branch, signal);
    if (remoteCommit && remoteCommit !== commit) {
      const ancestor = await this.invoke(root, [...prefix, 'merge-base', '--is-ancestor', remoteCommit, commit], signal);
      if (ancestor.status !== 'exited') throw new Error(`Remote ancestry requires verification: ${ancestor.status}`);
      if (ancestor.exitCode !== 0) {
        throw new DeliveryFailure('Remote branch conflicts with the recorded delivery', {...evidence, status: 'conflict'});
      }
    }
    if (remoteCommit !== commit) {
      const pushed = await this.invoke(root, [...prefix, 'push', '--no-verify', '--', remote, `${commit}:refs/heads/${branch}`], signal, true);
      if (pushed.status !== 'exited') throw new Error(`Git push requires verification: ${pushed.status}`);
      // Even a failed/ambiguous push is checked against the remote before deciding.
      if (await this.remoteCommit(root, prefix, remote, branch, signal) !== commit) {
        throw new DeliveryFailure(`Git push failed: ${pushed.stderr}`, {...evidence, status: 'failed'});
      }
    }
    return {...evidence, status: 'pushed'};
  }

  private async optionalRef(root: string, prefix: string[], ref: string, signal: AbortSignal): Promise<string | undefined> {
    const result = await this.invoke(root, [...prefix, 'rev-parse', '--verify', '--quiet', ref], signal);
    if (result.status !== 'exited') throw new Error(`Git reference requires verification: ${result.status}`);
    if (result.exitCode === 1) return undefined;
    if (result.exitCode !== 0) throw new Error(`Git reference failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  private async remoteCommit(root: string, prefix: string[], remote: string, branch: string, signal: AbortSignal): Promise<string | undefined> {
    const output = await this.git(root, [...prefix, 'ls-remote', '--refs', '--', remote, `refs/heads/${branch}`], signal, true);
    if (!output) return undefined;
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/[^\r\n]+$/.exec(output);
    if (!match?.[1]) throw new Error('Remote branch evidence could not be verified');
    return match[1];
  }

  private async git(root: string, args: string[], signal: AbortSignal, clientConfig = false): Promise<string> {
    const result = await this.invoke(root, args, signal, clientConfig);
    if (result.status !== 'exited' || result.exitCode !== 0) {
      throw new Error(`Git command requires verification (${result.status}, exit ${result.exitCode}): ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  private async invoke(root: string, args: string[], signal: AbortSignal, clientConfig = false): Promise<CommandResult> {
    const environment: Record<string, string | undefined> = {};
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_') && !['GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT'].includes(name)) {
        environment[name] = undefined;
      }
    }
    if (!clientConfig) { environment.GIT_CONFIG_NOSYSTEM = '1'; environment.GIT_CONFIG_GLOBAL = '/dev/null'; }
    return this.files.command({executable: GIT, args: ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'core.fsync=committed,reference', '-c', 'core.fsyncMethod=fsync',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.ext.allow=never', ...args], timeoutMs: 30_000}, root, signal, environment);
  }
}
