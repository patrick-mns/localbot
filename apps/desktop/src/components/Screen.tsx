import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { Computer } from "../types";

/**
 * A device's screen over VNC (the Linux container): noVNC as a library,
 * connected straight to the container's websocket. Watching by default; the
 * user takes control explicitly, as in the macOS app.
 */
export function Screen({ computer, controlling }: { computer: Computer; controlling: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const display = computer.display as { kind: string; url?: string; password?: string };

  useEffect(() => {
    if (display.kind !== "vnc" || !display.url || !box.current || computer.state !== "running") return;
    const web = new URL(display.url);
    const ws = `ws://${web.host}/websockify`;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (stopped || !box.current) return;
      box.current.innerHTML = "";
      const r = new RFB(box.current, ws, { credentials: { password: display.password }, shared: true });
      r.scaleViewport = true;
      r.background = "transparent";
      r.viewOnly = !controlling;
      r.addEventListener("connect", () => setStatus(""));
      // The device may still be booting, or was restarted: keep trying.
      r.addEventListener("disconnect", () => {
        setStatus("Reconnecting…");
        if (!stopped) retry = setTimeout(connect, 2500);
      });
      rfb.current = r;
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [computer.id, computer.state, display.url, display.password]);

  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = !controlling;
    if (controlling) rfb.current?.focus();
  }, [controlling]);

  if (computer.state !== "running") {
    return <div className="screen-empty">Device is {computer.state === "creating" ? "being created…" : "off"}</div>;
  }
  if (display.kind !== "vnc") return <div className="screen-empty">This device’s screen isn’t available here yet</div>;
  return (
    <div className={`screen ${controlling ? "controlling" : ""}`}>
      <div ref={box} className="screen-canvas" />
      {status && <div className="screen-status">{status}</div>}
    </div>
  );
}
