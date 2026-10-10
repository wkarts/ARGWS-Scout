import { ConnectApiError } from "./connect-api.ts";

/** Delete only with the workspace's own per-instance token.
 * Never fall back to the server-wide Connect administrative token.
 */
export async function deleteRemoteInstance(
  scopedKey: string,
  remove: (apiKey: string) => Promise<unknown>,
): Promise<"removed" | "already-missing"> {
  if (!scopedKey.trim())
    throw new ConnectApiError(
      "O token particular da instância não está disponível.",
      401,
    );
  try {
    const response = await remove(scopedKey);
    if (response && typeof response === "object") {
      const result = response as Record<string, unknown>;
      if (
        result.error === true ||
        result.status === false ||
        result.status === "ERROR"
      )
        throw new ConnectApiError(
          "A Connect|API não confirmou a exclusão da instância.",
          502,
        );
    }
    return "removed";
  } catch (error) {
    if (
      error instanceof ConnectApiError &&
      [404, 410].includes(error.statusCode ?? 0)
    )
      return "already-missing";
    throw error;
  }
}
