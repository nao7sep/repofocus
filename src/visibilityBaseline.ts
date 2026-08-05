import type { GitRepository } from './gitApi';
import type { VisibilityMapping } from './visibilityCommandResolver';
import type { ToggleVisibility } from './visibilityReconciler';

export class VisibilityBaselineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisibilityBaselineError';
  }
}

function key(repository: GitRepository): string {
  return repository.rootUri.toString();
}

async function waitUntilDeselected(repository: GitRepository, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (repository.ui.selected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return !repository.ui.selected;
}

export async function establishAllVisibleBaseline(
  repositories: readonly GitRepository[],
  mappings: readonly VisibilityMapping[],
  toggle: ToggleVisibility,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  const mappingByRepository = new Map(mappings.map(mapping => [mapping.repository.rootUri.toString(), mapping]));
  if (mappingByRepository.size !== repositories.length) {
    throw new VisibilityBaselineError('Every Git repository must have exactly one native visibility command.');
  }

  const hiddenDuringProbe: VisibilityMapping[] = [];
  const visited = new Set<string>();
  let sentinel: VisibilityMapping | undefined;

  while (true) {
    const selected = repositories.find(repository => repository.ui.selected);
    if (!selected) break;
    const repositoryKey = key(selected);
    if (visited.has(repositoryKey)) {
      throw new VisibilityBaselineError('Repository focus repeated while probing native visibility.');
    }
    const mapping = mappingByRepository.get(repositoryKey);
    if (!mapping) {
      throw new VisibilityBaselineError('The focused Git repository has no native visibility command.');
    }

    visited.add(repositoryKey);
    try {
      await toggle(mapping.command);
      if (await waitUntilDeselected(selected, timeoutMilliseconds)) {
        hiddenDuringProbe.push(mapping);
      } else {
        // VS Code does not emit a deselection event after hiding the final visible
        // repository. Restore it as a visible sentinel so focus parity is not lost.
        await toggle(mapping.command);
        sentinel = mapping;
        break;
      }
    } catch (error) {
      try {
        await toggle(mapping.command);
      } catch {
        // The original error remains the most useful compatibility diagnostic.
      }
      for (const hidden of hiddenDuringProbe) await toggle(hidden.command);
      throw new VisibilityBaselineError('Failed to probe native repository visibility.', { cause: error });
    }
  }

  const shownFromAllHidden: VisibilityMapping[] = [];
  try {
    for (const mapping of mappings) {
      if (mapping === sentinel) continue;
      await toggle(mapping.command);
      shownFromAllHidden.push(mapping);
    }
  } catch (error) {
    for (const shown of shownFromAllHidden.reverse()) await toggle(shown.command);
    for (const initiallyVisible of hiddenDuringProbe) await toggle(initiallyVisible.command);
    throw new VisibilityBaselineError('Failed to establish an all-visible repository baseline.', { cause: error });
  }
}
