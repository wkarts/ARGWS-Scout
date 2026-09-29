<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  Database,
  ExternalLink,
  Eye,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Server,
  Webhook,
  X,
} from "@lucide/vue";
import { api, ApiError } from "./api";
import AccessConsole from "./views/AccessConsole.vue";
import OperationsConsole from "./views/OperationsConsole.vue";

type Me = {
  user: {
    id: string;
    email: string;
    name: string;
    profile: Record<string, unknown>;
    mfaEnabled: boolean;
  };
  role: string;
  tenant: { id: string; name: string; slug: string };
};
type Instance = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  enabled: boolean;
  _count?: { sources: number; jobs: number };
  createdAt: string;
};
type Source = {
  id: string;
  name: string;
  engine: "HTTP" | "PLAYWRIGHT";
  urlTemplate: string;
  allowedHosts: string[];
  enabled: boolean;
  respectRobots: boolean;
};
type Job = {
  id: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  source?: { name: string };
  instance?: { name: string };
  attempts?: number;
};
type Schedule = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  nextRunAt: string;
  enabled: boolean;
};
type WebhookRow = {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
};
type ApiTokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};
type DeliveryRow = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

const loading = ref(false);
const busy = ref(false);
const error = ref("");
const me = ref<Me | null>(null);
const activeSection = ref("overview");
const mobileMenu = ref(false);
const instances = ref<Instance[]>([]);
const sources = ref<Source[]>([]);
const jobs = ref<Job[]>([]);
const schedules = ref<Schedule[]>([]);
const webhooks = ref<WebhookRow[]>([]);
const apiTokens = ref<ApiTokenRow[]>([]);
const deliveries = ref<DeliveryRow[]>([]);
const selectedWebhookId = ref("");
const jobStatusFilter = ref("ALL");
const overviewStats = ref({
  instances: 0,
  sources: 0,
  jobs: 0,
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  successRate24h: null as number | null,
});
const selectedInstance = ref<Instance | null>(null);
const activeTab = ref("sources");
const searchTerm = ref("");
const toast = ref("");
const showInstanceForm = ref(false);
const showSourceForm = ref(false);
const showJobForm = ref(false);
const showScheduleForm = ref(false);
const showWebhookForm = ref(false);
const showProfile = ref(false);
const showMfaDialog = ref(false);
const mfaSetup = ref({ qrCodeDataUrl: "", manualKey: "", code: "" });
const showTokenDialog = ref(false);
const issuedToken = ref("");
const issuedWebhookSecret = ref("");
const loginForm = ref({ email: "", password: "", code: "" });
const mfaToken = ref("");
const mfaQr = ref("");
const mfaManualKey = ref("");
const loginStage = ref<"credentials" | "totp" | "setup">("credentials");
const instanceForm = ref({ name: "", description: "" });
const sourceForm = ref({
  name: "",
  engine: "HTTP" as "HTTP" | "PLAYWRIGHT",
  url: "",
  allowedHosts: "",
  selector: "",
  respectRobots: true,
  captureScreenshot: false,
  requestIntervalMs: 5000,
});
const scheduleForm = ref({
  name: "",
  sourceId: "",
  cron: "*/30 * * * *",
  timezone: "America/Bahia",
});
const webhookForm = ref({ name: "", url: "", events: ["job.completed"] });
const tokenForm = ref({
  name: "",
  scopes: ["jobs:create", "jobs:read", "results:read"],
});
const profileForm = ref({ name: "", phone: "", locale: "pt-BR" });

const title = computed(
  () =>
    ({
      overview: "Visão geral",
      instances: "Instâncias",
      jobs: "Execuções",
      schedules: "Agendamentos",
      webhooks: "Webhooks",
      access: "Acesso e auditoria",
      operations: "Saúde da plataforma",
      settings: "Configurações",
    })[activeSection.value] ?? "Visão geral",
);
const filteredInstances = computed(() =>
  instances.value.filter((item) =>
    `${item.name} ${item.slug}`
      .toLowerCase()
      .includes(searchTerm.value.toLowerCase()),
  ),
);
const filteredJobs = computed(() =>
  jobs.value.filter(
    (job) =>
      (jobStatusFilter.value === "ALL" ||
        job.status === jobStatusFilter.value) &&
      (!searchTerm.value ||
        `${job.instance?.name ?? ""} ${job.source?.name ?? ""}`
          .toLowerCase()
          .includes(searchTerm.value.toLowerCase())),
  ),
);
const stats = computed(() => ({
  ...overviewStats.value,
}));
const roleLabel = computed(
  () =>
    ({
      OWNER: "Proprietário",
      ADMIN: "Administrador",
      OPERATOR: "Operador",
      VIEWER: "Leitor",
    })[me.value?.role ?? ""] ??
    me.value?.role ??
    "Usuário",
);
function notify(message: string) {
  toast.value = message;
  window.setTimeout(() => {
    toast.value = "";
  }, 3200);
}
function initials(value: string) {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}
function prettyDate(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}
function statusLabel(value: string) {
  return (
    {
      QUEUED: "Na fila",
      RUNNING: "Executando",
      SUCCEEDED: "Concluído",
      FAILED: "Falhou",
      CANCELLED: "Cancelado",
    }[value] ?? value
  );
}

async function loadData() {
  if (!me.value) return;
  loading.value = true;
  error.value = "";
  try {
    const [overview, instanceResponse, jobResponse] = await Promise.all([
      api<{
        stats: typeof overviewStats.value;
        recentJobs: Job[];
      }>("/overview"),
      api<{ data: Instance[] }>("/instances"),
      api<{ data: Job[] }>("/jobs"),
    ]);
    instances.value = instanceResponse.data;
    jobs.value = jobResponse.data;
    overviewStats.value = overview.stats;
    if (selectedInstance.value)
      selectedInstance.value =
        instances.value.find(
          (item) => item.id === selectedInstance.value?.id,
        ) ?? null;
    if (!selectedInstance.value && instances.value.length)
      selectedInstance.value = instances.value[0]!;
    if (selectedInstance.value) await loadInstanceData();
    return overview;
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Não foi possível carregar os dados.";
  } finally {
    loading.value = false;
  }
}

async function loadInstanceData() {
  if (!selectedInstance.value) {
    sources.value = [];
    schedules.value = [];
    webhooks.value = [];
    apiTokens.value = [];
    return;
  }
  const id = selectedInstance.value.id;
  const [sourceResponse, scheduleResponse, webhookResponse] = await Promise.all(
    [
      api<{ data: Source[] }>(`/instances/${id}/sources`),
      api<{ data: Schedule[] }>(`/instances/${id}/schedules`),
      api<{ data: WebhookRow[] }>(`/instances/${id}/webhooks`),
    ],
  );
  sources.value = sourceResponse.data;
  schedules.value = scheduleResponse.data;
  webhooks.value = webhookResponse.data;
  apiTokens.value = ["OWNER", "ADMIN"].includes(me.value?.role ?? "")
    ? (await api<{ data: ApiTokenRow[] }>(`/instances/${id}/tokens`)).data
    : [];
}

