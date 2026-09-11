import type { RawData, WebSocket } from "ws";

type Client = { workspaceId: string; socket: WebSocket; authorize: () => Promise<void> };

export class RealtimeHub {
  private clients = new Set<Client>();

  add(workspaceId: string, socket: WebSocket, authorize: () => Promise<void>) {
    const client = { workspaceId, socket, authorize };
    this.clients.add(client);
    const timer = setInterval(() => { void authorize().catch(() => socket.close(1008, "Sign in again")); }, 15000);
    timer.unref();
    socket.on("close", () => { clearInterval(timer); this.clients.delete(client); });
    socket.on("message", (raw: RawData) => {
      if (raw.toString() === "ping") socket.send("pong");
    });
  }

  emitWorkspace(workspaceId: string, event: unknown) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.workspaceId === workspaceId && client.socket.readyState === client.socket.OPEN) {
        void client.authorize().then(() => {
          if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
        }).catch(() => client.socket.close(1008, "Sign in again"));
      }
    }
  }
}

export const realtimeHub = new RealtimeHub();
