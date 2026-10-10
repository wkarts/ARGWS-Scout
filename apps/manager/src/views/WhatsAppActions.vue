<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";

type Instance = {
  id: string;
  name: string;
  displayName?: string;
  integration: string;
  connectionState: string | null;
  usable: boolean;
};
type History = {
  id: string;
  remoteInstance: string;
  kind: string;
  status: string;
  errorCode?: string | null;
  createdAt: string;
};
type Product = { id: string; name: string; url: string; description: string; price: string };

const props = defineProps<{ instances: Instance[]; role: string }>();
const emit = defineEmits<{ error: [message: string]; notify: [message: string] }>();
const current = ref("");
const busy = ref(false);
const content = ref("");
const mediaType = ref<"text" | "image">("text");
const caption = ref("");
const font = ref(1);
const backgroundColor = ref("#1d4ed8");
const everyone = ref(false);
const recipients = ref("");
const statuses = ref<Record<string, unknown>[]>([]);
const products = ref<Product[]>([]);
const catalogCursor = ref("");
const history = ref<History[]>([]);
const share = ref({ number: "", title: "", productUrl: "", description: "" });
const canPublish = computed(() => ["OWNER", "ADMIN", "OPERATOR"].includes(props.role));

watch(() => props.instances, (list) => {
  if (!list.some((instance) => instance.name === current.value))
    current.value = list[0]?.name ?? "";
}, { immediate: true });

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unwrapList(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object").slice(0, 100).map(asRecord);
  const root = asRecord(value);
  for (const key of keys) {
    const rows = root[key];
    if (Array.isArray(rows)) return unwrapList(rows, keys);
    if (rows && typeof rows === "object") return unwrapList(rows, keys);
  }
  return [];
}
function normalizeProducts(raw: unknown): Product[] {
  return unwrapList(raw, ["data", "catalog", "products", "response"]).map((product) => ({
    id: String(product.id ?? product.productId ?? ""),
    name: String(product.name ?? product.title ?? product.id ?? "Produto").slice(0, 280),
    url: String(product.url ?? product.productUrl ?? "").slice(0, 2048),
    description: String(product.description ?? "").slice(0, 1500),
    price: String(product.price ?? "").slice(0, 100),
  }));
}
function failure(error: unknown) {
  emit("error", error instanceof Error ? error.message : "Não foi possível concluir a operação.");
}
async function request<T>(path: string, opts?: Parameters<typeof api>[1]): Promise<T | null> {
  busy.value = true;
  try { return await api<T>(path, opts); }
  catch (error) { failure(error); return null; }
  finally { busy.value = false; }
}
async function loadHistory() {
  const result = await request<{ data: History[] }>("/whatsapp/channel-actions");
  if (result) history.value = result.data;
}
async function loadStatuses() {
  if (!current.value) return;
  const result = await request<{ data: unknown }>(`/whatsapp/instances/${encodeURIComponent(current.value)}/statuses`);
  if (result) statuses.value = unwrapList(result.data, ["data", "messages", "records"]);
}
async function loadCatalog() {
  if (!current.value) return;
  const path = `/whatsapp/instances/${encodeURIComponent(current.value)}/catalog?limit=20` +
    (catalogCursor.value ? `&cursor=${encodeURIComponent(catalogCursor.value)}` : "");
  const result = await request<{ data: unknown }>(path);
  if (!result) return;
  products.value = normalizeProducts(result.data);
  const root = asRecord(result.data);
  catalogCursor.value = typeof root.nextPageCursor === "string" ? root.nextPageCursor : "";
  if (!products.value.length) emit("notify", "O canal não retornou produtos disponíveis.");
}
function selectProduct(item: Product) {
  share.value.title = item.name;
  share.value.productUrl = item.url;
  share.value.description = item.description;
  emit("notify", "Revise o texto, o link do produto e o destinatário antes de compartilhar.");
}
function parsedRecipients() {
  return [...new Set(recipients.value.split(/[;,\s]+/).filter(Boolean))];
}
async function publishStatus() {
  if (!current.value || !canPublish.value) return;
  const list = parsedRecipients();
  if (!everyone.value && !list.length) {
    emit("error", "Informe destinatários ou autorize explicitamente todos os contatos.");
    return;
  }
  if (!window.confirm("Publicar este status no WhatsApp? O envio não poderá ser cancelado automaticamente.")) return;
  const payload = {
    type: mediaType.value,
    content: content.value.trim(),
    caption: caption.value.trim() || undefined,
    font: font.value,
    backgroundColor: backgroundColor.value,
    allContacts: everyone.value,
    ...(everyone.value ? {} : { statusJidList: list }),
    confirmed: true,
  };
  const result = await request<{ action: { status: string }; message?: string }>(
    `/whatsapp/instances/${encodeURIComponent(current.value)}/statuses`,
    { method: "POST", body: JSON.stringify(payload), headers: { "Idempotency-Key": crypto.randomUUID() } },
  );
  if (!result) return;
  if (result.action.status === "SENT") {
    content.value = "";
    emit("notify", "Status enviado para a Connect|API.");
  } else emit("error", result.message ?? "Confirmação pendente. Consulte a instância antes de repetir.");
  await loadHistory();
}
async function shareProduct() {
  if (!current.value || !canPublish.value) return;
  if (!window.confirm(`Compartilhar este produto pelo WhatsApp com ${share.value.number}? Confirme o destinatário.`)) return;
  const result = await request<{ action: { status: string }; message?: string }>(
    `/whatsapp/instances/${encodeURIComponent(current.value)}/catalog/share`,
    { method: "POST", body: JSON.stringify({ ...share.value, confirmed: true }),
      headers: { "Idempotency-Key": crypto.randomUUID() } },
  );
  if (!result) return;
  if (result.action.status === "SENT") emit("notify", "Produto compartilhado com confirmação da Connect|API.");
  else emit("error", result.message ?? "Resultado incerto: confira o destino antes de repetir.");
  await loadHistory();
}
</script>

