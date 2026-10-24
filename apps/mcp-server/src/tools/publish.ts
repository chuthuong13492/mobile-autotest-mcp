/** TL-18 `publish_github_report` (GH-005): the use case lives in `@autotest/workflow` (`publishReport`). */
import { publishReport, type PublishDeps, type UseCases } from '@autotest/workflow';

export function publishUseCases(deps: PublishDeps): Pick<UseCases, 'publish_github_report'> {
  return { publish_github_report: (input) => publishReport(deps, input) };
}