async function toggleSource(source: Source) {
  try {
    await api(`/sources/${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    await loadInstanceData();
    notify(source.enabled ? "Fonte pausada." : "Fonte reativada.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao alterar a fonte.";
  }
}

async function toggleSchedule(schedule: Schedule) {
  try {
    await api(`/schedules/${schedule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !schedule.enabled }),
    });
    await loadInstanceData();
    notify(
      schedule.enabled ? "Agendamento pausado." : "Agendamento reativado.",
    );
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Falha ao alterar o agendamento.";
  }
}

async function revokeToken(token: ApiTokenRow) {
  if (!window.confirm(`Revogar o token ${token.name} (${token.prefix})?`))
    return;
  try {
    await api(`/tokens/${token.id}`, { method: "DELETE" });
    await loadInstanceData();
    notify("Token revogado.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao revogar o token.";
  }
}

async function loadWebhookDeliveries(webhookId: string) {
  selectedWebhookId.value = webhookId;
  try {
    const response = await api<{ data: DeliveryRow[] }>(
      `/webhooks/${webhookId}/deliveries`,
    );
    deliveries.value = response.data;
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Falha ao carregar as entregas.";
  }
}

async function cancelJob(job: Job) {
  try {
    await api(`/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
    await loadData();
    notify("Execução cancelada.");
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Falha ao cancelar execução.";
  }
}

async function checkSession() {
  try {
    const response = await api<Me>("/auth/me");
    me.value = response;
    profileForm.value.name = response.user.name;
    profileForm.value.phone = String(response.user.profile.phone ?? "");
    await loadData();
  } catch {
    me.value = null;
  }
}

async function login() {
  busy.value = true;
  error.value = "";
  try {
    const response = await api<{
      authenticated?: boolean;
      mfaRequired?: boolean;
      mfaSetupRequired?: boolean;
      preAuthToken?: string;
      user?: { id: string };
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(loginForm.value),
      noRefresh: true,
    });
    if (response.mfaRequired || response.mfaSetupRequired) {
      mfaToken.value = response.preAuthToken ?? "";
      loginStage.value = response.mfaSetupRequired ? "setup" : "totp";
      if (response.mfaSetupRequired) {
        const setup = await api<{ qrCodeDataUrl: string; manualKey: string }>(
          "/auth/mfa/setup",
          {
            method: "POST",
            body: "{}",
            authToken: mfaToken.value,
            noRefresh: true,
          },
        );
        mfaQr.value = setup.qrCodeDataUrl;
        mfaManualKey.value = setup.manualKey;
      }
    } else {
      await checkSession();
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Falha ao autenticar.";
  } finally {
    busy.value = false;
  }
}

async function verifyMfa() {
  busy.value = true;
  error.value = "";
  try {
    const endpoint =
      loginStage.value === "setup" ? "/auth/mfa/confirm" : "/auth/mfa/verify";
    await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ code: loginForm.value.code }),
      authToken: mfaToken.value,
      noRefresh: true,
    });
    loginForm.value.code = "";
    await checkSession();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : "Código inválido.";
  } finally {
    busy.value = false;
  }
}

async function logout() {
  await api("/auth/logout", { method: "POST", noRefresh: true }).catch(
    () => undefined,
  );
  me.value = null;
  activeSection.value = "overview";
  loginStage.value = "credentials";
}

async function createInstance() {
  busy.value = true;
  error.value = "";
  try {
    await api("/instances", {
      method: "POST",
      body: JSON.stringify(instanceForm.value),
    });
    showInstanceForm.value = false;
    instanceForm.value = { name: "", description: "" };
    await loadData();
    notify("Instância criada.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao criar instância.";
  } finally {
    busy.value = false;
  }
}

async function createSource() {
  if (!selectedInstance.value) return;
  busy.value = true;
  error.value = "";
  try {
    const host = new URL(sourceForm.value.url).hostname.toLowerCase();
    const allowedHosts = [
      ...new Set([
        ...sourceForm.value.allowedHosts
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
        host,
      ]),
    ];
    await api(`/instances/${selectedInstance.value.id}/sources`, {
      method: "POST",
      body: JSON.stringify({ ...sourceForm.value, allowedHosts }),
    });
    showSourceForm.value = false;
    sourceForm.value = {
      name: "",
      engine: "HTTP",
      url: "",
      allowedHosts: "",
      selector: "",
      respectRobots: true,
      captureScreenshot: false,
      requestIntervalMs: 5000,
    };
    await loadInstanceData();
    await loadData();
    notify("Fonte adicionada.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao adicionar fonte.";
  } finally {
    busy.value = false;
  }
}

async function createJob(sourceId: string) {
  if (!selectedInstance.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/instances/${selectedInstance.value.id}/jobs`, {
      method: "POST",
      body: JSON.stringify({ sourceId, input: {} }),
    });
    showJobForm.value = false;
    await loadData();
    notify("Execução enviada para a fila.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao criar execução.";
  } finally {
    busy.value = false;
  }
}

async function createSchedule() {
  if (!selectedInstance.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/instances/${selectedInstance.value.id}/schedules`, {
      method: "POST",
      body: JSON.stringify(scheduleForm.value),
    });
    showScheduleForm.value = false;
    await loadInstanceData();
    scheduleForm.value = {
      name: "",
      sourceId: "",
      cron: "*/30 * * * *",
      timezone: "America/Bahia",
    };
    notify("Agendamento criado.");
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Falha ao criar agendamento.";
  } finally {
    busy.value = false;
  }
}

async function createWebhook() {
  if (!selectedInstance.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await api<{ secret: string }>(
      `/instances/${selectedInstance.value.id}/webhooks`,
      { method: "POST", body: JSON.stringify(webhookForm.value) },
    );
    issuedWebhookSecret.value = response.secret;
    showWebhookForm.value = false;
    await loadInstanceData();
    notify("Webhook criado. Copie o segredo agora.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao criar webhook.";
  } finally {
    busy.value = false;
  }
}

async function createToken() {
  if (!selectedInstance.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await api<{ secret: string }>(
      `/instances/${selectedInstance.value.id}/tokens`,
      { method: "POST", body: JSON.stringify(tokenForm.value) },
    );
    issuedToken.value = response.secret;
    showTokenDialog.value = false;
    tokenForm.value = {
      name: "",
      scopes: ["jobs:create", "jobs:read", "results:read"],
    };
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao criar token.";
  } finally {
    busy.value = false;
  }
}

async function startMfaSetup() {
  busy.value = true;
  error.value = "";
  try {
    mfaSetup.value = await api<{
      qrCodeDataUrl: string;
      manualKey: string;
      code: string;
    }>("/profile/mfa/setup", { method: "POST", body: "{}" });
    showMfaDialog.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao configurar MFA.";
  } finally {
    busy.value = false;
  }
}

async function confirmMfaSetup() {
  busy.value = true;
  error.value = "";
  try {
    await api("/profile/mfa/confirm", {
      method: "POST",
      body: JSON.stringify({ code: mfaSetup.value.code }),
    });
    showMfaDialog.value = false;
    await checkSession();
    notify("Autenticação em duas etapas ativada.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Código inválido.";
  } finally {
    busy.value = false;
  }
}

async function saveProfile() {
  busy.value = true;
  error.value = "";
  try {
    await api("/profile", {
      method: "PATCH",
      body: JSON.stringify({
        name: profileForm.value.name,
        profile: {
          phone: profileForm.value.phone,
          locale: profileForm.value.locale,
        },
      }),
    });
    await checkSession();
    showProfile.value = false;
    notify("Perfil atualizado.");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Falha ao salvar perfil.";
  } finally {
    busy.value = false;
  }
}

function openInstance(item: Instance) {
  selectedInstance.value = item;
  activeSection.value = "instances";
  activeTab.value = "sources";
  void loadInstanceData();
}
function selectSection(section: string) {
  activeSection.value = section;
  mobileMenu.value = false;
}
function closeDialogs() {
  showInstanceForm.value = false;
  showSourceForm.value = false;
  showJobForm.value = false;
  showScheduleForm.value = false;
  showWebhookForm.value = false;
  showProfile.value = false;
  showMfaDialog.value = false;
  error.value = "";
}
async function copyValue(value: string) {
  await navigator.clipboard.writeText(value);
  notify("Copiado para a área de transferência.");
}
function openJob(job: Job) {
  selectedJob.value = job;
}
function screenshotArtifactId(job: Job | null) {
  const data = job?.result?.data;
  if (!data || typeof data !== "object") return "";
  const artifact = (data as Record<string, unknown>).screenshotArtifact;
  return artifact && typeof artifact === "object"
    ? String((artifact as Record<string, unknown>).id ?? "")
    : "";
}
function openScreenshot(job: Job) {
  const artifactId = screenshotArtifactId(job);
  if (artifactId)
    window.open(
      `/api/v1/jobs/${job.id}/artifacts/${artifactId}`,
      "_blank",
      "noopener,noreferrer",
    );
}
const selectedJob = ref<Job | null>(null);
onMounted(() => {
  void checkSession();
});
</script>

<template>
  <main v-if="!me" class="auth-page">
    <section class="auth-card">
      <img
        src="/brand/logo-horizontal.png"
        alt="ARGWS Scout"
        class="auth-logo"
      />
      <p class="eyebrow">WEB INTELLIGENCE & AUTOMATION</p>
      <h1>
        {{
          loginStage === "credentials"
            ? "Acesse sua plataforma"
            : loginStage === "setup"
              ? "Proteja sua conta"
              : "Confirme sua identidade"
        }}
      </h1>
      <p class="muted auth-copy" v-if="loginStage === 'credentials'">
        Entre para acompanhar fontes, execuções e resultados.
      </p>
      <template v-if="loginStage === 'credentials'">
        <label
          >E-mail<input
            v-model="loginForm.email"
            autocomplete="username"
            type="email"
            placeholder="voce@empresa.com"
        /></label>
        <label
          >Senha<input
            v-model="loginForm.password"
            autocomplete="current-password"
            type="password"
            placeholder="Sua senha"
            @keyup.enter="login"
        /></label>
        <button class="button primary full" :disabled="busy" @click="login">
          <LoaderCircle v-if="busy" class="spin" :size="17" /> Entrar
          <ArrowRight :size="16" />
        </button>
      </template>
      <template v-else-if="loginStage === 'setup'">
        <p class="muted">
          Escaneie o QR Code no Google Authenticator, Microsoft Authenticator ou
          app compatível. Esta etapa é exigida para a conta proprietária.
        </p>
        <img
          v-if="mfaQr"
          :src="mfaQr"
          alt="QR Code para configurar MFA"
          class="mfa-qr"
        />
        <code class="manual-key">{{ mfaManualKey }}</code>
        <label
          >Código de 6 dígitos<input
            v-model="loginForm.code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            @keyup.enter="verifyMfa"
        /></label>
        <button
          class="button primary full"
          :disabled="busy || loginForm.code.length !== 6"
          @click="verifyMfa"
        >
          Ativar MFA e entrar <ArrowRight :size="16" />
        </button>
      </template>
      <template v-else>
        <p class="muted">
          Informe o código de 6 dígitos do seu aplicativo autenticador.
        </p>
        <label
          >Código autenticador<input
            v-model="loginForm.code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            @keyup.enter="verifyMfa"
        /></label>
        <button
          class="button primary full"
          :disabled="busy || loginForm.code.length !== 6"
          @click="verifyMfa"
        >
          Verificar <ArrowRight :size="16" />
        </button>
      </template>
      <p v-if="error" class="inline-error">{{ error }}</p>
      <p class="auth-foot">
        <ShieldCheck :size="15" /> Sessão protegida com autenticação em duas
        etapas
      </p>
    </section>
    <div class="auth-orbit orbit-one"></div>
    <div class="auth-orbit orbit-two"></div>
  </main>

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ 'sidebar-open': mobileMenu }">
      <div class="brand-lockup">
        <img src="/brand/logo-horizontal.png" alt="ARGWS Scout" /><button
          class="icon-button close-mobile"
          aria-label="Fechar menu"
          @click="mobileMenu = false"
        >
          <X :size="18" />
        </button>
      </div>
      <div class="workspace-switcher">
        <span class="workspace-mark"><Command :size="17" /></span
        ><span
          ><small>ORGANIZAÇÃO</small><strong>{{ me.tenant.name }}</strong></span
        ><ChevronDown :size="15" class="switch-caret" />
      </div>
      <div class="nav-caption">PLATAFORMA</div>
      <nav class="side-nav">
        <button
          :class="{ active: activeSection === 'overview' }"
          @click="selectSection('overview')"
        >
          <LayoutDashboard :size="18" /> Visão geral
        </button>
        <button
          :class="{ active: activeSection === 'instances' }"
          @click="selectSection('instances')"
        >
          <Database :size="18" /> Instâncias
          <span class="nav-count">{{ instances.length }}</span>
        </button>
        <button
          :class="{ active: activeSection === 'jobs' }"
          @click="selectSection('jobs')"
        >
          <Activity :size="18" /> Execuções
        </button>
        <button
          :class="{ active: activeSection === 'schedules' }"
          @click="selectSection('schedules')"
        >
          <Clock3 :size="18" /> Agendamentos
        </button>
        <button
          :class="{ active: activeSection === 'webhooks' }"
          @click="selectSection('webhooks')"
        >
          <Webhook :size="18" /> Webhooks
        </button>
        <button
          v-if="['OWNER', 'ADMIN'].includes(me.role)"
          :class="{ active: activeSection === 'access' }"
          @click="selectSection('access')"
        >
          <UsersRound :size="18" /> Acesso e auditoria
        </button>
        <button
          v-if="['OWNER', 'ADMIN'].includes(me.role)"
          :class="{ active: activeSection === 'operations' }"
          @click="selectSection('operations')"
        >
          <Server :size="18" /> Saúde da plataforma
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="plan-mini">
          <div>
            <span class="status-dot"></span> Todos os sistemas
            <button class="icon-button" @click="loadData">
              <RefreshCw :size="14" />
            </button>
          </div>
          <span>Conectado à API Scout</span>
        </div>
        <button class="side-user" @click="showProfile = true">
          <span class="avatar">{{ initials(me.user.name) }}</span
          ><span class="user-meta"
            ><strong>{{ me.user.name }}</strong
            ><small>{{ roleLabel }}</small></span
          ><MoreHorizontal :size="18" />
        </button>
      </div>
    </aside>
    <div
      v-if="mobileMenu"
      class="mobile-backdrop"
      @click="mobileMenu = false"
    ></div>
    <section class="main-column">
      <header class="topbar">
        <button
          class="icon-button mobile-menu-button"
          aria-label="Abrir menu"
          @click="mobileMenu = true"
        >
          <Menu :size="20" />
        </button>
        <div class="breadcrumbs">
          <span>Workspace</span><span class="crumb-sep">/</span
          ><strong>{{ title }}</strong>
        </div>
        <div class="top-actions">
          <button class="icon-button" title="Ajuda">
            <CircleHelp :size="18" /></button
          ><button class="icon-button notice-button" title="Notificações">
            <Bell :size="18" /><i></i></button
          ><span class="top-divider"></span
          ><button class="top-profile" @click="showProfile = true">
            <span class="avatar small-avatar">{{ initials(me.user.name) }}</span
            ><span>{{ me.user.name }}</span
            ><ChevronDown :size="14" />
          </button>
        </div>
      </header>
      <main class="page-content">
        <div class="page-heading">
          <div>
            <p class="eyebrow">
              {{ me.tenant.name.toUpperCase() }} <span>·</span>
              {{
                new Intl.DateTimeFormat("pt-BR", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }).format(new Date())
              }}
            </p>
            <h1>{{ title }}</h1>
            <p class="muted">
              Explore fontes, automatize coletas e transforme páginas em dados
              utilizáveis.
            </p>
          </div>
          <div class="heading-actions">
            <button class="button subtle" @click="loadData">
              <RefreshCw :size="16" /> Atualizar</button
            ><button
              v-if="['overview', 'instances', 'jobs'].includes(activeSection)"
              class="button primary"
              @click="
                activeSection === 'instances'
                  ? (showInstanceForm = true)
                  : (showJobForm = true)
              "
            >
              <Plus :size="17" />
              {{
                activeSection === "instances"
                  ? "Nova instância"
                  : "Nova execução"
              }}
            </button>
          </div>
        </div>
        <div v-if="error" class="error-banner">
          <X :size="17" /> {{ error }}
          <button class="icon-button" @click="error = ''">
            <X :size="15" />
          </button>
        </div>

        <template v-if="activeSection === 'overview'">
          <div class="stat-grid">
            <article class="stat-card">
              <div class="stat-top">
                <span>Instâncias ativas</span
                ><span class="stat-icon blue"><Database :size="17" /></span>
              </div>
              <strong>{{ stats.instances }}</strong
              ><small
                ><span class="trend"><ArrowUpRight :size="13" /> Ativas</span>
                no seu workspace</small
              >
            </article>
            <article class="stat-card">
              <div class="stat-top">
                <span>Fontes conectadas</span
                ><span class="stat-icon cyan"><Globe2 :size="17" /></span>
              </div>
              <strong>{{ stats.sources }}</strong
              ><small>HTTP e navegação browser</small>
            </article>
            <article class="stat-card">
              <div class="stat-top">
                <span>Execuções recentes</span
                ><span class="stat-icon violet"><Activity :size="17" /></span>
              </div>
              <strong>{{ stats.jobs }}</strong
              ><small
                >{{ stats.queued }} na fila ·
                {{ stats.running }} executando</small
              >
            </article>
            <article class="stat-card">
              <div class="stat-top">
                <span>Concluídas</span
                ><span class="stat-icon green"><Check :size="17" /></span>
              </div>
              <strong>{{
                stats.successRate24h === null ? "—" : `${stats.successRate24h}%`
              }}</strong
              ><small>Taxa de sucesso nas últimas 24 horas</small>
            </article>
          </div>
          <section class="panel recent-panel">
            <div class="panel-header">
              <div>
                <h2>Execuções recentes</h2>
                <p>Atividade mais recente das suas fontes.</p>
              </div>
              <button class="text-button" @click="selectSection('jobs')">
                Ver todas <ArrowRight :size="15" />
              </button>
            </div>
            <div v-if="!jobs.length" class="empty-state">
              <span class="empty-icon"><Sparkles :size="22" /></span>
              <h3>Seu workspace está pronto para explorar</h3>
              <p>
                Crie uma instância e adicione sua primeira fonte para começar.
              </p>
              <button class="button primary" @click="showInstanceForm = true">
                <Plus :size="16" /> Criar instância
              </button>
            </div>
            <div v-else class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>FONTE / INSTÂNCIA</th>
                    <th>STATUS</th>
                    <th>INÍCIO</th>
                    <th>RESULTADO</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="job in jobs.slice(0, 7)"
                    :key="job.id"
                    @click="openJob(job)"
                  >
                    <td>
                      <div class="cell-primary">
                        {{ job.source?.name ?? "Coleta" }}
                      </div>
                      <div class="cell-secondary">
                        {{
                          job.instance?.name ??
                          selectedInstance?.name ??
                          "Instância"
                        }}
                      </div>
                    </td>
                    <td>
                      <span
                        class="status-pill"
                        :class="job.status.toLowerCase()"
                        ><i></i>{{ statusLabel(job.status) }}</span
                      >
                    </td>
                    <td>{{ prettyDate(job.createdAt) }}</td>
                    <td>
                      <button
                        class="icon-button result-open"
                        @click.stop="openJob(job)"
                      >
                        <ArrowRight :size="17" />
                      </button>
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section class="instance-strip">
            <div class="panel-header">
              <div>
                <h2>Suas instâncias</h2>
                <p>Ambientes independentes para organizar suas fontes.</p>
              </div>
              <button class="text-button" @click="selectSection('instances')">
                Ver instâncias <ArrowRight :size="15" />
              </button>
            </div>
            <div v-if="instances.length" class="instance-cards">
              <button
                v-for="item in instances.slice(0, 3)"
                :key="item.id"
                class="instance-card"
                @click="openInstance(item)"
              >
                <span class="instance-logo"><Database :size="18" /></span
                ><span class="instance-card-info"
                  ><strong>{{ item.name }}</strong
                  ><small
                    >{{ item._count?.sources ?? 0 }} fontes ·
                    {{ item._count?.jobs ?? 0 }} execuções</small
                  ></span
                ><ArrowRight :size="16" /></button
              ><button
                class="instance-card add-card"
                @click="showInstanceForm = true"
              >
                <span class="add-icon"><Plus :size="18" /></span
                ><strong>Adicionar instância</strong>
              </button>
            </div>
            <div v-else class="quiet-empty">
              Nenhuma instância criada ainda.
              <button class="text-button" @click="showInstanceForm = true">
                Criar agora <ArrowRight :size="14" />
              </button>
            </div>
          </section>
        </template>

        <template v-else-if="activeSection === 'instances'">
          <section v-if="!selectedInstance" class="panel instances-panel">
            <div class="panel-header">
              <div>
                <h2>Instâncias</h2>
                <p>Organize fontes por cliente, operação ou objetivo.</p>
              </div>
              <div class="search-box">
                <Search :size="16" /><input
                  v-model="searchTerm"
                  placeholder="Buscar instância"
                />
              </div>
            </div>
            <div v-if="filteredInstances.length" class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>NOME</th>
                    <th>FONTES</th>
                    <th>EXECUÇÕES</th>
                    <th>CRIADA EM</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in filteredInstances"
                    :key="item.id"
                    @click="openInstance(item)"
                  >
                    <td>
                      <div class="instance-cell">
                        <span class="instance-logo"
                          ><Database :size="17" /></span
                        ><span
                          ><strong>{{ item.name }}</strong
                          ><small>{{ item.slug }}</small></span
                        >
                      </div>
                    </td>
                    <td>{{ item._count?.sources ?? 0 }}</td>
                    <td>{{ item._count?.jobs ?? 0 }}</td>
                    <td>{{ prettyDate(item.createdAt) }}</td>
                    <td>
                      <button
                        class="icon-button"
                        @click.stop="openInstance(item)"
                      >
                        <ArrowRight :size="17" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="empty-state compact">
              <span class="empty-icon"><Database :size="20" /></span>
              <h3>Nenhuma instância encontrada</h3>
              <p>Crie uma instância para agrupar fontes e coletas.</p>
              <button class="button primary" @click="showInstanceForm = true">
                <Plus :size="16" /> Nova instância
              </button>
            </div>
          </section>
          <template v-else>
            <div class="instance-detail-head">
              <button class="back-link" @click="selectedInstance = null">
                <ArrowDownRight :size="16" /> Todas as instâncias
              </button>
              <div class="detail-title-row">
                <span class="instance-logo large"><Database :size="22" /></span>
                <div>
                  <h2>{{ selectedInstance.name }}</h2>
                  <p>
                    {{ selectedInstance.description || selectedInstance.slug }}
                  </p>
                </div>
                <div class="detail-spacer"></div>
                <button
                  v-if="['OWNER', 'ADMIN'].includes(me.role)"
                  class="button subtle"
                  @click="showTokenDialog = true"
                >
                  <KeyRound :size="16" /> Tokens de API</button
                ><button class="button primary" @click="showSourceForm = true">
                  <Plus :size="16" /> Adicionar fonte
                </button>
              </div>
            </div>
            <div class="tabs">
              <button
                :class="{ active: activeTab === 'sources' }"
                @click="activeTab = 'sources'"
              >
                Fontes <span>{{ sources.length }}</span></button
              ><button
                :class="{ active: activeTab === 'jobs' }"
                @click="activeTab = 'jobs'"
              >
                Execuções</button
              ><button
                :class="{ active: activeTab === 'schedules' }"
                @click="activeTab = 'schedules'"
              >
                Agendamentos</button
              ><button
                :class="{ active: activeTab === 'webhooks' }"
                @click="activeTab = 'webhooks'"
              >
                Webhooks</button
              ><button
                v-if="['OWNER', 'ADMIN'].includes(me.role)"
                :class="{ active: activeTab === 'tokens' }"
                @click="activeTab = 'tokens'"
              >
                Tokens <span>{{ apiTokens.length }}</span>
              </button>
            </div>
            <section v-if="activeTab === 'sources'" class="panel detail-panel">
              <div class="panel-header">
                <div>
                  <h2>Fontes configuradas</h2>
                  <p>Hosts são verificados novamente antes de cada acesso.</p>
                </div>
                <button
                  class="button primary small-button"
                  @click="showSourceForm = true"
                >
                  <Plus :size="15" /> Adicionar fonte
                </button>
              </div>
              <div v-if="sources.length" class="source-list">
                <article
                  v-for="source in sources"
                  :key="source.id"
                  class="source-row"
                >
                  <span
                    class="source-icon"
                    :class="source.engine.toLowerCase()"
                    >{{ source.engine === "HTTP" ? "H" : "B" }}</span
                  >
                  <div class="source-main">
                    <strong>{{ source.name }}</strong
                    ><small>{{ source.urlTemplate }}</small>
                  </div>
                  <span class="engine-badge">{{
                    source.engine === "HTTP" ? "HTTP" : "Browser"
                  }}</span
                  ><span class="source-host">{{ source.allowedHosts[0] }}</span
                  ><button
                    class="button outline small-button"
                    :disabled="!source.enabled || busy"
                    @click="createJob(source.id)"
                  >
                    <Sparkles :size="14" /> Executar</button
                  ><button
                    class="button outline small-button"
                    @click="toggleSource(source)"
                  >
                    {{ source.enabled ? "Pausar" : "Ativar" }}
                  </button>
                </article>
              </div>
              <div v-else class="empty-state compact">
                <span class="empty-icon"><Globe2 :size="20" /></span>
                <h3>Adicione a primeira fonte</h3>
                <p>
                  Use HTTP para páginas públicas simples ou Browser para páginas
                  renderizadas com JavaScript.
                </p>
                <button class="button primary" @click="showSourceForm = true">
                  <Plus :size="16" /> Configurar fonte
                </button>
              </div>
            </section>
            <section
              v-else-if="activeTab === 'jobs'"
              class="panel detail-panel"
            >
              <div class="panel-header">
                <div>
                  <h2>Execuções desta instância</h2>
                  <p>Resultados JSON e estado de cada coleta.</p>
                </div>
                <button
                  class="button primary small-button"
                  :disabled="!sources.length"
                  @click="showJobForm = true"
                >
                  <Plus :size="15" /> Nova execução
                </button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>FONTE</th>
                      <th>STATUS</th>
                      <th>TENTATIVAS</th>
                      <th>CRIADA EM</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="job in jobs.filter(
                        (item) =>
                          item.instance?.name === selectedInstance?.name,
                      )"
                      :key="job.id"
                      @click="openJob(job)"
                    >
                      <td>{{ job.source?.name ?? "—" }}</td>
                      <td>
                        <span
                          class="status-pill"
                          :class="job.status.toLowerCase()"
                          ><i></i>{{ statusLabel(job.status) }}</span
                        >
                      </td>
                      <td>{{ job.attempts ?? 0 }}</td>
                      <td>{{ prettyDate(job.createdAt) }}</td>
                      <td><ArrowRight :size="16" /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section
              v-else-if="activeTab === 'schedules'"
              class="panel detail-panel"
            >
              <div class="panel-header">
                <div>
                  <h2>Agendamentos</h2>
                  <p>Execuções recorrentes no fuso escolhido.</p>
                </div>
                <button
                  class="button primary small-button"
                  :disabled="!sources.length"
                  @click="showScheduleForm = true"
                >
                  <Plus :size="15" /> Criar agendamento
                </button>
              </div>
              <div v-if="schedules.length" class="source-list">
                <article
                  v-for="schedule in schedules"
                  :key="schedule.id"
                  class="source-row"
                >
                  <span class="source-icon schedule"
                    ><Clock3 :size="17"
                  /></span>
                  <div class="source-main">
                    <strong>{{ schedule.name }}</strong
                    ><small
                      >{{ schedule.cron }} · {{ schedule.timezone }}</small
                    >
                  </div>
                  <span class="source-host"
                    >Próxima: {{ prettyDate(schedule.nextRunAt) }}</span
                  ><span
                    class="status-pill"
                    :class="schedule.enabled ? 'succeeded' : 'cancelled'"
                    ><i></i>{{ schedule.enabled ? "Ativo" : "Pausado" }}</span
                  ><button
                    class="button outline small-button"
                    @click="toggleSchedule(schedule)"
                  >
                    {{ schedule.enabled ? "Pausar" : "Ativar" }}
                  </button>
                </article>
              </div>
              <div v-else class="empty-state compact">
                <span class="empty-icon"><Clock3 :size="20" /></span>
                <h3>Sem agendamentos</h3>
                <p>
                  Agende coletas recorrentes sem manter um browser dentro da
                  API.
                </p>
              </div>
            </section>
            <section
              v-else-if="activeTab === 'webhooks'"
              class="panel detail-panel"
            >
              <div class="panel-header">
                <div>
                  <h2>Webhooks de eventos</h2>
                  <p>Eventos assinados entregues com retries e histórico.</p>
                </div>
                <button
                  v-if="['OWNER', 'ADMIN'].includes(me.role)"
                  class="button primary small-button"
                  @click="showWebhookForm = true"
                >
                  <Plus :size="15" /> Novo webhook
                </button>
              </div>
              <div v-if="webhooks.length" class="source-list">
                <article
                  v-for="hook in webhooks"
                  :key="hook.id"
                  class="source-row"
                >
                  <span class="source-icon webhook"
                    ><Webhook :size="17"
                  /></span>
                  <div class="source-main">
                    <strong>{{ hook.name }}</strong
                    ><small>{{ hook.url }}</small>
                  </div>
                  <span class="engine-badge">{{ hook.events.join(", ") }}</span
                  ><span
                    class="status-pill"
                    :class="hook.enabled ? 'succeeded' : 'cancelled'"
                    ><i></i>{{ hook.enabled ? "Ativo" : "Pausado" }}</span
                  ><button
                    class="button outline small-button"
                    @click="loadWebhookDeliveries(hook.id)"
                  >
                    Entregas
                  </button>
                </article>
              </div>
              <div
                v-if="selectedWebhookId && deliveries.length"
                class="table-wrap delivery-history"
              >
                <h3>
                  Últimas entregas ·
                  {{
                    webhooks.find((hook) => hook.id === selectedWebhookId)?.name
                  }}
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>DATA</th>
                      <th>EVENTO</th>
                      <th>STATUS</th>
                      <th>TENTATIVAS</th>
                      <th>RESPOSTA</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="delivery in deliveries" :key="delivery.id">
                      <td>{{ prettyDate(delivery.createdAt) }}</td>
                      <td>{{ delivery.eventType }}</td>
                      <td>{{ delivery.status }}</td>
                      <td>{{ delivery.attempts }}</td>
                      <td>
                        {{
                          delivery.lastStatusCode ?? delivery.lastError ?? "—"
                        }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="!webhooks.length" class="empty-state compact">
                <span class="empty-icon"><Webhook :size="20" /></span>
                <h3>Nenhum webhook configurado</h3>
                <p>
                  Receba job.completed e job.failed com assinatura HMAC e chave
                  de idempotência.
                </p>
              </div>
            </section>
            <section v-else class="panel detail-panel">
              <div class="panel-header">
                <div>
                  <h2>Tokens desta instância</h2>
                  <p>
                    Escopos mínimos, expiração e último uso. O segredo completo
                    só aparece ao criar.
                  </p>
                </div>
                <button
                  class="button primary small-button"
                  @click="showTokenDialog = true"
                >
                  <Plus :size="15" /> Criar token
                </button>
              </div>
              <div v-if="apiTokens.length" class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>NOME / PREFIXO</th>
                      <th>ESCOPOS</th>
                      <th>ÚLTIMO USO</th>
                      <th>EXPIRA</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="token in apiTokens" :key="token.id">
                      <td>
                        <div class="cell-primary">{{ token.name }}</div>
                        <div class="cell-secondary">
                          <code>{{ token.prefix }}…</code>
                        </div>
                      </td>
                      <td>{{ token.scopes.join(", ") }}</td>
                      <td>{{ prettyDate(token.lastUsedAt) }}</td>
                      <td>{{ prettyDate(token.expiresAt) }}</td>
                      <td>
                        <button
                          class="button outline small-button"
                          @click="revokeToken(token)"
                        >
                          Revogar
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="empty-state compact">
                <h3>Nenhum token ativo</h3>
                <p>
                  Crie tokens separados para cada integração e limite os
                  escopos.
                </p>
              </div>
            </section>
          </template>
        </template>

        <template v-else-if="activeSection === 'jobs'"
          ><section class="panel">
            <div class="panel-header">
              <div>
                <h2>Todas as execuções</h2>
                <p>
                  Histórico recente, status e dados retornados pelos workers.
                </p>
              </div>
              <div class="search-box">
                <Search :size="16" /><input
                  v-model="searchTerm"
                  placeholder="Filtrar por instância"
                />
              </div>
              <select
                v-model="jobStatusFilter"
                class="job-status-filter"
                aria-label="Filtrar por estado"
              >
                <option value="ALL">Todos os estados</option>
                <option value="QUEUED">Na fila</option>
                <option value="RUNNING">Executando</option>
                <option value="SUCCEEDED">Concluído</option>
                <option value="FAILED">Falhou</option>
                <option value="CANCELLED">Cancelado</option>
              </select>
            </div>
            <div v-if="filteredJobs.length" class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>FONTE / INSTÂNCIA</th>
                    <th>STATUS</th>
                    <th>TENTATIVAS</th>
                    <th>INÍCIO</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="job in filteredJobs"
                    :key="job.id"
                    @click="openJob(job)"
                  >
                    <td>
                      <div class="cell-primary">
                        {{ job.source?.name ?? "Coleta" }}
                      </div>
                      <div class="cell-secondary">
                        {{ job.instance?.name ?? "—" }}
                      </div>
                    </td>
                    <td>
                      <span
                        class="status-pill"
                        :class="job.status.toLowerCase()"
                        ><i></i>{{ statusLabel(job.status) }}</span
                      >
                    </td>
                    <td>{{ job.attempts ?? 0 }}</td>
                    <td>{{ prettyDate(job.createdAt) }}</td>
                    <td>
                      <button
                        v-if="
                          job.status === 'QUEUED' &&
                          ['OWNER', 'ADMIN', 'OPERATOR'].includes(me.role)
                        "
                        class="button outline small-button"
                        @click.stop="cancelJob(job)"
                      >
                        Cancelar</button
                      ><ArrowRight v-else :size="16" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="empty-state compact">
              <span class="empty-icon"><Activity :size="20" /></span>
              <h3>As execuções aparecerão aqui</h3>
              <p>Adicione uma fonte e dispare uma coleta.</p>
            </div>
          </section></template
        >

        <template v-else-if="activeSection === 'schedules'"
          ><section class="panel">
            <div class="panel-header">
              <div>
                <h2>Agendamentos</h2>
                <p>Rotinas recorrentes por fonte e instância.</p>
              </div>
              <button
                class="button primary"
                :disabled="!sources.length"
                @click="showScheduleForm = true"
              >
                <Plus :size="16" /> Criar agendamento
              </button>
            </div>
            <div v-if="schedules.length" class="source-list">
              <article
                v-for="schedule in schedules"
                :key="schedule.id"
                class="source-row"
              >
                <span class="source-icon schedule"><Clock3 :size="17" /></span>
                <div class="source-main">
                  <strong>{{ schedule.name }}</strong
                  ><small>{{ schedule.cron }} · {{ schedule.timezone }}</small>
                </div>
                <span class="source-host">{{
                  prettyDate(schedule.nextRunAt)
                }}</span>
              </article>
            </div>
            <div v-else class="empty-state compact">
              <span class="empty-icon"><Clock3 :size="20" /></span>
              <h3>Sem rotinas programadas</h3>
              <p>Crie uma fonte para habilitar os agendamentos.</p>
            </div>
          </section></template
        >

        <template v-else-if="activeSection === 'webhooks'"
          ><section class="panel">
            <div class="panel-header">
              <div>
                <h2>Webhooks</h2>
                <p>Notificações assinadas para integrações externas.</p>
              </div>
              <button
                class="button primary"
                :disabled="!selectedInstance"
                @click="showWebhookForm = true"
              >
                <Plus :size="16" /> Criar webhook
              </button>
            </div>
            <div v-if="webhooks.length" class="source-list">
              <article
                v-for="hook in webhooks"
                :key="hook.id"
                class="source-row"
              >
                <span class="source-icon webhook"><Webhook :size="17" /></span>
                <div class="source-main">
                  <strong>{{ hook.name }}</strong
                  ><small>{{ hook.url }}</small>
                </div>
                <span class="engine-badge">{{ hook.events.join(", ") }}</span>
              </article>
            </div>
            <div v-else class="empty-state compact">
              <span class="empty-icon"><Webhook :size="20" /></span>
              <h3>Conecte um destino externo</h3>
              <p>Configure uma instância e assine eventos de job.</p>
            </div>
          </section></template
        >

        <template v-else-if="activeSection === 'access'"
          ><AccessConsole
            :role="me.role"
            @error="error = $event"
            @notify="notify"
        /></template>
        <template v-else-if="activeSection === 'operations'"
          ><OperationsConsole @error="error = $event"
        /></template>
        <template v-else
          ><section class="panel settings-panel">
            <div class="panel-header">
              <div>
                <h2>Configurações da conta</h2>
                <p>Perfil pessoal, autenticação e organização.</p>
              </div>
            </div>
            <div class="settings-row">
              <span class="settings-icon"><ShieldCheck :size="18" /></span>
              <div>
                <strong>Autenticação em duas etapas</strong
                ><small>{{
                  me.user.mfaEnabled
                    ? "Ativada para este perfil"
                    : "Ainda não configurada"
                }}</small>
              </div>
              <span
                class="status-pill"
                :class="me.user.mfaEnabled ? 'succeeded' : 'running'"
                ><i></i
                >{{ me.user.mfaEnabled ? "Protegida" : "Pendente" }}</span
              ><button
                v-if="!me.user.mfaEnabled"
                class="button outline small-button"
                @click="startMfaSetup"
              >
                Configurar 2FA
              </button>
            </div>
            <div class="settings-row">
              <span class="settings-icon"><Globe2 :size="18" /></span>
              <div>
                <strong>Organização</strong
                ><small>{{ me.tenant.name }} · {{ me.tenant.slug }}</small>
              </div>
            </div>
            <div class="settings-row">
              <span class="settings-icon"><KeyRound :size="18" /></span>
              <div>
                <strong>Tokens de API</strong
                ><small
                  >Tokens separados por instância e com escopos próprios.</small
                >
              </div>
              <button
                v-if="['OWNER', 'ADMIN'].includes(me.role)"
                class="button outline small-button"
                @click="showTokenDialog = true"
              >
                Gerenciar
              </button>
            </div>
            <div class="settings-row">
              <span class="settings-icon"><LogOut :size="18" /></span>
              <div>
                <strong>Sessão</strong
                ><small>Encerrar acesso neste navegador.</small>
              </div>
              <button class="button outline small-button" @click="logout">
                Sair
              </button>
            </div>
          </section></template
        >
      </main>
    </section>

    <div
      v-if="
        showInstanceForm ||
        showSourceForm ||
        showScheduleForm ||
        showWebhookForm ||
        showProfile ||
        showJobForm ||
        showTokenDialog ||
        showMfaDialog
      "
      class="modal-backdrop"
      @click.self="closeDialogs"
    >
      <section class="modal-card">
        <button
          class="icon-button modal-close"
          aria-label="Fechar"
          @click="closeDialogs"
        >
          <X :size="18" />
        </button>
        <template v-if="showInstanceForm"
          ><p class="eyebrow">WORKSPACE</p>
          <h2>Nova instância</h2>
          <p class="muted">Agrupe fontes por cliente, área ou objetivo.</p>
          <label
            >Nome<input
              v-model="instanceForm.name"
              placeholder="Ex.: Monitoramento de preços" /></label
          ><label
            >Descrição <span class="optional">Opcional</span
            ><textarea
              v-model="instanceForm.description"
              rows="3"
              placeholder="Para que será usada esta instância?"
            />
          </label>
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="busy || instanceForm.name.length < 2"
              @click="createInstance"
            >
              {{ busy ? "Criando…" : "Criar instância" }}
            </button>
          </div></template
        >
        <template v-else-if="showSourceForm"
          ><p class="eyebrow">{{ selectedInstance?.name }}</p>
          <h2>Adicionar fonte</h2>
          <p class="muted">
            Somente o host informado fica permitido para a coleta.
          </p>
          <label
            >Nome da fonte<input
              v-model="sourceForm.name"
              placeholder="Ex.: Busca de produtos" /></label
          ><label
            >URL pública<input
              v-model="sourceForm.url"
              type="url"
              placeholder="https://exemplo.com/busca?q={{input.query}}" /></label
          ><label
            >Hosts permitidos
            <span class="optional"
              >Separe por vírgula; o host da URL é incluído
              automaticamente</span
            ><input
              v-model="sourceForm.allowedHosts"
              placeholder="www.exemplo.com, static.exemplo.com" /></label
          ><label
            >Engine<select v-model="sourceForm.engine">
              <option value="HTTP">HTTP — páginas estáticas</option>
              <option value="PLAYWRIGHT">
                Playwright — conteúdo renderizado
              </option>
            </select></label
          ><label
            >Seletor CSS ou caminho JSON <span class="optional">Opcional</span
            ><input
              v-model="sourceForm.selector"
              placeholder=".product-card ou data.items" /></label
          ><label class="check-row"
            ><input v-model="sourceForm.respectRobots" type="checkbox" />
            Respeitar robots.txt</label
          ><label v-if="sourceForm.engine === 'PLAYWRIGHT'" class="check-row"
            ><input v-model="sourceForm.captureScreenshot" type="checkbox" />
            Capturar screenshot pequeno no resultado</label
          >
          <p class="hint-box">
            Credenciais, cookies e hosts privados não são aceitos nesta versão
            inicial.
          </p>
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="busy || sourceForm.name.length < 2 || !sourceForm.url"
              @click="createSource"
            >
              {{ busy ? "Salvando…" : "Salvar fonte" }}
            </button>
          </div></template
        >
        <template v-else-if="showJobForm"
          ><p class="eyebrow">{{ selectedInstance?.name }}</p>
          <h2>Nova execução</h2>
          <p class="muted">Escolha uma fonte para iniciar uma coleta agora.</p>
          <label
            >Fonte<select v-model="scheduleForm.sourceId">
              <option disabled value="">Selecione uma fonte</option>
              <option
                v-for="source in sources"
                :key="source.id"
                :value="source.id"
              >
                {{ source.name }} · {{ source.engine }}
              </option>
            </select></label
          >
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="busy || !scheduleForm.sourceId"
              @click="createJob(scheduleForm.sourceId)"
            >
              Executar agora <ArrowRight :size="15" />
            </button></div
        ></template>
        <template v-else-if="showScheduleForm"
          ><p class="eyebrow">AUTOMAÇÃO</p>
          <h2>Novo agendamento</h2>
          <p class="muted">A expressão cron é calculada no fuso selecionado.</p>
          <label
            >Nome<input
              v-model="scheduleForm.name"
              placeholder="Ex.: Conferir preço a cada meia hora" /></label
          ><label
            >Fonte<select v-model="scheduleForm.sourceId">
              <option disabled value="">Selecione uma fonte</option>
              <option
                v-for="source in sources"
                :key="source.id"
                :value="source.id"
              >
                {{ source.name }}
              </option>
            </select></label
          ><label
            >Expressão cron<input
              v-model="scheduleForm.cron"
              placeholder="*/30 * * * *" /></label
          ><label
            >Fuso horário<input
              v-model="scheduleForm.timezone"
              placeholder="America/Bahia"
          /></label>
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="
                busy || !scheduleForm.sourceId || scheduleForm.name.length < 2
              "
              @click="createSchedule"
            >
              Criar agendamento
            </button>
          </div></template
        >
        <template v-else-if="showWebhookForm"
          ><p class="eyebrow">EVENTOS EXTERNOS</p>
          <h2>Novo webhook</h2>
          <p class="muted">Receba callbacks HTTPS assinados com HMAC-SHA256.</p>
          <label
            >Nome<input
              v-model="webhookForm.name"
              placeholder="Ex.: Integração do ERP" /></label
          ><label
            >URL HTTPS<input
              v-model="webhookForm.url"
              type="url"
              placeholder="https://integracao.exemplo.com/events" /></label
          ><label
            >Eventos<select v-model="webhookForm.events" multiple>
              <option value="job.completed">job.completed</option>
              <option value="job.failed">job.failed</option>
            </select></label
          >
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="
                busy || !webhookForm.url || webhookForm.name.length < 2
              "
              @click="createWebhook"
            >
              Criar webhook
            </button>
          </div></template
        >
        <template v-else-if="showMfaDialog"
          ><p class="eyebrow">SEGURANÇA DA CONTA</p>
          <h2>Ativar autenticação em duas etapas</h2>
          <p class="muted">
            Escaneie o QR Code no seu autenticador e confirme um código.
          </p>
          <img
            v-if="mfaSetup.qrCodeDataUrl"
            :src="mfaSetup.qrCodeDataUrl"
            alt="QR Code de autenticação"
            class="mfa-qr"
          /><code class="manual-key">{{ mfaSetup.manualKey }}</code
          ><label
            >Código de 6 dígitos<input
              v-model="mfaSetup.code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              @keyup.enter="confirmMfaSetup"
          /></label>
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="busy || mfaSetup.code.length !== 6"
              @click="confirmMfaSetup"
            >
              Ativar 2FA
            </button>
          </div></template
        ><template v-else-if="showProfile"
          ><p class="eyebrow">CONTA</p>
          <h2>Seu perfil</h2>
          <p class="muted">Atualize suas informações pessoais.</p>
          <label>Nome<input v-model="profileForm.name" /></label
          ><label
            >Telefone<input
              v-model="profileForm.phone"
              placeholder="+55 75 9xxxx-xxxx" /></label
          ><label
            >Idioma<select v-model="profileForm.locale">
              <option value="pt-BR">Português (Brasil)</option>
              <option value="en">English</option>
            </select></label
          >
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Cancelar</button
            ><button
              class="button primary"
              :disabled="busy"
              @click="saveProfile"
            >
              Salvar perfil
            </button>
          </div></template
        >
        <template v-else-if="showTokenDialog"
          ><p class="eyebrow">ACESSO PROGRAMÁTICO</p>
          <h2>Tokens da instância</h2>
          <p class="muted">
            O segredo integral só aparece uma vez. Armazene em um cofre seguro.
          </p>
          <label
            >Nome do token<input
              v-model="tokenForm.name"
              placeholder="Ex.: Integração do ERP" /></label
          ><label
            >Escopos<select v-model="tokenForm.scopes" multiple>
              <option value="instances:read">instances:read</option>
              <option value="sources:read">sources:read</option>
              <option value="jobs:create">jobs:create</option>
              <option value="jobs:read">jobs:read</option>
              <option value="results:read">results:read</option>
            </select></label
          >
          <div class="modal-actions">
            <button class="button subtle" @click="closeDialogs">Fechar</button
            ><button
              class="button primary"
              :disabled="busy || !selectedInstance || tokenForm.name.length < 2"
              @click="createToken"
            >
              Gerar token
            </button>
          </div></template
        >
      </section>
    </div>

    <div
      v-if="selectedJob"
      class="modal-backdrop"
      @click.self="selectedJob = null"
    >
      <section class="modal-card result-modal">
        <button class="icon-button modal-close" @click="selectedJob = null">
          <X :size="18" />
        </button>
        <p class="eyebrow">RESULTADO DA EXECUÇÃO</p>
        <h2>{{ selectedJob.source?.name ?? "Job" }}</h2>
        <div class="result-meta">
          <span class="status-pill" :class="selectedJob.status.toLowerCase()"
            ><i></i>{{ statusLabel(selectedJob.status) }}</span
          ><span>{{ prettyDate(selectedJob.createdAt) }}</span>
        </div>
        <p v-if="selectedJob.errorMessage" class="inline-error">
          {{ selectedJob.errorMessage }}
        </p>
        <button
          v-if="screenshotArtifactId(selectedJob)"
          class="button outline small-button"
          @click="openScreenshot(selectedJob)"
        >
          <Eye :size="15" /> Ver screenshot
        </button>
        <pre class="json-result">{{
          JSON.stringify(
            selectedJob.result ?? {
              message:
                selectedJob.status === "QUEUED"
                  ? "O resultado aparecerá quando o worker concluir."
                  : "Sem conteúdo de resultado.",
            },
            null,
            2,
          )
        }}</pre>
      </section>
    </div>
    <div v-if="issuedToken || issuedWebhookSecret" class="modal-backdrop">
      <section class="modal-card">
        <p class="eyebrow">MOSTRADO UMA ÚNICA VEZ</p>
        <h2>{{ issuedToken ? "Token criado" : "Segredo do webhook" }}</h2>
        <p class="muted">
          Copie e guarde agora. Por segurança, o valor não será exibido
          novamente.
        </p>
        <div class="secret-box">{{ issuedToken || issuedWebhookSecret }}</div>
        <div class="modal-actions">
          <button
            class="button subtle"
            @click="
              issuedToken = '';
              issuedWebhookSecret = '';
            "
          >
            Fechar</button
          ><button
            class="button primary"
            @click="copyValue(issuedToken || issuedWebhookSecret)"
          >
            <Check :size="16" /> Copiar segredo
          </button>
        </div>
      </section>
    </div>
    <div v-if="toast" class="toast"><Check :size="16" /> {{ toast }}</div>
    <footer class="app-footer">
      <span>ARGWS Scout <i>·</i> {{ "0.2.0-alpha.2" }}</span
      ><span
        >Web Intelligence & Automation <i>·</i>
        <a href="/docs/" target="_blank"
          >Documentação <ExternalLink :size="12" /></a
      ></span>
    </footer>
  </div>
</template>
