/**
 * Tells the web client that the page it loaded is served by the dsh host
 * itself, so client features that otherwise assume a loopback page apply on
 * every address the control plane answers on.
 *
 * dsh's web client decides where settings live from the page's hostname: a
 * loopback page (`localhost`, `127.0.0.1`) reads and writes the host's
 * settings store, while any other hostname — an Ingress name, a LAN address —
 * keeps settings in browser memory. That fallback breaks the model-provider
 * page outright ("Loading the provider directory failed: settings are
 * unavailable in this browser"), which is why editing model credentials has
 * needed `kubectl port-forward` even on deployments with a real front door.
 *
 * The client's own escape hatch is the `__DSH_TRANSPORT__` global: the
 * connection plugin reads it before any module batch runs and derives
 * `isLoopback` as `transport?.ownsHost === true || …` (dsh-client-connection
 * uses the same global for its Electron embedding, where the desktop app
 * owns the host). The transport's `fetch`/`openStream` hooks stay unset, so
 * the wire is unchanged — the browser keeps using plain `fetch` against the
 * same origin. Downstream, the gateway's `remote.$host` getter copies
 * `connection.isLoopback`, and the settings packages branch on it.
 *
 * The assertion is true by construction here: this distribution serves the
 * UI from the same process that holds the settings, so the page's origin and
 * the host are one machine. It grants no access — `/api` keeps the same
 * Host/Origin fence and the same authentication as before; what changes is
 * only where settings persist.
 *
 * @module @zhming0/dsh-yawn/owns-host
 */

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "ui-owns-host";

export function apply(ctx: Context): void {
  // Wait for the service instead of injecting it, so a headless profile
  // still boots with this row mounted (same reason as workspace-files).
  ctx.inject(["webServer"], (scope) => {
    scope.effect(
      () =>
        scope.on("webserver/index-inject", (table) => {
          table.push({
            kind: "global",
            name: "__DSH_TRANSPORT__",
            value: { ownsHost: true },
          });
        }),
      `${name}: index injection`,
    );
  });
}
