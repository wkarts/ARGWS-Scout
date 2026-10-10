<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight, Check, Globe2, Layers, Search, Sparkles } from "@lucide/vue";
import { api } from "../api";

type Template = {
  id: string;
  title: string;
  provider: string;
  category: "marketplaces" | "general";
  description: string;
  sampleQuery: string;
  sampleUrl: string;
  sourceName: string;
  selector: string;
  engine: "HTTP" | "PLAYWRIGHT";
  requestIntervalMs: number;
  guidance: string;
  docsUrl?: string;
  templateVersion: number;
};

const props = defineProps<{ role: string }>();
const emit = defineEmits<{
  error: [message: string];
  notify: [message: string];
  created: [instance: { id: string; name: string; slug: string }];
}>();

const loading = ref(false);
const busy = ref(false);
const templates = ref<Template[]>([]);
const activeId = ref("");
const category = ref("all");
const searchTerm = ref("");
const name = ref("");
const query = ref("");
const sourceName = ref("");
const urlOverride = ref("");
const engine = ref<"HTTP" | "PLAYWRIGHT">("HTTP");
const selector = ref("");
const interval = ref(15000);
const captureScreenshot = ref(false);
const detailsOpen = ref(false);

const canCreate = computed(() => ["OWNER", "ADMIN", "OPERATOR"].includes(props.role));
const selected = computed(() => templates.value.find((template) => template.id === activeId.value) ?? null);
const filtered = computed(() => templates.value.filter((item) =>
  (category.value === "all" || item.category === category.value) &&
  `${item.title} ${item.description} ${item.provider}`.toLowerCase().includes(searchTerm.value.trim().toLowerCase())
));

async function loadTemplates() {
  loading.value = true;
  try {
    const response = await api<{ data: Template[] }>("/instance-templates");
    templates.value = response.data;
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : "Não foi possível carregar os modelos.");
  } finally {
    loading.value = false;
  }
}
function choose(item: Template) {
  activeId.value = item.id;
  name.value = "Pesquisa " + item.title;
  query.value = item.sampleQuery;
  sourceName.value = item.sourceName;
  urlOverride.value = "";
  engine.value = item.engine;
  selector.value = item.selector;
  interval.value = item.requestIntervalMs;
  captureScreenshot.value = false;
  detailsOpen.value = true;
}
async function create() {
  if (!selected.value || !canCreate.value || busy.value) return;
  busy.value = true;
  try {
    const response = await api<{ instance: { id: string; name: string; slug: string }; note: string }>(
      "/instance-templates/" + encodeURIComponent(selected.value.id) + "/create",
      {
        method: "POST",
        body: JSON.stringify({
          name: name.value.trim(),
          query: query.value.trim(),
          source: {
            name: sourceName.value.trim(),
            engine: engine.value,
            selector: selector.value,
            requestIntervalMs: Number(interval.value),
            captureScreenshot: captureScreenshot.value,
            ...(urlOverride.value.trim() ? { url: urlOverride.value.trim() } : {}),
          },
        }),
      },
    );
    detailsOpen.value = false;
    activeId.value = "";
    emit("notify", "Instância criada a partir do modelo. Revise a fonte e execute sua primeira coleta.");
    emit("created", response.instance);
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : "Falha ao criar a instância a partir do modelo.");
  } finally {
    busy.value = false;
  }
}
onMounted(() => void loadTemplates());
</script>

