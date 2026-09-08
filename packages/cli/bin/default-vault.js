import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export async function defaultVault(home = homedir()) {
  const root = join(home, "Documents", "Marginote");
  await mkdir(dirname(root), { recursive: true });
  try { await mkdir(root); }
  catch (error) {
    if (error.code === "EEXIST") return root;
    throw error;
  }
  await writeFile(join(root, "welcome.md"), `# Welcome to Marginote

Your Markdown lives here, in your own folder. Make yourself at home.

## Wake the margin agent

Open Settings in the top bar and add your API key, provider Base URL and model id.
Select text → leave a comment → watch the agent respond in the margin.
Reply on the thread to keep the conversation going. Suggested edits wait for your approval.

## Put a draft to the test

Click Grill me for a direct review: anchored findings, recommended fixes, and a short summary.

## Bring your own notes

Run \`marginote <dir>\` to work in any Markdown folder instead.
Core editing needs no API key. When you enable the agent, document context goes to your chosen provider.
`, { encoding: "utf8", flag: "wx" });
  return root;
}
