<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Link2,
  MessageCircle,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
  X,
  QrCode,
  Smartphone,
} from "@lucide/vue";
import { api } from "../api";

type WhatsAppInstance = {
  id: string;
  name: string;
  displayName: string;
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
  mode: "global";
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
const defaultInstanceName = ref<string | null>(null);
const instances = ref<WhatsAppInstance[]>([]);
const publications = ref<Publication[]>([]);
const createName = ref("");
const createProvider = ref<"WHATSAPP-BAILEYS" | "WHATSAPP-ZAPO">("WHATSAPP-BAILEYS");
const importName = ref("");
const importToken = ref("");
const claimName = ref("");
const claimToken = ref("");
const showCreate = ref(false);
const showImport = ref(false);
const connectionPayload = ref<unknown>(null);
const connectionInstance = ref("");
const pairingInstance = ref<WhatsAppInstance | null>(null);
const pairingMode = ref<"qr" | "code">("qr");
const pairingPhone = ref("");
const pairingBusy = ref(false);
const pairingError = ref("");
const pairingState = ref("connecting");
let pairingTimer: ReturnType<typeof setTimeout> | null = null;
let pairingEpoch = 0;

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

function closePairing() {
  pairingEpoch++;
  if (pairingTimer !== null) clearTimeout(pairingTimer);
  pairingTimer = null;
  pairingInstance.value = null;
  connectionPayload.value = null;
  pairingPhone.value = "";
  pairingError.value = "";
  pairingBusy.value = false;
  pairingState.value = "connecting";
}

function planConnectionCheck(epoch: number) {
  if (epoch !== pairingEpoch || !pairingInstance.value || pairingTimer !== null) return;
  pairingTimer = setTimeout(() => {
    pairingTimer = null;
    void checkPairingState(epoch);
  }, 4500);
}

async function checkPairingState(epoch: number) {
  const instance = pairingInstance.value;
  if (!instance || epoch !== pairingEpoch) return;
  if (pairingBusy.value) {
    planConnectionCheck(epoch);
    return;
  }
  try {
    const result = await api<{ state?: string }>(
      `/whatsapp/instances/${encodeURIComponent(instance.name)}/status`,
      { method: "POST", body: "{}" },
    );
    if (epoch !== pairingEpoch || pairingInstance.value?.id !== instance.id) return;
    const state = String(result.state || "unknown").toLowerCase();
    pairingState.value = state;
    if (state === "open") {
      const name = instance.displayName || instance.name;
      closePairing();
      await refresh();
      emit("notify", `WhatsApp conectado: ${name}.`);
      return;
    }
  } catch {
    // A failed status query does not mean a failed WhatsApp connection.
    // Keep the modal open, without touching the QR/pairing code.
  }
  planConnectionCheck(epoch);
}

async function requestPairing() {
  const instance = pairingInstance.value;
  if (!instance || pairingBusy.value) return;
  const epoch = pairingEpoch;
  const isCode = pairingMode.value === "code";
  const digits = pairingPhone.value.replace(/\D/g, "");
  if (isCode && !/^[1-9]\d{7,14}$/.test(digits)) {
    pairingError.value = "Informe o telefone com país, DDD e número (ex.: 5575988881111).";
    return;
  }
  pairingBusy.value = true;
  pairingError.value = "";
  connectionPayload.value = null;
  if (pairingTimer !== null) clearTimeout(pairingTimer);
  pairingTimer = null;
  try {
    const result = await api<{ result?: unknown }>(
      `/whatsapp/instances/${encodeURIComponent(instance.name)}/${isCode ? "pairing" : "connect"}`,
      { method: "POST", body: JSON.stringify(isCode ? { number: digits } : {}) },
    );
    if (epoch !== pairingEpoch || pairingInstance.value?.id !== instance.id) return;
    connectionPayload.value = result.result ?? {};
    if (isCode && !findString(result.result, ["pairingCode", "pairing_code"]))
      pairingError.value = "O provedor não retornou o código. Confira o número e tente novamente.";
    else if (!isCode && !findQrImage(result.result))
      pairingError.value = "QR Code não disponível. Você pode tentar novamente ou usar o código de pareamento.";
  } catch (error) {
    if (epoch === pairingEpoch) {
      pairingError.value = error instanceof Error ? error.message : "Falha ao solicitar pareamento.";
    }
  } finally {
    if (epoch === pairingEpoch) {
      pairingBusy.value = false;
      planConnectionCheck(epoch);
    }
  }
}

function openPairing(instance: WhatsAppInstance) {
  closePairing();
  pairingInstance.value = instance;
  connectionInstance.value = instance.displayName || instance.name;
  pairingMode.value = "qr";
  pairingState.value = instance.connectionState ?? "connecting";
  void requestPairing();
}

function choosePairingMode(mode: "qr" | "code") {
  if (pairingMode.value === mode) return;
  pairingMode.value = mode;
  connectionPayload.value = null;
  pairingError.value = "";
  if (mode === "qr") void requestPairing();
}

function pairingEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && pairingInstance.value) closePairing();
}

