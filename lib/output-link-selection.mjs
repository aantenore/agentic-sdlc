/**
 * Selection of the output link that satisfies one contract output ref.
 *
 * A story can keep links from earlier, replaced contracts (for example a
 * cancelled delivery). Superseded links never count. When more than one
 * active link matches the ref exactly, the links recorded under the current
 * contract win; legacy links without a contract_id stay eligible only when
 * the current contract has none of its own.
 */
export function isActiveOutputLink(link) {
  return Boolean(link) && !link.superseded_by;
}

export function selectExactOutputLinks(links, { storyId, artifactType, templateId, mode, contractId = null }) {
  const matches = (Array.isArray(links) ? links : []).filter((link) =>
    isActiveOutputLink(link)
    && link.story_id === storyId
    && link.artifact_type === artifactType
    && link.template_id === templateId
    && link.mode === mode);
  if (matches.length <= 1 || !contractId) {
    return matches;
  }
  const scoped = matches.filter((link) => link.contract_id === contractId);
  return scoped.length > 0 ? scoped : matches;
}
