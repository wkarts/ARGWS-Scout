<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  Check,
  Link2,
  MessageCircle,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
} from "@lucide/vue";
import { api } from "../api";

type WhatsAppInstance = {
  id: string;
  name: string;
  integration: string;
  connectionState: string | null;
  number: string | null;
  profileName: string | null;
  present: boolean;
  usable: boolean;
  updatedAt: string;
};
type WhatsAppOverview = {
  configured: boolean;
  baseUrl: string;
  defaultInstanceName: string | null;
  instances: WhatsAppInstance[];
  canManage: boolean;
  canPublish: boolean;
};
type Publication = {
  id: string;
  jobId: string | null;
  sourceName: string | null;
  instanceName: string;
  recipientLast4: string;
  messageLength: number;
  status: string;
  statusCode: number | null;
  errorCode: string | null;
  createdAt: string;
  sentAt: string | null;
};

const props = defineProps<{ role: string }>();
const emit = defineEmits<{
  error: [message: string];
  notify: [message: string];
}>();
const busy = ref(false);
const loading = ref(true);
const configured = ref(false);
const baseUrl = ref("");
const apiKey = ref("");
const defaultInstanceName = ref<string | null>(null);
const instances = ref<WhatsAppInstance[]>([]);
const publications = ref<Publication[]>([]);
const createName = ref("");
const importName = ref("");
const importToken = ref("");
const showCreate = ref(false);
const showImport = ref(false);
const connectionPayload = ref<unknown>(null);
const connectionInstance = ref("");

const canManage = computed(() => ["OWNER", "ADMIN"].includes(props.role));
const usableInstances = computed(() =>
  instances.value.filter((item) => item.usable),
);
const qrImage = computed(() => findQrImage(connectionPayload.value));
const pairingCode = computed(() =>
  findString(connectionPayload.value, ["pairingCode", "pairing_code"]),
);

function findQrImage(value: unknown, depth = 0): string {
  if (depth > 4 || !value) return "";
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return value;
    return "";
  }
  if (typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["base64", "qrCode", "qrcode", "qr", "image"]) {
    const child = item[key];
    if (typeof child === "string" && child.length > 80) {
      if (child.startsWith("data:image/")) return child;
      if (/^[A-Za-z0-9+/=]+$/.test(child))
        return `data:image/png;base64,${child}`;
    }
    const nested = findQrImage(child, depth + 1);
    if (nested) return nested;
  }
  for (const child of Object.values(item)) {
    const nested = findQrImage(child, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function findString(value: unknown, keys: string[], depth = 0): string {
  if (depth > 4 || !value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof item[key] === "string") return item[key] as string;
  for (const child of Object.values(item)) {
    const nested = findString(child, keys, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function formatState(state?: string | null) {
  const value = state?.toLowerCase() ?? "unknown";
  return (
    (
      {
        open: "Conectada",
        connecting: "Conectando",
        close: "Desconectada",
        unknown: "Sem estado",
      } as Record<string, string>
    )[value] ??
    state ??
    "Sem estado"
  );
}

async function refresh() {
  loading.value = true;
  try {
    const data = await api<WhatsAppOverview>("/whatsapp");
    configured.value = data.configured;
    baseUrl.value = data.baseUrl;
    defaultInstanceName.value = data.defaultInstanceName;
    instances.value = data.instances;
    publications.value = data.configured
      ? (await api<{ data: Publication[] }>("/whatsapp/publications")).data
      : [];
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Falha ao carregar o manager WhatsApp.",
    );
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  busy.value = true;
  try {
    const data = await api<WhatsAppOverview>("/whatsapp/config", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: baseUrl.value, apiKey: apiKey.value }),
    });
    configured.value = data.configured;
    baseUrl.value = data.baseUrl;
    defaultInstanceName.value = data.defaultInstanceName;
    instances.value = data.instances;
    apiKey.value = "";
    emit("notify", "Conexão com a Connect API validada e salva.");
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível validar a Connect API.",
    );
  } finally {
    busy.value = false;
  }
}

async function syncInstances() {
  busy.value = true;
  try {
    instances.value = (
      await api<{ data: WhatsAppInstance[] }>("/whatsapp/sync", {
        method: "POST",
        body: "{}",
      })
    ).data;
    emit("notify", "Instâncias sincronizadas.");
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível sincronizar as instâncias.",
    );
  } finally {
    busy.value = false;
  }
}

async function createInstance() {
  busy.value = true;
  try {
    await api("/whatsapp/instances", {
      method: "POST",
      body: JSON.stringify({ name: createName.value }),
    });
    createName.value = "";
    showCreate.value = false;
    emit(
      "notify",
      "Instância WhatsApp criada. Abra o pareamento para conectar o telefone.",
    );
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível criar a instância.",
    );
  } finally {
    busy.value = false;
  }
}