async function copyPairingCode() {
  if (!pairingCode.value) return;
  try {
    await navigator.clipboard.writeText(pairingCode.value);
    emit("notify", "Código de pareamento copiado.");
  } catch {
    emit("error", "Não foi possível copiar o código. Selecione-o manualmente.");
  }
}

async function refresh() {
  loading.value = true;
  try {
    const data = await api<WhatsAppOverview>("/whatsapp");
    configured.value = data.configured;
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

async function syncInstances() {
  busy.value = true;
  try {
    instances.value = (
      await api<{ data: WhatsAppInstance[] }>("/whatsapp/sync", {
        method: "POST",
        body: "{}",
      })
    ).data;
    emit("notify", "Estados das instâncias deste espaço atualizados.");
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
    const created = await api<{ instance: WhatsAppInstance }>("/whatsapp/instances", {
      method: "POST",
      body: JSON.stringify({ name: createName.value, provider: createProvider.value }),
    });
    createName.value = "";
    showCreate.value = false;
    emit(
      "notify",
      "Instância WhatsApp criada. Abra o pareamento para conectar o telefone.",
    );
    await refresh();
    if (created.instance) openPairing(created.instance);
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

async function claimExistingInstance(instance: WhatsAppInstance) {
  if (!claimToken.value.trim()) return;
  busy.value = true;
  try {
    await api("/whatsapp/instances/claim", {
      method: "POST",
      body: JSON.stringify({ name: instance.name, token: claimToken.value }),
    });
    claimName.value = "";
    emit("notify", "Vínculo da instância revalidado com seu token particular.");
    await refresh();
  } catch (error) {
    emit(
      "error",
      error instanceof Error
        ? error.message
        : "Não foi possível revalidar esta instância.",
    );
  } finally {
    claimToken.value = "";
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
  try {
    const result = await api<{ result?: unknown; state?: string }>(
      `/whatsapp/instances/${encodeURIComponent(instance.name)}/${action}`,
      { method: "POST", body: "{}" },
    );
    if (action === "status") {
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

onMounted(() => {
  window.addEventListener("keydown", pairingEscape);
  void refresh();
});
onUnmounted(() => {
  window.removeEventListener("keydown", pairingEscape);
  closePairing();
});
</script>

<template>
  <div class="whatsapp-console">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Connect|API</h2>
          <p>Gerencie seus canais e publicações.</p>
        </div>
        <span class="status-pill" :class="configured ? 'succeeded' : 'running'"
          ><i></i>{{ configured ? "Configurada" : "Não configurada" }}</span
        >
      </div>
      <div class="wa-global-settings">
        <Server :size="20" aria-hidden="true" />
        <strong>{{ configured ? "Conexão disponível" : "Conexão indisponível" }}</strong>
        <button
          v-if="configured && canManage"
          type="button"
          class="button outline"
          :disabled="busy"
          @click="syncInstances"
        >
          <RefreshCw :size="15" /> Atualizar instâncias
        </button>
      </div>
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
        <label>Provedor WhatsApp
          <select v-model="createProvider" :disabled="busy" required>
            <option value="WHATSAPP-BAILEYS">Baileys</option>
            <option value="WHATSAPP-ZAPO">Zapo</option>
          </select>
        </label>
        <button
          class="button primary"
          :disabled="busy || createName.trim().length < 2"
        >
          Criar e conectar
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
          >Nome remoto da instância existente<input
            v-model="importName"
            required
            minlength="2"
            maxlength="120"
            placeholder="Nome da instância"
        /></label>
        <label
          >Token particular da instância<input
            v-model="importToken"
            type="password"
            required
            autocomplete="new-password"
            placeholder="Token exclusivo desta instância"
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
              {{ instance.displayName || instance.name
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
            <strong>{{ instance.displayName || instance.name }}</strong
            ><small>{{
              instance.profileName || instance.number || instance.integration
            }}</small
            ><small v-if="!instance.usable" class="wa-warning"
              >Vínculo não validado neste servidor; revalide usando o token
              particular.</small
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
            v-if="canManage && !instance.usable && configured"
            class="button outline small-button"
            :disabled="busy"
            @click="
              claimName = claimName === instance.name ? '' : instance.name;
              claimToken = '';
            "
          >
            <RefreshCw :size="14" /> Revalidar vínculo
          </button>
          <button
            class="button outline small-button"
            :disabled="busy || !canManage || !instance.usable"
            @click="openPairing(instance)"
          >
            Conectar
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
            :disabled="busy || !instance.usable"
            :aria-label="`Excluir ${instance.displayName || instance.name}`"
            @click="deleteInstance(instance)"
          >
            <Trash2 :size="14" />Excluir
          </button>
          <form
            v-if="claimName === instance.name && !instance.usable"
            class="wa-claim-form"
            @submit.prevent="claimExistingInstance(instance)"
          >
            <label>
              Token particular para revalidar o vínculo
              <input
                v-model="claimToken"
                type="password"
                autocomplete="off"
                minlength="8"
                required
                placeholder="Token exclusivo da instância"
              />
            </label>
            <button
              class="button primary"
              :disabled="busy || claimToken.length < 8"
            >
              Revalidar
            </button>
            <button
              type="button"
              class="button subtle"
              @click="
                claimName = '';
                claimToken = '';
              "
            >
              Cancelar
            </button>
          </form>
        </article>
      </div>
      <div v-else class="empty-state compact">
        <span class="empty-icon"><Server :size="19" /></span>
        <h3>Nenhuma instância WhatsApp</h3>
        <p>
          Crie sua primeira instância neste espaço. Para vínculos antigos,
          revalide o token particular.
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
    <Teleport to="body">
      <div v-if="pairingInstance" class="wa-modal-backdrop" @click.self="closePairing">
        <section
          class="wa-modal"
          role="dialog"
          aria-modal="true"
          :aria-label="'Conectar ' + connectionInstance"
        >
          <header class="wa-modal-header">
            <div>
              <span class="wa-modal-eyebrow">{{ pairingInstance.integration === 'WHATSAPP-ZAPO' ? 'Zapo' : 'Baileys' }}</span>
              <h2>Conectar {{ connectionInstance }}</h2>
              <p :class="pairingState === 'open' ? 'wa-connected' : 'muted'">
                {{ pairingState === 'open' ? 'Conectado' : 'Aguardando conexão' }}
              </p>
            </div>
            <button type="button" class="icon-button" aria-label="Fechar pareamento" @click="closePairing">
              <X :size="20" />
            </button>
          </header>
          <div class="wa-mode-switch" role="group" aria-label="Modo de pareamento">
            <button type="button" :class="{ active: pairingMode === 'qr' }" :disabled="pairingBusy" @click="choosePairingMode('qr')">
              <QrCode :size="17" /> QR Code
            </button>
            <button type="button" :class="{ active: pairingMode === 'code' }" :disabled="pairingBusy" @click="choosePairingMode('code')">
              <Smartphone :size="17" /> Código de pareamento
            </button>
          </div>
          <div class="wa-modal-body">
            <div v-if="pairingMode === 'qr'" class="wa-qr-area">
              <div v-if="pairingBusy" class="wa-pairing-progress" role="status">Obtendo QR Code…</div>
              <img v-else-if="qrImage" :src="qrImage" alt="QR Code para vincular o WhatsApp" class="wa-qr-image" />
              <div v-else class="wa-qr-placeholder"><QrCode :size="50" /><span>QR Code indisponível</span></div>
              <p class="muted">WhatsApp → Aparelhos conectados → Conectar um aparelho.</p>
              <button type="button" class="button outline" :disabled="pairingBusy" @click="requestPairing">
                <RefreshCw :size="15" /> Atualizar QR Code
              </button>
            </div>
            <div v-else class="wa-code-area">
              <form class="wa-code-form" @submit.prevent="requestPairing">
                <label>Telefone com DDI e DDD
                  <input v-model="pairingPhone" type="tel" inputmode="tel" autocomplete="tel"
                    placeholder="5575988881111" maxlength="24" required />
                </label>
                <button type="submit" class="button primary" :disabled="pairingBusy || pairingPhone.replace(/\D/g, '').length < 8">
                  {{ pairingBusy ? 'Solicitando…' : 'Gerar código' }}
                </button>
              </form>
              <div v-if="pairingCode" class="wa-code-result" role="status" aria-live="polite">
                <span>Código de pareamento</span>
                <strong>{{ pairingCode }}</strong>
                <button type="button" class="button outline" @click="copyPairingCode">Copiar código</button>
              </div>
              <p class="muted">No WhatsApp: Aparelhos conectados → Conectar com número de telefone.</p>
            </div>
            <p v-if="pairingError" class="wa-modal-error" role="alert">{{ pairingError }}</p>
            <p class="wa-modal-status">A conexão é verificada automaticamente. Esta janela fechará quando o aparelho conectar.</p>
          </div>
          <footer class="wa-modal-footer">
            <button type="button" class="button subtle" @click="closePairing">Fechar</button>
          </footer>
        </section>
      </div>
    </Teleport>
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
.wa-global-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px;
  padding: 18px 20px 22px;
  color: #41516b;
}
.wa-global-settings > svg {
  flex: 0 0 auto;
  color: #2563eb;
  margin-top: 3px;
}
.wa-global-settings > div {
  flex: 1 1 300px;
  min-width: 0;
}
.wa-global-settings strong {
  color: #172e4a;
  font-size: 14px;
}
.wa-global-settings p {
  color: #62758b;
  font-size: 13px;
  line-height: 1.55;
  margin: 7px 0;
  overflow-wrap: anywhere;
}
.wa-global-settings > .button {
  flex: 0 1 auto;
  white-space: normal;
}
.wa-inline-form {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
}
.wa-instance-list,
.wa-instance-card,
.wa-instance-info {
  min-width: 0;
  max-width: 100%;
}
.wa-instance-info {
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .wa-global-settings {
    padding: 14px;
    gap: 10px;
  }
  .wa-global-settings > .button {
    width: 100%;
  }
  .wa-inline-form {
    margin: 10px;
    grid-template-columns: 1fr;
  }
  .wa-instance-list {
    padding: 0 10px 12px;
  }
  .wa-instance-card {
    padding: 12px;
  }
  .wa-instance-info {
    flex: 1 1 100%;
  }
  .wa-instance-card .button {
    flex: 1 1 135px;
  }
}
.wa-claim-form {
  flex: 1 1 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  border-top: 1px solid #e8edf4;
  padding-top: 12px;
  min-width: 0;
}
.wa-claim-form label {
  display: grid;
  gap: 6px;
  flex: 1 1 240px;
  min-width: 0;
  font-size: 13px;
  color: #42536a;
}
.wa-claim-form input {
  width: 100%;
  min-height: 40px;
  border: 1px solid #dfe6ef;
  border-radius: 8px;
  padding: 0 10px;
}
.wa-claim-form > button {
  flex: 0 1 auto;
}
@media (max-width: 500px) {
  .wa-claim-form > button {
    flex: 1 1 110px;
  }
}

/* QR / pairing-code dialog lives in <body> and is not constrained by the Manager columns. */
.wa-modal-backdrop { position:fixed; inset:0; z-index:120; display:grid; place-items:center; padding:clamp(8px,3vw,24px); background:rgba(14,30,52,.60); }
.wa-modal { display:flex; flex-direction:column; width:min(100%,560px); max-height:calc(100dvh - 20px); min-width:0; overflow:hidden; border-radius:16px; background:#fff; box-shadow:0 28px 95px #071b3948; color:#21344e; }
.wa-modal-header { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; padding:20px 22px 13px; border-bottom:1px solid #e5ebf4; }
.wa-modal-header > div { min-width:0; }
.wa-modal-header h2 { font-size:19px; line-height:1.3; overflow-wrap:anywhere; margin:3px 0 2px; }
.wa-modal-header p { font-size:12px; margin:0; }
.wa-modal-eyebrow { font-size:10px; font-weight:750; letter-spacing:.09em; text-transform:uppercase; color:#5376b8; }
.wa-connected { color:#0b8554; }
.wa-mode-switch { display:flex; flex-wrap:wrap; gap:8px; padding:14px 22px; }
.wa-mode-switch button { flex:1 1 150px; display:flex; align-items:center; justify-content:center; gap:8px; min-height:40px; border:1px solid #dce5f0; border-radius:9px; background:#fff; color:#31455f; font-weight:650; font-size:13px; }
.wa-mode-switch button.active { background:#edf4ff; border-color:#8eb1f0; color:#1b5fce; }
.wa-modal-body { padding:8px 22px 20px; overflow:auto; min-height:0; }
.wa-qr-area,.wa-code-area { display:grid; justify-items:center; gap:14px; text-align:center; }
.wa-qr-image { display:block; width:min(100%,268px); max-height:268px; aspect-ratio:1; object-fit:contain; background:#fff; }
.wa-qr-placeholder,.wa-pairing-progress { width:min(100%,268px); min-height:190px; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:12px; background:#f3f7fc; border:1px dashed #c5d4e6; border-radius:12px; color:#7185a2; }
.wa-qr-area p,.wa-code-area p { font-size:13px; line-height:1.5; margin:0; }
.wa-code-form { display:flex; flex-wrap:wrap; gap:10px; width:100%; text-align:left; align-items:flex-end; }
.wa-code-form label { display:grid; flex:1 1 190px; gap:7px; font-size:13px; color:#43556c; }
.wa-code-form input { display:block; width:100%; min-height:42px; padding:0 12px; border:1px solid #d3dfed; border-radius:9px; font-size:15px; }
.wa-code-result { display:grid; justify-items:center; gap:9px; width:100%; border-radius:12px; background:#f0f6ff; padding:18px 12px; }
.wa-code-result > span { font-size:12px; color:#506d96; }
.wa-code-result strong { font:750 clamp(21px,5vw,30px)/1.3 ui-monospace,Consolas,monospace; letter-spacing:.08em; overflow-wrap:anywhere; color:#164893; }
.wa-modal-error { color:#a22636; background:#fff0f3; font-size:12px; border-radius:7px; padding:10px; margin:12px 0; }
.wa-modal-status { font-size:12px; line-height:1.55; color:#73849b; text-align:center; margin:16px 0 0; }
.wa-modal-footer { display:flex; justify-content:flex-end; padding:13px 22px; border-top:1px solid #e5ebf4; }
.wa-inline-form select { width:100%; height:42px; padding:0 11px; border:1px solid #dfe6ef; border-radius:8px; background:#fff; }
@media(max-width:480px) {
  .wa-modal-backdrop { padding:8px; }
  .wa-modal { width:100%; max-height:calc(100dvh - 16px); border-radius:12px; }
  .wa-modal-header { padding:14px; }
  .wa-modal-body { padding:8px 14px 14px; }
  .wa-mode-switch { padding:10px 14px; }
  .wa-code-form > button { flex:1 1 100%; }
  .wa-modal-footer { padding:10px 14px; }
}
</style>
