(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let adminPassword = null; // fica só em memória, nunca em localStorage

  // ---------------------------------------------------------------------
  // Fundo animado com ovinhos flutuando
  // ---------------------------------------------------------------------
  function initEggBackground() {
    const container = document.getElementById("eggBg");
    const emojis = ["🥚", "🍳"];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const span = document.createElement("span");
      span.textContent = emojis[i % emojis.length];
      span.style.left = `${Math.random() * 100}%`;
      span.style.fontSize = `${1.4 + Math.random() * 1.8}rem`;
      span.style.animationDuration = `${10 + Math.random() * 14}s`;
      span.style.animationDelay = `${Math.random() * 12}s`;
      container.appendChild(span);
    }
  }

  // ---------------------------------------------------------------------
  // Tela principal: último sorteio
  // ---------------------------------------------------------------------
  async function loadLatestDraw() {
    const winnersArea = document.getElementById("winnersArea");
    const drawMeta = document.getElementById("drawMeta");

    const { data, error } = await sb
      .from("ovos_draws")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      winnersArea.innerHTML = `<div class="error-state">Não foi possível carregar o sorteio agora. Tente recarregar a página.</div>`;
      return;
    }

    if (!data || data.length === 0) {
      drawMeta.textContent = "";
      winnersArea.innerHTML = `<div class="empty-state">Nenhum sorteio realizado ainda. O primeiro sorteio acontece na próxima sexta-feira 🎉</div>`;
      return;
    }

    const draw = data[0];
    const dateLabel = new Date(draw.draw_date + "T00:00:00").toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    drawMeta.textContent = `Sorteio de ${dateLabel} · Ciclo #${draw.cycle_number}`;

    winnersArea.innerHTML = `
      <div class="winners">
        <div class="winner-card">
          <span class="egg">🥚</span>
          <div class="name">${escapeHtml(draw.person1_name)}</div>
          <div class="role">Compra dos ovos</div>
        </div>
        <div class="winner-card">
          <span class="egg">🥚</span>
          <div class="name">${escapeHtml(draw.person2_name)}</div>
          <div class="role">Compra dos ovos</div>
        </div>
      </div>
    `;

    if (window.confetti) {
      window.confetti({ particleCount: 90, spread: 70, origin: { y: 0.5 } });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Modais
  // ---------------------------------------------------------------------
  function showOverlay(el) {
    el.hidden = false;
  }
  function hideOverlay(el) {
    el.hidden = true;
  }

  function setupOverlayDismiss(overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideOverlay(overlay);
    });
  }

  // ---------------------------------------------------------------------
  // Login de admin
  // ---------------------------------------------------------------------
  function initLogin() {
    const openAdminBtn = document.getElementById("openAdminBtn");
    const loginOverlay = document.getElementById("loginOverlay");
    const closeLoginBtn = document.getElementById("closeLoginBtn");
    const loginForm = document.getElementById("loginForm");
    const loginMsg = document.getElementById("loginMsg");
    const loginPassword = document.getElementById("loginPassword");
    const adminOverlay = document.getElementById("adminOverlay");

    setupOverlayDismiss(loginOverlay);

    openAdminBtn.addEventListener("click", () => {
      if (adminPassword) {
        showOverlay(adminOverlay);
        loadPeople();
        return;
      }
      loginMsg.textContent = "";
      loginMsg.className = "form-msg";
      loginPassword.value = "";
      showOverlay(loginOverlay);
      loginPassword.focus();
    });

    closeLoginBtn.addEventListener("click", () => hideOverlay(loginOverlay));

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginMsg.textContent = "Verificando…";
      loginMsg.className = "form-msg";

      const { data, error } = await sb.rpc("ovos_admin_login", {
        p_password: loginPassword.value,
      });

      if (error || data !== true) {
        loginMsg.textContent = "Senha incorreta.";
        loginMsg.className = "form-msg error";
        return;
      }

      adminPassword = loginPassword.value;
      hideOverlay(loginOverlay);
      showOverlay(adminOverlay);
      loadPeople();
    });
  }

  // ---------------------------------------------------------------------
  // CRUD de pessoas
  // ---------------------------------------------------------------------
  function initAdminPanel() {
    const adminOverlay = document.getElementById("adminOverlay");
    const closeAdminBtn = document.getElementById("closeAdminBtn");
    const personForm = document.getElementById("personForm");
    const personId = document.getElementById("personId");
    const personName = document.getElementById("personName");
    const personPhone = document.getElementById("personPhone");
    const personActive = document.getElementById("personActive");
    const personSubmitBtn = document.getElementById("personSubmitBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");
    const personMsg = document.getElementById("personMsg");

    setupOverlayDismiss(adminOverlay);
    closeAdminBtn.addEventListener("click", () => hideOverlay(adminOverlay));

    function resetForm() {
      personId.value = "";
      personName.value = "";
      personPhone.value = "";
      personActive.checked = true;
      personSubmitBtn.textContent = "Adicionar pessoa";
      cancelEditBtn.hidden = true;
      personMsg.textContent = "";
      personMsg.className = "form-msg";
    }

    cancelEditBtn.addEventListener("click", resetForm);

    personForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      personMsg.textContent = "Salvando…";
      personMsg.className = "form-msg";

      try {
        if (personId.value) {
          const { error } = await sb.rpc("ovos_admin_update_person", {
            p_password: adminPassword,
            p_id: personId.value,
            p_name: personName.value,
            p_phone: personPhone.value,
            p_active: personActive.checked,
          });
          if (error) throw error;
          personMsg.textContent = "Pessoa atualizada!";
        } else {
          const { error } = await sb.rpc("ovos_admin_add_person", {
            p_password: adminPassword,
            p_name: personName.value,
            p_phone: personPhone.value,
          });
          if (error) throw error;
          personMsg.textContent = "Pessoa cadastrada!";
        }
        personMsg.className = "form-msg ok";
        resetForm();
        loadPeople();
        loadLatestDraw();
      } catch (err) {
        personMsg.textContent = readableError(err);
        personMsg.className = "form-msg error";
      }
    });

    window.__startEditPerson = (row) => {
      personId.value = row.id;
      personName.value = row.name;
      personPhone.value = row.phone;
      personActive.checked = row.active;
      personSubmitBtn.textContent = "Salvar edição";
      cancelEditBtn.hidden = false;
      personMsg.textContent = "";
      personName.focus();
    };

    window.__deletePerson = async (row) => {
      if (!confirm(`Remover ${row.name} do rodízio?`)) return;
      const { error } = await sb.rpc("ovos_admin_delete_person", {
        p_password: adminPassword,
        p_id: row.id,
      });
      if (error) {
        alert(readableError(error));
        return;
      }
      loadPeople();
      loadLatestDraw();
    };
  }

  function readableError(err) {
    const msg = err?.message || "";
    if (msg.includes("senha invalida")) return "Senha incorreta.";
    return "Não foi possível concluir a ação. Tente novamente.";
  }

  async function loadPeople() {
    const tbody = document.getElementById("peopleTableBody");
    tbody.innerHTML = `<tr><td colspan="4">Carregando…</td></tr>`;

    const { data, error } = await sb.from("ovos_people").select("*").order("name");

    if (error) {
      tbody.innerHTML = `<tr><td colspan="4">Erro ao carregar pessoas.</td></tr>`;
      return;
    }

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4">Nenhuma pessoa cadastrada ainda.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    for (const row of data) {
      const tr = document.createElement("tr");

      const statusBadge = row.active
        ? `<span class="badge active">Ativo</span>`
        : `<span class="badge inactive">Inativo</span>`;
      const drawnBadge = row.drawn_in_cycle ? `<span class="badge drawn">Já comprou no ciclo</span>` : "";

      tr.innerHTML = `
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.phone)}</td>
        <td>${statusBadge}${drawnBadge}</td>
        <td class="row-actions">
          <button title="Editar" data-action="edit">✏️</button>
          <button title="Excluir" data-action="delete">🗑️</button>
        </td>
      `;

      tr.querySelector('[data-action="edit"]').addEventListener("click", () => window.__startEditPerson(row));
      tr.querySelector('[data-action="delete"]').addEventListener("click", () => window.__deletePerson(row));

      tbody.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    initEggBackground();
    initLogin();
    initAdminPanel();
    loadLatestDraw();
  });
})();