<template>
  <section class="panel wa-features">
    <header class="panel-header">
      <div>
        <h2>Publicações e catálogo WhatsApp</h2>
        <p>Ações manuais na instância do seu espaço de trabalho. Nenhum envio automático.</p>
      </div>
      <button class="button outline" :disabled="busy" @click="loadHistory">Atualizar histórico</button>
    </header>
    <div class="wa-features-body">
      <label class="wa-field">Instância conectada
        <select v-model="current" :disabled="busy">
          <option v-for="instance in props.instances" :key="instance.id" :value="instance.name">
            {{ instance.displayName || instance.name }}
          </option>
        </select>
      </label>
      <div v-if="!current" class="muted">Crie ou vincule uma instância WhatsApp válida antes de publicar.</div>
      <template v-else>
        <div class="wa-feature-grid">
          <form class="wa-feature-box" @submit.prevent="publishStatus">
            <h3>Publicar status</h3>
            <label class="wa-field">Tipo
              <select v-model="mediaType">
                <option value="text">Texto</option>
                <option value="image">Imagem por URL HTTPS pública</option>
              </select>
            </label>
            <label class="wa-field">{{ mediaType === "text" ? "Mensagem" : "URL HTTPS da imagem" }}
              <textarea v-if="mediaType === 'text'" v-model="content" required maxlength="4096" rows="4" />
              <input v-else v-model="content" type="url" required maxlength="4096" placeholder="https://cdn.exemplo.com/foto.png" />
            </label>
            <label v-if="mediaType === 'image'" class="wa-field">Legenda
              <input v-model="caption" maxlength="1024" placeholder="Legenda opcional" />
            </label>
            <div v-if="mediaType === 'text'" class="wa-presentation">
              <label class="wa-field">Cor de fundo <input v-model="backgroundColor" type="color" /></label>
              <label class="wa-field">Fonte
                <select v-model.number="font">
                  <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
                </select>
              </label>
            </div>
            <label class="wa-field">Destinatários (DDI + DDD, separados por vírgula)
              <textarea v-model="recipients" rows="2" placeholder="5575999999999" :disabled="everyone" />
            </label>
            <label class="wa-check"><input v-model="everyone" type="checkbox" /> Enviar para todos os meus contatos (requer confirmação)</label>
            <button class="button primary" :disabled="busy || !canPublish || !content.trim()">Confirmar e publicar status</button>
            <button class="button subtle" type="button" :disabled="busy" @click="loadStatuses">Consultar status publicados</button>
            <div v-if="statuses.length" class="wa-status-list">
              <strong>Publicações encontradas: {{ statuses.length }}</strong>
              <div v-for="(item, i) in statuses" :key="i">
                <span>{{ String(item.messageTimestamp ?? item.createdAt ?? item.timestamp ?? "") }}</span>
                <small>{{ String(item.key && typeof item.key === "object" ? (item.key as Record<string, unknown>).id ?? "" : item.id ?? "") }}</small>
              </div>
            </div>
          </form>
          <div class="wa-feature-box">
            <h3>Catálogo comercial</h3>
            <p class="muted">Consulte os produtos oferecidos pelo canal. O cadastro nativo de itens não é fornecido pelo contrato atual da Connect|API.</p>
            <button class="button subtle" type="button" :disabled="busy" @click="loadCatalog">Consultar catálogo</button>
            <div v-if="products.length" class="wa-catalog-list">
              <button v-for="item in products" :key="item.id" type="button" @click="selectProduct(item)">
                <strong>{{ item.name }}</strong><small>{{ item.price }}</small>
              </button>
            </div>
            <form class="wa-share-form" @submit.prevent="shareProduct">
              <label class="wa-field">Produto
                <input v-model="share.title" required minlength="2" maxlength="280" />
              </label>
              <label class="wa-field">Link HTTPS do produto
                <input v-model="share.productUrl" type="url" required maxlength="2048" placeholder="https://loja.exemplo/produto" />
              </label>
              <label class="wa-field">Descrição opcional
                <textarea v-model="share.description" maxlength="1500" rows="2" />
              </label>
              <label class="wa-field">Destinatário (DDI + DDD)
                <input v-model="share.number" pattern="[1-9][0-9]{7,14}" required placeholder="5575999999999" />
              </label>
              <button class="button primary" :disabled="busy || !canPublish">Revisar e compartilhar produto</button>
            </form>
          </div>
        </div>
        <div v-if="history.length" class="wa-history">
          <h3>Histórico das ações</h3>
          <div v-for="item in history.filter((entry) => entry.remoteInstance === current).slice(0, 30)" :key="item.id">
            <span>{{ item.kind === 'STATUS' ? 'Status' : 'Produto' }}</span>
            <span>{{ item.status }}</span>
            <small>{{ new Date(item.createdAt).toLocaleString('pt-BR') }}</small>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.wa-features-body { display:grid; gap:18px; padding:18px; }
