<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Plus, RefreshCw, ScrollText, UsersRound } from "@lucide/vue";
import { api } from "../api";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  disabledAt: string | null;
  createdAt: string;
};
type InvitationRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
};
type AuditRow = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};
const props = defineProps<{ role: string }>();
const emit = defineEmits<{
  error: [message: string];
  notify: [message: string];
}>();
const users = ref<UserRow[]>([]);
const auditRows = ref<AuditRow[]>([]);
const invitations = ref<InvitationRow[]>([]);
const activeTab = ref<"users" | "audit">("users");
const busy = ref(false);
const userForm = ref({ name: "", email: "", role: "OPERATOR" });
function prettyDate(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}
function roleLabel(role: string) {
  return (
    {
      OWNER: "Proprietário",
      ADMIN: "Administrador",
      OPERATOR: "Operador",
      VIEWER: "Leitor",
    }[role] ?? role
  );
}
async function load() {
  if (!["OWNER", "ADMIN"].includes(props.role)) return;
  busy.value = true;
  try {
    const [userResponse, auditResponse, invitationResponse] = await Promise.all(
      [
        api<{ data: UserRow[] }>("/users"),
        api<{ data: AuditRow[] }>("/audit"),
        api<{ data: InvitationRow[] }>("/users/invitations"),
      ],
    );
    users.value = userResponse.data;
    auditRows.value = auditResponse.data;
    invitations.value = invitationResponse.data;
  } catch (error) {
    emit(
      "error",
      error instanceof Error ? error.message : "Falha ao consultar acessos.",
    );
  } finally {
    busy.value = false;
  }
}
async function createUser() {
  busy.value = true;
  try {
    await api("/users/invitations", {
      method: "POST",
      body: JSON.stringify(userForm.value),
    });
    userForm.value = { name: "", email: "", role: "OPERATOR" };
    await load();
    emit(
      "notify",
      "Convite enviado por e-mail. A pessoa definirá sua própria senha.",
    );
  } catch (error) {
    emit(
      "error",
      error instanceof Error ? error.message : "Falha ao criar usuário.",
    );
  } finally {
    busy.value = false;
  }
}
async function revokeInvitation(invitation: InvitationRow) {
  if (
    !window.confirm("Cancelar o convite enviado para " + invitation.email + "?")
  )
    return;
  busy.value = true;
  try {
    await api("/users/invitations/" + invitation.id + "/revoke", {
      method: "POST",
      body: "{}",
    });
    await load();
    emit("notify", "Convite cancelado.");
  } catch (cause) {
    emit(
      "error",
      cause instanceof Error
        ? cause.message
        : "Não foi possível cancelar o convite.",
    );
  } finally {
    busy.value = false;
  }
}
async function resetMfa(user: UserRow) {
  if (!window.confirm("Revogar sessões e redefinir MFA de " + user.email + "?"))
    return;
  try {
    await api("/users/" + user.id + "/mfa/reset", {
      method: "POST",
      body: "{}",
    });
    await load();
    emit("notify", "MFA redefinido e sessões revogadas.");
  } catch (error) {
    emit(
      "error",
      error instanceof Error ? error.message : "Falha ao redefinir MFA.",
    );
  }
}
onMounted(() => void load());
</script>

<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2>Governança da organização</h2>
        <p>
          Convites por e-mail, permissões e histórico de ações. Cada pessoa
          escolhe sua própria senha.
        </p>
      </div>
      <button class="button subtle" :disabled="busy" @click="load">
        <RefreshCw :size="15" /> Atualizar
      </button>
    </div>
    <div class="tabs">
      <button
        :class="{ active: activeTab === 'users' }"
        @click="activeTab = 'users'"
      >
        <UsersRound :size="15" /> Usuários <span>{{ users.length }}</span>
      </button>
      <button
        :class="{ active: activeTab === 'audit' }"
        @click="activeTab = 'audit'"
      >
        <ScrollText :size="15" /> Auditoria
      </button>
    </div>
    <template v-if="activeTab === 'users'">
      <form class="access-create" @submit.prevent="createUser">
        <label
          >Nome<input
            v-model="userForm.name"
            required
            minlength="2"
            maxlength="120"
            placeholder="Nome completo"
        /></label>
        <label
          >E-mail<input
            v-model="userForm.email"
            required
            type="email"
            placeholder="pessoa@empresa.com"
        /></label>
        <label
          >Papel<select v-model="userForm.role">
            <option value="ADMIN">Administrador</option>
            <option value="OPERATOR">Operador</option>
            <option value="VIEWER">Leitor</option>
          </select></label
        >
        <button class="button primary" :disabled="busy">
          <Plus :size="15" /> Enviar convite
        </button>
      </form>
      <div v-if="invitations.length" class="invitation-panel">
        <h3>Convites aguardando ativação</h3>
        <p>Convites duram 48 horas. A senha é definida pela própria pessoa.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>NOME</th>
                <th>E-MAIL</th>
                <th>ACESSO</th>
                <th>VALIDADE</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="invitation in invitations" :key="invitation.id">
                <td>{{ invitation.name }}</td>
                <td>{{ invitation.email }}</td>
                <td>{{ roleLabel(invitation.role) }}</td>
                <td>{{ prettyDate(invitation.expiresAt) }}</td>
                <td>
                  <button
                    class="button outline small-button"
                    @click="revokeInvitation(invitation)"
                    :disabled="busy"
                  >
                    Cancelar convite
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="users.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>USUÁRIO</th>
              <th>PAPEL</th>
              <th>MFA</th>
              <th>CRIADO EM</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td>
                <div class="cell-primary">{{ user.name }}</div>
                <div class="cell-secondary">{{ user.email }}</div>
              </td>
              <td>{{ roleLabel(user.role) }}</td>
              <td>
                <span
                  class="status-pill"
                  :class="user.mfaEnabled ? 'succeeded' : 'running'"
                  ><i></i>{{ user.mfaEnabled ? "Ativo" : "Pendente" }}</span
                >
              </td>
              <td>{{ prettyDate(user.createdAt) }}</td>
              <td>
                <button
                  v-if="props.role === 'OWNER' && user.mfaEnabled"
                  class="button outline small-button"
                  @click="resetMfa(user)"
                >
                  Redefinir MFA
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-state compact">
        <h3>Nenhuma pessoa ativa adicional</h3>
        <p>
          Envie um convite acima. A conta ficará disponível após a ativação por
          e-mail.
        </p>
      </div>
    </template>
    <div v-else-if="auditRows.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>DATA</th>
            <th>AÇÃO</th>
            <th>RECURSO</th>
            <th>IDENTIFICADOR</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in auditRows" :key="entry.id">
            <td>{{ prettyDate(entry.createdAt) }}</td>
            <td>
              <code>{{ entry.action }}</code>
            </td>
            <td>{{ entry.resourceType }}</td>
            <td>
              <code>{{ entry.resourceId ?? "—" }}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-state compact">
      <h3>Sem eventos de auditoria</h3>
      <p>
        Criações, alterações administrativas e ações críticas serão registradas
        aqui.
      </p>
    </div>
  </section>
</template>
