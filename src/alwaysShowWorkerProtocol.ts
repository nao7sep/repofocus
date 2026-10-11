export type AlwaysShowWorkerRequest =
  | { readonly kind: 'configure'; readonly patterns: readonly string[]; readonly platform: NodeJS.Platform }
  | { readonly kind: 'match'; readonly path: string };

export type AlwaysShowWorkerResponse =
  | { readonly kind: 'ready' }
  | { readonly kind: 'match'; readonly matches: boolean }
  | { readonly kind: 'failure'; readonly error: { readonly name: string; readonly message: string; readonly stack?: string } };
