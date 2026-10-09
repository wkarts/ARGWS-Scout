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
    ("docker", "develop"): 8080,
    ("docker", "production"): 8180,
    ("dockge", "develop"): 8081,
    ("dockge", "production"): 8181,
    ("cloudpanel", "develop"): 8082,
    ("cloudpanel", "production"): 8182,
    ("portainer", "develop"): 8083,
    ("portainer", "production"): 8183,
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


def run_backend(arguments: list[str]) -> tuple[int, str]:
    command = backend_command()
    if not command:
        return 2, f"Não encontrei {CLI_NAME}. Extraia o ZIP completo do deployer na mesma pasta."
    result = subprocess.run(
        [*command, *arguments],
        capture_output=True,
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
        self.geometry("760x700")
        self.minsize(680, 620)
        self.configure(background="#f3f6fa")
        self.vars = {
            "target": tk.StringVar(value="docker"),
            "environment": tk.StringVar(value="production"),
            "public_url": tk.StringVar(),
            "manager_port": tk.StringVar(value="8180"),
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

        form = ttk.LabelFrame(outer, text="Instalação", padding=16)
        form.pack(fill="x")
        self._combo(form, "Plataforma", "target", ("docker", "dockge", "cloudpanel", "portainer"), 0)
        self._combo(form, "Ambiente", "environment", ("develop", "production"), 1)
        self._entry(form, "URL pública", "public_url", 2)
        self._entry(form, "Porta local do Manager", "manager_port", 3)
        self._entry(form, "Nome da organização", "tenant_name", 4)
        self._entry(form, "Identificador da organização", "tenant_slug", 5)
        self._entry(form, "Nome do administrador", "admin_name", 6)
        self._entry(form, "E-mail do administrador", "admin_email", 7)
        self._entry(form, "Pasta de saída", "output", 8, browse=True)
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

        ttk.Label(form, text="Exemplo: https://scout.seudominio.com.br", foreground="#667085").grid(row=9, column=1, sticky="w", pady=(0, 6))
        ttk.Label(
            outer,
            text="O deployer cria somente compose.yaml e .env. Ele não inicia containers nem altera uma stack existente.",
            wraplength=680,
        ).pack(anchor="w", pady=(12, 0))

    def _entry(self, parent: ttk.Widget, label: str, key: str, row: int, *, browse: bool = False) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
        entry = ttk.Entry(parent, textvariable=self.vars[key])
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

    def _run(self, args: list[str]) -> None:
        self.generate_button.configure(state="disabled")
        self._set_output("Preparando os arquivos…")

        def worker() -> None:
            try:
                code, message = run_backend(args)
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
        except ValueError:
            messagebox.showerror("Porta inválida", "Informe uma porta numérica entre 1 e 65535.")
            return
        args = [
            "generate",
            "--target", self.vars["target"].get(),
            "--environment", self.vars["environment"].get(),
            "--output", self.vars["output"].get(),
            "--public-url", self.vars["public_url"].get().strip(),
            "--manager-port", str(port),
            "--tenant-name", self.vars["tenant_name"].get().strip(),
            "--tenant-slug", self.vars["tenant_slug"].get().strip(),
            "--admin-name", self.vars["admin_name"].get().strip(),
            "--admin-email", self.vars["admin_email"].get().strip(),
        ]
        self._run(args)

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