async function importInstance() {
  busy.value = true;
  try {
    await api("/whatsapp/instances/import", {
      method: "POST",
      body: JSON.stringify({
        name: importName.value,
        token: importToken.value,
      }),
    });
    importName.value = "";
    importToken.value = "";
    showImport.value = false;
    emit("notify", "Instância existente vinculada com token próprio.");
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível vincular a instância.",
    );
  } finally {
    busy.value = false;
  }
}

async function chooseDefault(name: string | null) {
  busy.value = true;
  try {
    const result = await api<{ defaultInstanceName: string | null }>(
      "/whatsapp/default",
      {
        method: "PUT",
        body: JSON.stringify({ instanceName: name }),
      },
    );
    defaultInstanceName.value = result.defaultInstanceName;
    emit(
      "notify",
      name
        ? `Instância padrão definida: ${name}.`
        : "Instância padrão removida.",
    );
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível alterar a instância padrão.",
    );
  } finally {
    busy.value = false;
  }
}

async function instanceAction(instance: WhatsAppInstance, action: string) {
  busy.value = true;
  connectionPayload.value = null;
  try {
    const result = await api<{ result?: unknown; state?: string }>(
      `/whatsapp/instances/${encodeURIComponent(instance.name)}/${action}`,
      { method: "POST", body: "{}" },
    );
    if (action === "connect") {
      connectionInstance.value = instance.name;
      connectionPayload.value = result.result;
    } else if (action === "status") {
      emit("notify", `${instance.name}: ${formatState(result.state)}.`);
      await refresh();
    } else {
      emit(
        "notify",
        action === "logout"
          ? `Desconectada: ${instance.name}.`
          : `Reiniciada: ${instance.name}.`,
      );
      await refresh();
    }
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Falha ao executar a ação na instância.",
    );
  } finally {
    busy.value = false;
  }
}

async function deleteInstance(instance: WhatsAppInstance) {
  if (
    !window.confirm(
      `Excluir definitivamente a instância “${instance.name}” da Connect API?`,
    )
  )
    return;
  busy.value = true;
  try {
    await api(`/whatsapp/instances/${encodeURIComponent(instance.name)}`, {
      method: "DELETE",
    });
    emit("notify", `Instância ${instance.name} excluída da Connect API.`);
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível excluir a instância.",
    );
  } finally {
    busy.value = false;
  }
}

function statusClass(value: string) {
  return value === "SENT"
    ? "succeeded"
    : value === "FAILED"
      ? "failed"
      : value === "UNKNOWN"
        ? "running"
        : "queued";
}

onMounted(() => void refresh());
</script>