<template>
  <div class="template-catalog">
    <header class="template-intro">
      <div>
        <p class="template-eyebrow"><Sparkles :size="15" /> MODELOS PRONTOS PARA PERSONALIZAR</p>
        <h2>Comece com uma configuração pronta</h2>
        <p>
          Escolha um site, ajuste o que deseja pesquisar e crie uma instância com a fonte configurada.
          Nenhuma coleta começa sem sua confirmação.
        </p>
      </div>
      <div class="template-count"><Layers :size="18" /> {{ templates.length }} modelos</div>
    </header>

    <div class="template-toolbar">
      <div class="template-search">
        <Search :size="17" />
        <input v-model="searchTerm" type="search" aria-label="Buscar modelo"
          placeholder="Buscar por loja ou finalidade" />
      </div>
      <div class="template-filters" aria-label="Filtrar modelos">
        <button type="button" :class="{ active: category === 'all' }" @click="category = 'all'">Todos</button>
        <button type="button" :class="{ active: category === 'marketplaces' }" @click="category = 'marketplaces'">Marketplaces</button>
        <button type="button" :class="{ active: category === 'general' }" @click="category = 'general'">Sites gerais</button>
      </div>
    </div>

    <p v-if="loading" class="template-loading">Carregando catálogo…</p>
    <p v-else-if="!filtered.length" class="template-loading">Nenhum modelo corresponde à pesquisa.</p>
    <div v-else class="template-grid">
      <button v-for="item in filtered" :key="item.id" type="button"
        class="template-card" :class="{ selected: activeId === item.id }"
        :aria-pressed="activeId === item.id" @click="choose(item)">
        <span class="template-symbol"><Globe2 :size="23" /></span>
        <span class="template-content">
          <strong>{{ item.title }}</strong>
          <small>{{ item.description }}</small>
          <span class="template-engine">{{ item.engine === 'PLAYWRIGHT' ? 'Navegador' : 'HTTP' }} · editável</span>
        </span>
        <ArrowRight :size="17" class="template-arrow" />
      </button>
    </div>

    <section v-if="selected && detailsOpen" class="template-editor" aria-label="Personalizar modelo">
      <div class="template-editor-heading">
        <div>
          <span class="template-step"><Check :size="14" /> MODELO SELECIONADO</span>
          <h3>{{ selected.title }}</h3>
          <p>{{ selected.guidance }}</p>
          <a v-if="selected.docsUrl" :href="selected.docsUrl" target="_blank" rel="noopener noreferrer">
            Consultar documentação oficial
          </a>
        </div>
        <button type="button" class="template-close" aria-label="Fechar personalização" @click="detailsOpen = false">×</button>
      </div>

      <form class="template-form" @submit.prevent="create">
        <label>Nome da nova instância
          <input v-model="name" required minlength="2" maxlength="120" placeholder="Ex.: Pesquisa de preços" />
        </label>
        <label>O que deseja pesquisar?
          <input v-model="query" required minlength="2" maxlength="100" placeholder="Ex.: notebook" />
        </label>
        <label>Nome da fonte
          <input v-model="sourceName" required minlength="2" maxlength="120" />
        </label>
        <label>Mecanismo de coleta
          <select v-model="engine">
            <option value="HTTP">HTTP — conteúdo estático</option>
            <option value="PLAYWRIGHT">Navegador — conteúdo dinâmico</option>
          </select>
        </label>
        <label>Seletor CSS <small>Personalizável</small>
          <input v-model="selector" maxlength="500" placeholder="main ou .product-card" />
        </label>
        <label>Intervalo mínimo entre requisições (ms)
          <input v-model.number="interval" type="number" min="1000" max="300000" required />
        </label>
        <label class="template-full">Substituir URL de busca <small>Opcional: deixe em branco para usar a rota pronta do modelo.</small>
          <input v-model="urlOverride" type="url" maxlength="2048" :placeholder="selected.sampleUrl" />
        </label>
        <label v-if="engine === 'PLAYWRIGHT'" class="template-checkbox">
          <input v-model="captureScreenshot" type="checkbox" /> Capturar screenshot
        </label>
        <p class="template-full template-advice">
          Os modelos são pontos de partida, não integrações oficiais dos marketplaces.
          A coleta respeita robots.txt e as regras de acesso; alguns sites podem bloquear
          automações ou alterar o layout. Verifique a primeira execução antes de agendar ou publicar.
        </p>
        <div class="template-actions template-full">
          <button type="button" class="template-secondary" @click="detailsOpen = false">Cancelar</button>
          <button type="submit" class="template-primary"
            :disabled="busy || !canCreate || name.trim().length < 2 || query.trim().length < 2 || sourceName.trim().length < 2">
            {{ busy ? 'Criando…' : 'Criar minha instância' }} <ArrowRight :size="17" />
          </button>
        </div>
        <p v-if="!canCreate" class="template-full template-advice">Seu perfil permite consultar modelos, mas não criar instâncias.</p>
      </form>
    </section>
  </div>
</template>

