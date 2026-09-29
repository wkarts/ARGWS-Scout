<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RefreshCw, Server } from "@lucide/vue";
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
    uptimeSeconds: number;
    memoryBytes: number;
    node: string;
  };
};
const emit = defineEmits<{ error: [message: string] }>();
const report = ref<HealthReport | null>(null);
const busy = ref(false);
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
onMounted(() => void inspect());
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2>Diagnóstico operacional</h2>
        <p>Conectividade atual da API e pressão de execução do workspace.</p>
      </div>
      <button class="button subtle" :disabled="busy" @click="inspect">
        <RefreshCw :size="15" /> Verificar agora
      </button>
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
    <div v-if="!report" class="empty-state compact">
      <h3>
        {{ busy ? "Executando diagnóstico" : "Sem dados de diagnóstico" }}
      </h3>
      <p>As sondagens verificam PostgreSQL, Redis, RabbitMQ e Garage.</p>
    </div>
  </section>
</template>
