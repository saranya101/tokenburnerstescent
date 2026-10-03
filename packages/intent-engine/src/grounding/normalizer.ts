/** Conservative normalization used only for deterministic name comparisons. */
export function normalizeEntityReference(reference: string): string {
  return reference.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
