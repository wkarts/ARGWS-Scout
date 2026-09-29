import type { ConnectorContext, ConnectorResult } from "@argws/scout-core";
import type { Engine } from "@argws/scout-schemas";

export type ConnectorDefinition = {
  id: string;
  version: string;
  displayName: string;
  engine: Engine;
  inputSchema: Record<string, unknown>;
  execute(context: ConnectorContext): Promise<ConnectorResult>;
};

export function defineConnector<const T extends ConnectorDefinition>(
  definition: T,
): T {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(definition.id))
    throw new Error("Connector id inválido.");
  if (!definition.version.trim() || !definition.displayName.trim())
    throw new Error("Connector exige versão e nome de exibição.");
  return Object.freeze(definition);
}
