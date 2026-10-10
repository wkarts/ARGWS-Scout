import { ConnectApiError } from "./connect-api.ts";

/** Remote removal is idempotent. It never treats network errors as success. */
export async function deleteRemoteInstance(
  scopedKey: string,
  administrativeKey: string,
  remove: (apiKey: string) => Promise<unknown>,
): Promise<"removed" | "already-missing"> {
  const keys = [...new Set([scopedKey, administrativeKey].filter(Boolean))];
  if (!keys.length) throw new ConnectApiError("Token de exclusão indisponível.", 401);
  for (let index = 0; index < keys.length; index++) {
    try {
      const response = await remove(keys[index]!);
      if (response && typeof response === "object") {
        const result = response as Record<string, unknown>;
        if (result.error === true || result.status === false || result.status === "ERROR") {
          throw new ConnectApiError("A Connect|API não confirmou a exclusão da instância.", 502);
        }
      }
      return "removed";
    } catch (error) {
      if (error instanceof ConnectApiError && [404, 410].includes(error.statusCode ?? 0)) {
        return "already-missing";
      }
      if (
        error instanceof ConnectApiError &&
        [401, 403].includes(error.statusCode ?? 0) &&
        index < keys.length - 1
      ) continue;
      throw error;
    }
  }
  throw new ConnectApiError("Não foi possível autorizar a exclusão remota.", 403);
}
