// Ruling 41: which adapter a command runs work with. ONE function, so
// `buildAdapter`, `/health` and `doctor` cannot disagree. It resolves the KIND
// only -- it never constructs an adapter and never starts anything.
export type AdapterKind = 'claude' | 'fake';
export type AdapterSource = 'flag' | 'env' | 'default';

export const ADAPTER_ENV_VAR = 'MAGARINE_ADAPTER';

export interface AdapterChoice {
  kind: string; // not narrowed: an unknown name is refused later, by name
  source: AdapterSource;
}

export function resolveAdapterChoice(
  flagValue: string | boolean | string[] | undefined,
  env: NodeJS.ProcessEnv
): AdapterChoice {
  if (typeof flagValue === 'string') return { kind: flagValue, source: 'flag' };
  const fromEnv = env[ADAPTER_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { kind: fromEnv.trim(), source: 'env' };
  return { kind: 'claude', source: 'default' };
}

export const FAKE_FLAGS_NEED_FAKE =
  'The --fake-script, --fake-outcome and --fake-progress-gap flags only work with the fake adapter; add --adapter fake (or set MAGARINE_ADAPTER=fake).';
