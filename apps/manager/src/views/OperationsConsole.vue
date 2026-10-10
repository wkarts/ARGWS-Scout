<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import managerPackage from "../../package.json";
import { RefreshCw, Server, Download } from "@lucide/vue";
import { api } from "../api";

type HealthReport = {
  status: string;
  checkedAt: string;
  dependencies: Record<string, string>;
  activity: {
    queuedJobs: number;
    activeJobs: number;
    failedJobsLast24Hours: number;
  };
  runtime: {
    version: string;
    buildSha?: string;
    channel?: string;
    uptimeSeconds: number;
    memoryBytes: number;
    node: string;
  };
};
const emit = defineEmits<{ error: [message: string] }>();
const report = ref<HealthReport | null>(null);
const managerVersion = managerPackage.version;
const managerBuildSha = import.meta.env.VITE_BUILD_SHA ?? "local";
const managerChannel = import.meta.env.VITE_BUILD_CHANNEL ?? "local";
const versionMismatch = computed(
  () =>
    report.value !== null &&
    (report.value.runtime.version !== managerVersion ||
      (managerBuildSha !== "local" &&
        report.value.runtime.buildSha !== undefined &&
        report.value.runtime.buildSha !== managerBuildSha)),
);
const busy = ref(false);
const exporting = ref(false);
const diagnostics = ref<{
  summary: {
    requestFailures: number;
    failedJobs: number;
    failedDeliveries: number;
  };
  requestFailures: {
    id: string;
    requestId: string;
    method: string;
    route: string;
    statusCode: number;
    createdAt: string;
  }[];
} | null>(null);
const dependencyLabels: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
  objectStorage: "Armazenamento S3 (Garage)",
};
function prettyDate(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}
async function inspect() {
  busy.value = true;
  try {
    report.value = await api<HealthReport>("/ops/health");
  } catch (error) {
    emit(
      "error",
      error instanceof Error ? error.message : "Falha no diagnóstico.",
    );
  } finally {
    busy.value = false;
  }
}
async function loadDiagnostics() {
  try {
    diagnostics.value = await api<typeof diagnostics.value>("/ops/diagnostics");
  } catch (cause) {
    emit(
      "error",
      cause instanceof Error
        ? cause.message
        : "Não foi possível recuperar eventos de diagnóstico.",
    );
  }
}
async function exportDiagnostics() {
  exporting.value = true;
  try {
    const snapshot = await api<Record<string, unknown>>("/ops/diagnostics");
    const payload = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const uri = URL.createObjectURL(payload);
    const anchor = document.createElement("a");
    anchor.href = uri;
    anchor.download =
      "diagnostico-scout-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(uri);
  } catch (cause) {
    emit(
      "error",
      cause instanceof Error
        ? cause.message
        : "Não foi possível exportar o diagnóstico.",
    );
  } finally {
    exporting.value = false;
  }
}
onMounted(() => {
  void inspect();
  void loadDiagnostics();
});
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2>Diagnóstico operacional</h2>
        <p>Conectividade da aplicação e atividade do espaço de trabalho.</p>
      </div>
      <button
        class="button outline"
        :disabled="exporting"
        @click="exportDiagnostics"
      >
        <Download :size="15" /> Exportar diagnóstico JSON
      </button>
      <button class="button subtle" :disabled="busy" @click="inspect">
        <RefreshCw :size="15" /> Verificar agora
      </button>
    </div>
    <div v-if="versionMismatch" class="version-mismatch" role="alert">
      <strong>Versões diferentes entre interface e API.</strong>
      <p>
        Interface {{ managerVersion }} ({{ managerChannel }} ·
        {{ managerBuildSha.slice(0, 8) }}) · API
        {{ report?.runtime.version }} ({{
          report?.runtime.channel ?? "local"
        }}
        · {{ report?.runtime.buildSha?.slice(0, 8) ?? "local" }}). Atualize as
        imagens da mesma versão no GHCR e recrie os serviços correspondentes
        para evitar incompatibilidade.
      </p>
    </div>
    <div v-if="report" class="operations-summary">
      <span
        class="status-pill"
        :class="report.status === 'healthy' ? 'succeeded' : 'running'"
        ><i></i
        >{{ report.status === "healthy" ? "Saudável" : "Degradada" }}</span
      >
      <span>Verificado {{ prettyDate(report.checkedAt) }}</span>
    </div>
    <div v-if="report" class="dependency-grid">
      <article
        v-for="(state, name) in report.dependencies"
        :key="name"
        class="dependency-card"
      >
        <span class="dependency-mark"><Server :size="17" /></span
        ><strong>{{ dependencyLabels[name] ?? name }}</strong>
        <span
          class="status-pill"
          :class="state === 'ok' ? 'succeeded' : 'failed'"
          ><i></i>{{ state === "ok" ? "Conectado" : "Indisponível" }}</span
        >
      </article>
    </div>
    <div v-if="report" class="operations-grid">
      <article>
        <small>NA FILA</small><strong>{{ report.activity.queuedJobs }}</strong>
      </article>
      <article>
        <small>EM EXECUÇÃO</small
        ><strong>{{ report.activity.activeJobs }}</strong>
      </article>
      <article>
        <small>FALHAS · 24H</small
        ><strong>{{ report.activity.failedJobsLast24Hours }}</strong>
      </article>
      <article>
        <small>VERSÃO API</small><strong>{{ report.runtime.version }}</strong>
      </article>
      <article>
        <small>VERSÃO DA INTERFACE</small><strong>{{ managerVersion }}</strong>
      </article>
      <article>
        <small>UPTIME API</small
        ><strong
          >{{ Math.floor(report.runtime.uptimeSeconds / 3600) }}h
          {{ Math.floor((report.runtime.uptimeSeconds % 3600) / 60) }}m</strong
        >
      </article>
      <article>
        <small>MEMÓRIA API</small
        ><strong
          >{{
            (report.runtime.memoryBytes / 1024 / 1024).toFixed(0)
          }}
          MB</strong
        >
      </article>
    </div>
    <section v-if="diagnostics" class="diagnostics-list">
      <div class="panel-header">
        <div>
          <h2>Eventos técnicos recentes</h2>
          <p>
            Últimos sete dias. Erros HTTP persistidos, falhas de jobs, entregas
            e auditoria, sem dados sensíveis.
          </p>
        </div>
        <button class="button subtle" @click="loadDiagnostics">
          <RefreshCw :size="15" /> Atualizar
        </button>
      </div>
      <div class="diagnostic-counters">
        <span
          >Requisições com falha:
          {{ diagnostics.summary.requestFailures }}</span
        ><span>Jobs com falha: {{ diagnostics.summary.failedJobs }}</span
        ><span
          >Entregas com falha: {{ diagnostics.summary.failedDeliveries }}</span
        >
      </div>
      <div v-if="diagnostics.requestFailures.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>DATA</th>
              <th>REQUISIÇÃO</th>
              <th>ROTA</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in diagnostics.requestFailures" :key="event.id">
              <td>{{ prettyDate(event.createdAt) }}</td>
              <td>
                <code>{{ event.requestId }}</code>
              </td>
              <td>
                <code>{{ event.method }} {{ event.route }}</code>
              </td>
              <td>{{ event.statusCode }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">
        Nenhum erro HTTP recente associado a este espaço.
      </p>
    </section>
    <div v-if="!report" class="empty-state compact">
      <h3>
        {{ busy ? "Executando diagnóstico" : "Sem dados de diagnóstico" }}
      </h3>
      <p>As sondagens verificam PostgreSQL, Redis, RabbitMQ e Garage.</p>
    </div>
  </section>
</template>