<style scoped>
.template-catalog { display: grid; gap: 18px; min-width: 0; width: 100%; }
.template-intro { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.template-intro > div:first-child { min-width: 0; flex: 1 1 320px; }
.template-eyebrow { display:flex; align-items:center; gap:7px; font-size: 11px; letter-spacing:.08em; font-weight:750; color:#315ec7; }
.template-intro h2 { font-size: clamp(18px,2vw,24px); color:#142842; margin:8px 0; }
.template-intro p:not(.template-eyebrow) { font-size:13px; line-height:1.65; max-width:720px; color:#61748e; margin:0; }
.template-count { display:flex; gap:7px; align-items:center; color:#3763a3; background:#edf4ff; border-radius:9px; padding:9px 12px; font-size:12px; font-weight:700; }
.template-toolbar { display:flex; gap:12px; justify-content:space-between; align-items:center; flex-wrap:wrap; }
.template-search { display:flex; align-items:center; gap:8px; background:white; border:1px solid #dce5f0; padding:0 12px; border-radius:10px; flex:1 1 280px; min-width:0; height:44px; }
.template-search input { border:0; background:transparent; outline:none; min-width:0; flex:1; font-size:13px; color:#17304a; }
.template-filters { display:flex; flex-wrap:wrap; gap:5px; }
.template-filters button { padding:9px 11px; border:1px solid #dbe4ef; color:#54708e; border-radius:8px; background:white; font-weight:650; font-size:12px; }
.template-filters button.active { background:#eaf2ff; color:#1856c9; border-color:#bed4ff; }
.template-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,245px),1fr)); gap:13px; min-width:0; }
.template-card { text-align:left; display:flex; gap:12px; border:1px solid #dce6f1; background:#fff; border-radius:12px; padding:17px 14px; min-height:145px; min-width:0; max-width:100%; align-items:flex-start; transition: border-color .15s ease, box-shadow .15s ease; color:#1f3858; }
.template-card:hover,.template-card.selected { border-color:#85aaf5; box-shadow:0 6px 18px #1e4a9810; }
.template-card.selected { background:#f8fbff; }
.template-symbol { display:grid; place-items:center; width:42px; height:42px; border-radius:10px; flex:0 0 42px; background:#edf4ff; color:#2c66d2; }
.template-content { min-width:0; flex:1; display:grid; gap:9px; overflow-wrap:anywhere; }
.template-content strong { font-size:15px; color:#132c4a; }
.template-content small { font-size:12px; color:#62748a; line-height:1.5; }
.template-engine { font-size:11px; font-weight:700; color:#3167a9; }
.template-arrow { color:#5379b5; flex:0 0 17px; }
.template-loading { padding:30px; text-align:center; color:#6b7f9c; font-size:13px; }
.template-editor { padding:clamp(15px,2vw,26px); border:1px solid #c7d9f3; background:#fff; border-radius:14px; min-width:0; box-shadow:0 8px 30px #142a4510; }
.template-editor-heading { display:flex; justify-content:space-between; gap:15px; }
.template-editor-heading > div { min-width:0; }
.template-step { display:inline-flex; align-items:center; gap:6px; font-size:10px; font-weight:800; color:#2563eb; letter-spacing:.08em; }
.template-editor-heading h3 { font-size:21px; margin:8px 0; color:#153150; }
.template-editor-heading p { font-size:13px; color:#62748a; line-height:1.5; max-width:780px; }
.template-editor-heading a { color:#245dc9; font-size:12px; text-decoration:underline; }
.template-close { align-self:start; font-size:24px; color:#6b7f9c; border:0; background:transparent; width:35px; height:35px; }
.template-form { display:grid; gap:15px; grid-template-columns:repeat(2,minmax(0,1fr)); margin-top:18px; }
.template-form label:not(.template-checkbox) { min-width:0; display:grid; gap:8px; font-size:12px; font-weight:650; color:#41546d; }
.template-form label small { font-size:11px; color:#7c8ca1; }
.template-form input:not([type="checkbox"]), .template-form select { width:100%; min-width:0; min-height:42px; border-radius:9px; border:1px solid #dce5f0; padding:0 12px; background:#fff; color:#203752; font-size:13px; }
.template-full { grid-column:1/-1; }
.template-checkbox { display:flex; align-items:center; gap:9px; font-size:12px; font-weight:600; }
.template-checkbox input { width:17px; height:17px; }
.template-advice { font-size:12px; line-height:1.6; color:#657c92; background:#f6f9fd; border-radius:9px; padding:12px; margin:0; }
.template-actions { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
.template-actions button { border-radius:9px; min-height:42px; padding:0 16px; display:inline-flex; align-items:center; justify-content:center; gap:8px; font-weight:700; font-size:13px; }
.template-primary { background:#2563eb; color:#fff; border:1px solid #2563eb; }
.template-primary:disabled { opacity:.5; cursor:not-allowed; }
.template-secondary { background:white; color:#405777; border:1px solid #dce5f0; }
@media(max-width:700px) { .template-form { grid-template-columns:minmax(0,1fr); } .template-editor { padding:14px; } .template-toolbar { align-items:stretch; } .template-filters { width:100%; } }
@media(max-width:420px) { .template-grid { grid-template-columns:minmax(0,1fr); } .template-card { min-height:116px; } .template-actions button { flex:1 1 140px; } .template-count { align-self:start; } }
</style>