.wa-field { display:grid; gap:7px; font-size:13px; color:#334155; min-width:0; }
.wa-field input,.wa-field select,.wa-field textarea { min-height:40px; width:100%; max-width:100%; border:1px solid #dbe4ef; border-radius:8px; padding:9px 10px; font:inherit; background:#fff; }
.wa-feature-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr)); gap:16px; min-width:0; }
.wa-feature-box { border:1px solid #dbe4ef; border-radius:12px; padding:18px; display:grid; align-content:start; gap:12px; min-width:0; }
.wa-feature-box h3,.wa-history h3 { font-size:15px; color:#14243a; margin:0; }
.wa-feature-box p { margin:0; font-size:13px; line-height:1.5; }
.wa-presentation { display:flex; flex-wrap:wrap; gap:14px; }
.wa-check { display:flex; align-items:center; gap:8px; font-size:13px; color:#44566c; }
.wa-check input { width:16px; height:16px; }
.wa-share-form { display:grid; gap:10px; }
.wa-catalog-list { display:grid; gap:7px; max-height:240px; overflow:auto; }
.wa-catalog-list button { display:flex; gap:10px; justify-content:space-between; text-align:left; padding:10px; border:1px solid #dbe4ef; border-radius:8px; background:#f8fafc; color:#21344d; }
.wa-catalog-list button:hover { border-color:#2563eb; }
.wa-catalog-list small { color:#64748b; flex:none; }
.wa-status-list { display:grid; gap:8px; max-height:240px; overflow:auto; font-size:12px; }
.wa-status-list > div { display:flex; flex-wrap:wrap; gap:10px; border-bottom:1px solid #e6ebf3; padding-bottom:5px; }
.wa-history { border-top:1px solid #e4eaf1; padding-top:15px; display:grid; gap:8px; font-size:13px; }
.wa-history > div { display:flex; gap:14px; flex-wrap:wrap; }
.wa-history small { color:#64748b; }
@media(max-width:600px) {.wa-features-body{padding:12px}.wa-feature-box{padding:13px}.wa-feature-grid{grid-template-columns:1fr}}
</style>
