import { heading, hint, openMenu } from "./menus.js";

interface Settings {
  baseUrl: string; apiKey: string; model: string; agentName: string;
  webSearch: { provider: string; apiKey: string | null };
}

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function wireAgentSettings(button: HTMLButtonElement): void {
  button.onclick = () => openMenu(button, panel => {
    panel.classList.add("agent-settings");
    panel.append(heading("Settings → Agent"), hint("Your collaborator answers new comments and suggests edits for review. Keys stay on this server, never in documents."));
    const status = document.createElement("p");
    status.className = "agent-settings-status";
    status.setAttribute("role", "status");
    status.textContent = "Loading…";
    panel.append(status);
    void request("config").then(async value => {
      if (!panel.isConnected) return;
      const config = value as Settings;
      const form = document.createElement("form");
      const fields = new Map<string, HTMLInputElement>();
      for (const [name, labelText, value, secret] of [
        ["baseUrl", "Base URL", config.baseUrl, false], ["apiKey", "API key", "", true],
        ["model", "Model id", config.model, false], ["agentName", "Agent display name", config.agentName, false],
        ["searchKey", "Web-search API key (optional)", "", true],
      ] as const) {
        const label = document.createElement("label"); label.textContent = labelText;
        const input = document.createElement("input"); input.name = name; input.type = secret ? "password" : "text";
        input.value = value; input.autocomplete = "off"; input.spellcheck = false;
        if (secret) input.placeholder = (name === "apiKey" ? config.apiKey : config.webSearch.apiKey) ? "Saved — leave blank to keep" : "Not configured";
        else input.required = true;
        label.append(input); form.append(label); fields.set(name, input);
      }
      const searchLabel = document.createElement("label"); searchLabel.textContent = "Web-search provider";
      const provider = document.createElement("select");
      for (const [value, title] of [["auto", "Auto (DuckDuckGo; Tavily with key)"], ["ddg", "DuckDuckGo (no key)"], ["tavily", "Tavily"], ["exa", "Exa"]]) {
        const option = document.createElement("option"); option.value = value!; option.textContent = title!; provider.append(option);
      }
      provider.value = config.webSearch.provider; searchLabel.append(provider); form.append(searchLabel);
      const clearLabel = document.createElement("label"); clearLabel.className = "agent-clear-keys";
      const clear = document.createElement("input"); clear.type = "checkbox";
      clearLabel.append(clear, "Clear both saved API keys"); form.append(clearLabel);
      const actions = document.createElement("div"); actions.className = "agent-settings-actions";
      const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save";
      const test = document.createElement("button"); test.type = "button"; test.textContent = "Save & test connection";
      actions.append(save, test); form.append(actions); panel.insertBefore(form, status);
      const submit = async (check: boolean) => {
        if (!form.reportValidity()) return;
        save.disabled = test.disabled = true; status.textContent = check ? "Saving and testing…" : "Saving…";
        try {
          const apiKey = fields.get("apiKey")!.value;
          const searchKey = fields.get("searchKey")!.value;
          const saved = await request("config", {
            baseUrl: fields.get("baseUrl")!.value, model: fields.get("model")!.value, agentName: fields.get("agentName")!.value,
            ...(clear.checked ? { apiKey: "" } : apiKey ? { apiKey } : {}),
            webSearch: { provider: provider.value, ...(clear.checked ? { apiKey: null } : searchKey ? { apiKey: searchKey } : {}) },
          }) as Settings;
          fields.get("apiKey")!.value = ""; fields.get("searchKey")!.value = ""; clear.checked = false;
          fields.get("apiKey")!.placeholder = saved.apiKey ? "Saved — leave blank to keep" : "Not configured";
          fields.get("searchKey")!.placeholder = saved.webSearch.apiKey ? "Saved — leave blank to keep" : "Not configured";
          if (check) await request("test", {});
          status.textContent = check ? "Connection successful." : "Saved. New comments will use these settings.";
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        finally { save.disabled = test.disabled = false; }
      };
      form.onsubmit = event => { event.preventDefault(); void submit(false); };
      test.onclick = () => void submit(true);
      const state = await request("status") as { configured: boolean; state: string; lastError: string | null };
      status.textContent = `${state.configured ? state.state : "Not configured"}${state.lastError ? ` — ${state.lastError}` : ""}`;
    }).catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
  });
}
