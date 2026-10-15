/** How an endpoint sends its key: bearer (default), an Azure-style `api-key` header, or none. */
export type EndpointAuth = 'bearer' | 'api-key' | 'none';

/** Request headers for a key under an auth style, plus any extra configured headers. */
export function authHeaders(
  apiKey: string | undefined,
  auth: EndpointAuth | undefined,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const key =
    !apiKey || auth === 'none'
      ? {}
      : auth === 'api-key'
        ? { 'api-key': apiKey }
        : { authorization: `Bearer ${apiKey}` };
  return { ...(extra ?? {}), ...key };
}
