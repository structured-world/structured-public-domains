/** Result of a PSL lookup. */
export interface DomainInfo {
  /** The public suffix (e.g. `"co.uk"`, `"com"`, `"github.io"`). */
  readonly suffix: string;
  /** The registrable domain (eTLD+1), or `undefined` if the input is itself a suffix. */
  readonly registrableDomain: string | undefined;
  /** Whether the suffix matched an explicit PSL rule (vs the `*` fallback). */
  readonly known: boolean;
}

/**
 * Look up a domain in the Public Suffix List.
 *
 * Returns `undefined` for empty or invalid input.
 */
export function lookup(domain: string): DomainInfo | undefined;

/**
 * Extract the registrable domain (eTLD+1).
 *
 * Returns `undefined` if the domain is itself a public suffix.
 */
export function registrableDomain(domain: string): string | undefined;

/**
 * Check if a domain's suffix is a known entry in the PSL.
 */
export function isKnownSuffix(domain: string): boolean;
