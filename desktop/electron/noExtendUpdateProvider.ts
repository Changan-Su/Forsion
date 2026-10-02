import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import type { AppUpdater } from 'electron-updater'
import type { CustomPublishOptions } from 'builder-util-runtime'

/** Keep GitHub's stable/beta release selection, including its beta → latest fallback,
 * but resolve every manifest inside the NoExtend distribution. The base class adds
 * the platform suffix, so Linux requests latest-no-extend-linux.yml. */
export class NoExtendUpdateProvider extends GitHubProvider {
  constructor(options: CustomPublishOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super({ provider: 'github', owner: options.owner, repo: options.repo }, updater, runtimeOptions)
  }

  protected getDefaultChannelName(): string {
    return super.getCustomChannelName('latest-no-extend')
  }

  protected getCustomChannelName(channel: string): string {
    return super.getCustomChannelName(`${channel}-no-extend`)
  }
}
