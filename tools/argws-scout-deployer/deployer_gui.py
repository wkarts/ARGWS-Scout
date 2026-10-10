#!/usr/bin/env python3
"""Windows desktop interface backed by the Scout Deployer CLI."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

CLI_NAME = "argws-scout-deployer-win-x64.exe"
DEFAULT_PORTS = {
    ("docker", "develop"): 48080,
    ("docker", "production"): 48180,
    ("dockge", "develop"): 48081,
    ("dockge", "production"): 48181,
    ("cloudpanel", "develop"): 48082,
    ("cloudpanel", "production"): 48182,
    ("portainer", "develop"): 48083,
    ("portainer", "production"): 48183,
}


def application_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def backend_command() -> list[str] | None:
    folder = application_directory()
    if getattr(sys, "frozen", False):
        candidate = folder / CLI_NAME
        return [str(candidate)] if candidate.is_file() else None
    source = folder / "scout_deployer.py"
    return [sys.executable, str(source)] if source.is_file() else None


def run_backend(arguments: list[str], *, stdin_data: str | None = None) -> tuple[int, str]:
    command = backend_command()
    if not command:
        return 2, f"Não encontrei {CLI_NAME}. Extraia o ZIP completo do deployer na mesma pasta."
    result = subprocess.run(
        [*command, *arguments],
        capture_output=True,
        input=(stdin_data + "\n") if stdin_data is not None else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        check=False,
    )
    return result.returncode, (result.stdout or result.stderr).strip()


class DeployerWindow(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("ARGWS Scout Deployer")
        self.geometry("800x760")
        self.minsize(700, 640)
        self.configure(background="#f3f6fa")
        self.vars = {
            "target": tk.StringVar(value="docker"),
            "environment": tk.StringVar(value="production"),
            "public_url": tk.StringVar(),
            "manager_port": tk.StringVar(value="48180"),
            "browser_concurrency": tk.StringVar(value="1"),
            "recovery_smtp_host": tk.StringVar(),
            "recovery_smtp_port": tk.StringVar(value="587"),
            "recovery_smtp_secure": tk.StringVar(value="false"),
            "recovery_smtp_username": tk.StringVar(),
            "recovery_smtp_password": tk.StringVar(),
            "recovery_smtp_from_email": tk.StringVar(),
            "recovery_smtp_from_name": tk.StringVar(value="ARGWS Scout"),
            "tenant_name": tk.StringVar(value="Minha organização"),
            "tenant_slug": tk.StringVar(value="minha-organizacao"),
            "admin_name": tk.StringVar(value="Administrador"),
            "admin_email": tk.StringVar(),
            "output": tk.StringVar(value=str(Path.home() / "ARGWS-Scout" / "production")),
        }
        self._build_ui()

    def _build_ui(self) -> None:
        outer = ttk.Frame(self, padding=24)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="ARGWS Scout", font=("Segoe UI", 22, "bold")).pack(anchor="w")
        ttk.Label(
            outer,
            text="Prepare uma stack Compose com credenciais seguras para Docker, Dockge, CloudPanel ou Portainer.",
            wraplength=680,
        ).pack(anchor="w", pady=(4, 18))

        tabs = ttk.Notebook(outer)
        tabs.pack(fill="x")
        form = ttk.Frame(tabs, padding=16)
        smtp_form = ttk.Frame(tabs, padding=16)
        tabs.add(form, text="Instalação")
        tabs.add(smtp_form, text="Recuperação de senha (SMTP)")
        self._combo(form, "Plataforma", "target", ("docker", "dockge", "cloudpanel", "portainer"), 0)
        self._combo(form, "Ambiente", "environment", ("develop", "production"), 1)
        self._entry(form, "URL pública", "public_url", 2)
        self._entry(form, "Porta local do Manager (4xxxx)", "manager_port", 3)
        self._entry(form, "Nome da organização", "tenant_name", 4)
        self._entry(form, "Identificador da organização", "tenant_slug", 5)
        self._entry(form, "Nome do administrador", "admin_name", 6)
        self._entry(form, "E-mail do administrador", "admin_email", 7)
        self._entry(form, "Concorrência do navegador (1-16)", "browser_concurrency", 8)
        self._entry(form, "Pasta de saída", "output", 9, browse=True)
        ttk.Label(form, text="Exemplo: https://scout.seudominio.com.br", foreground="#667085").grid(
            row=10, column=1, sticky="w", pady=(0, 6)
        )

        self._entry(smtp_form, "Servidor SMTP", "recovery_smtp_host", 0)
        self._entry(smtp_form, "Porta SMTP", "recovery_smtp_port", 1)
        self._combo(smtp_form, "SSL/TLS direto", "recovery_smtp_secure", ("false", "true"), 2)
        self._entry(smtp_form, "Usuário SMTP", "recovery_smtp_username", 3)
        self._entry(smtp_form, "Senha SMTP", "recovery_smtp_password", 4, secret=True)
        self._entry(smtp_form, "E-mail remetente", "recovery_smtp_from_email", 5)
        self._entry(smtp_form, "Nome remetente", "recovery_smtp_from_name", 6)
        ttk.Label(
            smtp_form,
            text="SMTP opcional e exclusivo da recuperação de senha. Porta 587 normalmente usa STARTTLS (false); 465 usa TLS direto (true).",
            wraplength=600,
            foreground="#667085",
        ).grid(row=7, column=0, columnspan=3, sticky="w", pady=(8, 0))

        self.vars["target"].trace_add("write", self._update_port)
        self.vars["environment"].trace_add("write", self._update_port)

        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=14)
        self.generate_button = ttk.Button(actions, text="Gerar deploy", command=self.generate)
        self.generate_button.pack(side="left")
        ttk.Button(actions, text="Validar pasta", command=self.validate).pack(side="left", padx=8)

        result_box = ttk.LabelFrame(outer, text="Resultado", padding=10)
        result_box.pack(fill="both", expand=True)
        self.output_text = tk.Text(result_box, height=10, wrap="word", state="disabled", relief="flat")
        scroll = ttk.Scrollbar(result_box, orient="vertical", command=self.output_text.yview)
        self.output_text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.output_text.pack(side="left", fill="both", expand=True)

        ttk.Label(
            outer,
            text="O deployer cria somente compose.yaml e .env. Ele não inicia containers nem altera uma stack existente.",
            wraplength=680,
        ).pack(anchor="w", pady=(12, 0))

    def _entry(self, parent: ttk.Widget, label: str, key: str, row: int, *, browse: bool = False, secret: bool = False) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
        entry = ttk.Entry(parent, textvariable=self.vars[key], show="*" if secret else "")
        entry.grid(row=row, column=1, sticky="ew", pady=5)
        if browse:
            ttk.Button(parent, text="Procurar…", command=self.choose_directory).grid(row=row, column=2, padx=(8, 0))
        parent.columnconfigure(1, weight=1)

    def _combo(self, parent: ttk.Widget, label: str, key: str, values: tuple[str, ...], row: int) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
        ttk.Combobox(parent, textvariable=self.vars[key], values=values, state="readonly").grid(row=row, column=1, sticky="ew", pady=5)
        parent.columnconfigure(1, weight=1)

    def _update_port(self, *_: object) -> None:
        key = (self.vars["target"].get(), self.vars["environment"].get())
        if key in DEFAULT_PORTS:
            self.vars["manager_port"].set(str(DEFAULT_PORTS[key]))

    def choose_directory(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.vars["output"].get() or str(Path.home()))
        if chosen:
            self.vars["output"].set(chosen)

    def _set_output(self, message: str) -> None:
        self.output_text.configure(state="normal")
        self.output_text.delete("1.0", "end")
        self.output_text.insert("1.0", message)
        self.output_text.configure(state="disabled")

    def _run(self, args: list[str], *, stdin_data: str | None = None) -> None:
        self.generate_button.configure(state="disabled")
        self._set_output("Preparando os arquivos…")

        def worker() -> None:
            try:
                code, message = run_backend(args, stdin_data=stdin_data)
            except (OSError, subprocess.TimeoutExpired) as error:
                code, message = 1, str(error)
            self.after(0, lambda: self._finish(code, message))

        threading.Thread(target=worker, daemon=True).start()

    def _finish(self, code: int, message: str) -> None:
        self.generate_button.configure(state="normal")
        self._set_output(message or "A operação terminou sem detalhes adicionais.")
        if code == 0:
            self.title("ARGWS Scout Deployer — concluído")
        else:
            self.title("ARGWS Scout Deployer — verifique os dados")

    def generate(self) -> None:
        try:
            port = int(self.vars["manager_port"].get())
            smtp_port = int(self.vars["recovery_smtp_port"].get())
            concurrency = int(self.vars["browser_concurrency"].get())
        except ValueError:
            messagebox.showerror("Parâmetro inválido", "Informe portas e concorrência numéricas.")
            return
        if not 40000 <= port <= 49999:
            messagebox.showerror("Porta inválida", "A porta do Manager deve ser 4xxxx (40000 a 49999).")
            return
        if not 1 <= smtp_port <= 65535 or not 1 <= concurrency <= 16:
            messagebox.showerror("Parâmetro inválido", "Porta SMTP: 1-65535. Concorrência: 1-16.")
            return
        args = [
            "generate",
            "--target", self.vars["target"].get(),
            "--environment", self.vars["environment"].get(),
            "--output", self.vars["output"].get(),
            "--public-url", self.vars["public_url"].get().strip(),
            "--manager-port", str(port),
            "--browser-concurrency", str(concurrency),
            "--recovery-smtp-host", self.vars["recovery_smtp_host"].get().strip(),
            "--recovery-smtp-port", str(smtp_port),
            "--recovery-smtp-secure", self.vars["recovery_smtp_secure"].get(),
            "--recovery-smtp-username", self.vars["recovery_smtp_username"].get().strip(),
            "--recovery-smtp-from-email", self.vars["recovery_smtp_from_email"].get().strip(),
            "--recovery-smtp-from-name", self.vars["recovery_smtp_from_name"].get().strip(),
            "--tenant-name", self.vars["tenant_name"].get().strip(),
            "--tenant-slug", self.vars["tenant_slug"].get().strip(),
            "--admin-name", self.vars["admin_name"].get().strip(),
            "--admin-email", self.vars["admin_email"].get().strip(),
        ]
        password = self.vars["recovery_smtp_password"].get()
        if password:
            args.append("--recovery-smtp-password-stdin")
        self._run(args, stdin_data=password if password else None)

    def validate(self) -> None:
        self._run(["validate", "--directory", self.vars["output"].get()])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    window = DeployerWindow()
    if args.smoke_test:
        window.withdraw()
        window.update_idletasks()
        window.destroy()
        print("GUI inicializada com sucesso.")
        return 0
    window.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
