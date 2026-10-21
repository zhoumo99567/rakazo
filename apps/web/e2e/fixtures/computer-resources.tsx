import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComputerResourceSettings } from "../../src/components/ComputerResourceSettings";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

// This isolated UI fixture never calls a running computer or changes deployment settings.
let limits = { cpus: 2, memoryMiB: 2048 };
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname.endsWith("/computer/resources"))
    return Response.json({ json: limits });
  if (new URL(request.url).pathname.endsWith("/computer/setResources")) {
    const body = await request.json();
    limits = body.json.limits;
    return Response.json({ json: limits });
  }
  return originalFetch(input, init);
};
await bootstrapI18n();
function Fixture() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState("");
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <button type="button" onClick={() => setOpen(true)}>
        Open resource settings
      </button>
      <output aria-label="Saved limits">{saved}</output>
      {open ? (
        <ComputerResourceSettings
          botId="demo-bot"
          team={!location.search.includes("private")}
          onClose={() => setOpen(false)}
          onChanged={async () => setSaved(JSON.stringify(limits))}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