<template>
  <div class="whatsapp-console">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Connect API</h2>
          <p>Gerencie a conexão WhatsApp dedicada a esta organização.</p>
        </div>
        <span class="status-pill" :class="configured ? 'succeeded' : 'running'"
          ><i></i>{{ configured ? "Configurada" : "Não configurada" }}</span
        >
      </div>
      <form class="wa-config-form" @submit.prevent="saveConfig">
        <label
          >URL base da Connect API<input
            v-model="baseUrl"
            type="url"
            placeholder="https://connect.exemplo.com"
            autocomplete="url"
            required
            :disabled="!canManage"
        /></label>
        <label
          >Chave administrativa<input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            :placeholder="
              configured
                ? 'Deixe vazio para manter a chave guardada'
                : 'Informe a chave apikey da Connect API'
            "
            :required="!configured"
            :disabled="!canManage"
        /></label>
        <p class="muted wa-security-note">
          A chave fica cifrada no backend e nunca é enviada de volta ao Manager.
          As ações de cada instância usam o token próprio dela.
        </p>
        <div class="wa-actions">
          <button
            v-if="canManage"
            class="button primary"
            :disabled="busy || !baseUrl || (!configured && !apiKey)"
          >
            <Check :size="15" />{{ busy ? "Validando…" : "Testar e salvar" }}
          </button>
          <button
            v-if="configured && canManage"
            type="button"
            class="button outline"
            :disabled="busy"
            @click="syncInstances"
          >
            <RefreshCw :size="15" />Sincronizar
          </button>
        </div>
      </form>
    </section>

    <section v-if="configured" class="panel">
      <div class="panel-header">
        <div>
          <h2>Instâncias WhatsApp</h2>
          <p>
            Crie, conecte, monitore e selecione de onde as publicações serão
            enviadas.
          </p>
        </div>
        <div class="wa-actions">
          <button
            v-if="canManage"
            class="button outline"
            :disabled="busy"
            @click="showImport = !showImport"
          >
            <Link2 :size="15" />Vincular existente
          </button>
          <button
            v-if="canManage"
            class="button primary"
            :disabled="busy"
            @click="showCreate = !showCreate"
          >
            <Plus :size="15" />Nova instância
          </button>
        </div>
      </div>

      <form
        v-if="showCreate"
        class="wa-inline-form"
        @submit.prevent="createInstance"
      >
        <label
          >Nome da nova instância<input
            v-model="createName"
            required
            minlength="2"
            maxlength="120"
            placeholder="Ex.: Scout Vendas"
        /></label>
        <button
          class="button primary"
          :disabled="busy || createName.trim().length < 2"
        >
          Criar WhatsApp Baileys
        </button>
        <button type="button" class="button subtle" @click="showCreate = false">
          Cancelar
        </button>
      </form>

      <form
        v-if="showImport"
        class="wa-inline-form"
        @submit.prevent="importInstance"
      >
        <label
          >Nome exato no Connect API<input
            v-model="importName"
            required
            minlength="2"
            maxlength="120"
            placeholder="Nome da instância"
        /></label>
        <label
          >Token próprio da instância<input
            v-model="importToken"
            type="password"
            required
            autocomplete="new-password"
            placeholder="Token de /instance/fetchInstances"
        /></label>
        <button class="button primary" :disabled="busy || !importToken">
          Validar e vincular
        </button>
        <button type="button" class="button subtle" @click="showImport = false">
          Cancelar
        </button>
      </form>

      <div v-if="usableInstances.length" class="wa-default-row">
        <label
          >Instância padrão para novas publicações<select
            :value="defaultInstanceName ?? ''"
            :disabled="busy || !canManage"
            @change="
              chooseDefault(($event.target as HTMLSelectElement).value || null)
            "
          >
            <option value="">Selecionar em cada publicação</option>
            <option
              v-for="instance in usableInstances"
              :key="instance.id"
              :value="instance.name"
            >
              {{ instance.name
              }}{{ instance.connectionState === "open" ? " · conectada" : "" }}
            </option>
          </select></label
        >
      </div>

      <div v-if="loading" class="empty-state compact">
        <p>Carregando instâncias…</p>
      </div>
      <div v-else-if="instances.length" class="wa-instance-list">
        <article
          v-for="instance in instances"
          :key="instance.id"
          class="wa-instance-card"
        >
          <div class="wa-instance-icon"><MessageCircle :size="19" /></div>
          <div class="wa-instance-info">
            <strong>{{ instance.name }}</strong
            ><small>{{
              instance.profileName || instance.number || instance.integration
            }}</small
            ><small v-if="!instance.usable" class="wa-warning"
              >Token desta instância ausente; vincule um token próprio.</small
            >
          </div>
          <span
            class="status-pill"
            :class="
              instance.connectionState === 'open'
                ? 'succeeded'
                : instance.connectionState === 'connecting'
                  ? 'running'
                  : 'queued'
            "
            ><i></i>{{ formatState(instance.connectionState) }}</span
          >
          <button
            class="button outline small-button"
            :disabled="busy || !canManage || !instance.usable"
            @click="instanceAction(instance, 'connect')"
          >
            Conectar / QR
          </button>
          <button
            class="button outline small-button"
            :disabled="busy || !canManage || !instance.usable"
            @click="instanceAction(instance, 'status')"
          >
            Estado
          </button>
          <button
            class="button outline small-button"
            :disabled="busy || !canManage || !instance.usable"
            @click="instanceAction(instance, 'restart')"
          >
            Reiniciar
          </button>
          <button
            class="button outline small-button"
            :disabled="busy || !canManage || !instance.usable"
            @click="instanceAction(instance, 'logout')"
          >
            <Unplug :size="14" />Desconectar
          </button>
          <button
            v-if="canManage"
            class="button danger small-button"
            :disabled="busy"
            :aria-label="`Excluir ${instance.name}`"
            @click="deleteInstance(instance)"
          >
            <Trash2 :size="14" />Excluir
          </button>
        </article>
      </div>
      <div v-else class="empty-state compact">
        <span class="empty-icon"><Server :size="19" /></span>
        <h3>Nenhuma instância WhatsApp</h3>
        <p>Crie uma instância na Connect API ou sincronize as existentes.</p>
      </div>

      <div v-if="connectionPayload" class="wa-pairing">
        <button
          class="icon-button wa-pairing-close"
          aria-label="Fechar QR"
          @click="connectionPayload = null"
        >
          ×
        </button>
        <p class="eyebrow">PAREAMENTO · {{ connectionInstance }}</p>
        <h3>Conecte o WhatsApp ao telefone</h3>
        <img
          v-if="qrImage"
          :src="qrImage"
          alt="QR Code de pareamento da instância"
        />
        <p v-else class="muted">
          A Connect API não retornou uma imagem QR. Atualize o estado ou tente
          gerar o QR novamente.
        </p>
        <p v-if="pairingCode" class="wa-pairing-code">
          Código: <strong>{{ pairingCode }}</strong>
        </p>
        <p class="muted">
          No celular, abra Dispositivos conectados e escaneie este código.
        </p>
      </div>
    </section>

    <section v-if="configured" class="panel">
      <div class="panel-header">
        <div>
          <h2>Histórico de publicações</h2>
          <p>Envios feitos a partir dos resultados coletados pela Scout.</p>
        </div>
      </div>
      <div v-if="publications.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>COLETA</th>
              <th>INSTÂNCIA / DESTINO</th>
              <th>ESTADO</th>
              <th>ENVIADA EM</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in publications" :key="item.id">
              <td>
                <strong>{{ item.sourceName || "Coleta removida" }}</strong
                ><small>{{
                  new Date(item.createdAt).toLocaleString("pt-BR")
                }}</small>
              </td>
              <td>
                {{ item.instanceName
                }}<small
                  >•••• {{ item.recipientLast4 }} ·
                  {{ item.messageLength }} caracteres</small
                >
              </td>
              <td>
                <span class="status-pill" :class="statusClass(item.status)"
                  ><i></i
                  >{{
                    item.status === "SENT"
                      ? "Enviada"
                      : item.status === "UNKNOWN"
                        ? "Confirmação pendente"
                        : item.status === "FAILED"
                          ? "Falhou"
                          : item.status
                  }}</span
                ><small v-if="item.errorCode"
                  >{{ item.errorCode
                  }}{{
                    item.statusCode ? ` · HTTP ${item.statusCode}` : ""
                  }}</small
                >
              </td>
              <td>
                {{
                  item.sentAt
                    ? new Date(item.sentAt).toLocaleString("pt-BR")
                    : "—"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-state compact">
        <span class="empty-icon"><MessageCircle :size="19" /></span>
        <h3>Sem publicações</h3>
        <p>Abra uma coleta concluída e escolha “Publicar pelo WhatsApp”.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.whatsapp-console {
  display: grid;
  gap: 20px;
}
.wa-config-form {
  display: grid;
  gap: 14px;
  max-width: 760px;
  padding: 16px 18px 20px;
}
.wa-config-form label,
.wa-inline-form label,
.wa-default-row label {
  display: grid;
  gap: 7px;
  color: var(--text-secondary, #88929f);
  font-size: 13px;
}
.wa-config-form input,
.wa-inline-form input,
.wa-default-row select {
  min-height: 42px;
  width: 100%;
  border: 1px solid #dfe6ef;
  border-radius: 8px;
  padding: 0 12px;
  color: #253850;
  background: #fff;
}
.wa-security-note {
  margin: 0;
}
.wa-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.wa-inline-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  align-items: end;
  gap: 10px;
  padding: 14px;
  margin: 12px 18px;
  border: 1px solid #e8edf4;
  border-radius: 12px;
}
.wa-default-row {
  max-width: 440px;
  margin: 12px 18px 18px;
}
.wa-instance-list {
  display: grid;
  gap: 10px;
  padding: 0 18px 18px;
}
.wa-instance-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  padding: 13px;
  border: 1px solid #e8edf4;
  border-radius: 12px;
}
.wa-instance-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  color: #35c88a;
  background: #35c88a18;
}
.wa-instance-info {
  display: grid;
  flex: 1 1 170px;
  gap: 4px;
  min-width: 145px;
}
.wa-instance-info small,
.table-wrap td small {
  display: block;
  margin-top: 4px;
  color: var(--text-muted, #87919e);
}
.wa-warning {
  color: #e6a94f !important;
}
.wa-pairing {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 8px;
  margin: 18px;
  padding: 22px;
  border: 1px solid #e8edf4;
  border-radius: 14px;
  text-align: center;
}
.wa-pairing img {
  width: min(280px, 80vw);
  aspect-ratio: 1;
  border-radius: 10px;
  background: white;
}
.wa-pairing h3,
.wa-pairing p {
  margin: 0;
}
.wa-pairing-close {
  position: absolute;
  top: 8px;
  right: 8px;
}
.wa-pairing-code {
  padding: 9px 14px;
  border-radius: 8px;
  background: #f4f7fb;
  font-size: 18px;
  letter-spacing: 0.12em;
}
@media (max-width: 760px) {
  .wa-instance-card .status-pill {
    margin-right: auto;
  }
  .wa-instance-card button {
    flex: 1;
  }
}
</style>
