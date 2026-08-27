import type { RawData, WebSocket } from "ws";

type Client = { workspaceId: string; socket: WebSocket };

export class RealtimeHub {
  private clients = new Set<Client>();

  add(workspaceId: string, socket: WebSocket) {
    const client = { workspaceId, socket };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    socket.on("message", (raw: RawData) => {
      if (raw.toString() === "ping") socket.send("pong");
    });
  }

  emitWorkspace(workspaceId: string, event: unknown) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.workspaceId === workspaceId && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }
}

export const realtimeHub = new RealtimeHub();
